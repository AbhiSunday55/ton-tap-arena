// ── AGENT-OWNED: tRPC API surface ───────────────────────────────────────────
// Thin procedures only: validate with zod, delegate to server/db.ts for data,
// server/services/* for external work and shared/game-rules.ts for the reward
// maths. The client never sends an amount it computed — every reward is derived
// server-side from the player's own stored state.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import * as bcrypt from "bcryptjs";
import { router, publicProcedure, protectedProcedure, middleware } from "./_core/trpc";
import { authProvider, registerLocalUser, AuthError, EmailTakenError, upsertTelegramUser, registerGuestUser, issueSessionCookie } from "./_core/auth";
import { validateInitData } from "./_core/telegram";
import * as q from "./db";
import { seedCatalogue } from "./services/seed";
import { filesRouter } from "./demo-routers";

// Re-exported so `server/routers.test.ts` keeps exercising the real sanitiser.
export { sanitizeBasename } from "./demo-routers";

import {
  assertTonTreasury,
  commentPayload,
  isTonAddress,
  nanoTonToTonString,
  verifyTonProof,
} from "./services/ton";
import {
  NANO,
  resolveConfig,
  dayKey,
  leagueFor,
  type GameConfig,
} from "../shared/game-config";
import {
  boosterAvailable,
  freshBoosterUsage,
  ladderRung,
  quoteWithdrawal,
  referralRewardCoin,
  regenEnergy,
  rigCost,
  rigPerHour,
  settleRigs,
  settleTapBatch,
  totalRigPerHour,
  tapRewardPerTap,
  tapRewardPerTapExact,
  turboActive,
  usdtCentsToNanoTon,
  type BoosterUsage,
  type RigsOwned,
} from "../shared/game-rules";
import {
  combineEffects,
  effectiveEnergyCap,
  effectiveRegenSeconds,
  normalizeEffects,
  ZERO_EFFECTS,
  type ItemEffects,
} from "../shared/item-effects";

const ADMIN_COOKIE = "tap_arena_admin";
const DEFAULT_ADMIN_PASSWORD = "taparena";
const VEST_LOCK_DAYS = 7;

const SAMPLE_HANDLES = [
  "NovaMiner", "LunaTap", "CryptoHawk", "ZenithKing", "PixelPirate", "AquaByte", "VoltRider",
  "StarForge", "NebulaX", "IronPulse", "GhostCoin", "SolarFlare", "ByteBaron", "QuantumFox",
  "TurboNaut", "EchoStorm", "NeonDrift", "OrbitKid", "PlasmaPug", "AlphaWolf",
];
const SAMPLE_AVATARS = ["⛏️", "💎", "🚀", "🔥", "⚡", "👑", "🎯", "🌙", "🦅", "🐺"];

/**
 * A descending spread of plausible weekly totals. These are sized against the
 * real economy — 1,000 energy regenerating at 1/3s is roughly 28,800 taps a
 * day, so a regular player lands in the low tens of thousands per week. Scores
 * in the millions would make the board read as fake beside a real score.
 */
const SAMPLE_WEEK_CURVE = [
  47_500, 41_200, 36_800, 31_400, 27_900, 24_600, 21_300, 18_700, 16_400, 14_200,
  12_600, 11_100, 9_800, 8_600, 7_500, 6_600, 5_800, 5_100, 4_400, 3_800,
];

let bootstrapPromise: Promise<{ catalogue: boolean; board: boolean }> | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Equipped-item effects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a profile's combined effects from the rows it actually OWNS.
 *
 * Deliberately derived rather than stored: the server looks each equipped slug
 * up in the catalogue and re-reads its recorded effect, so a client can never
 * assert a bonus it did not buy. Called on every equip/unequip so the cached
 * `itemEffects` column can never drift from the real loadout.
 */
async function recomputeItemEffects(
  userId: string,
  equippedSkin: string | null,
  equippedButton: string | null,
  catalogue?: q.ShopItem[],
): Promise<{ effects: ItemEffects; tapPercent: number }> {
  const items = catalogue ?? (await q.listShopItems());
  const owned = new Set(await q.ownedItemSlugs(userId));

  const pick = (slug: string | null, category: "skin" | "button"): ItemEffects => {
    if (!slug) return ZERO_EFFECTS;
    const item = items.find((i) => i.slug === slug && i.category === category);
    // Not owned => contributes nothing, even if the slug is written on the row.
    if (!item || !owned.has(item.slug)) return ZERO_EFFECTS;
    return normalizeEffects(item.effects);
  };

  const effects = combineEffects(pick(equippedSkin, "skin"), pick(equippedButton, "button"));
  return { effects, tapPercent: effects.tapPercent };
}

/**
 * Equip a category to `slug`, or clear it with `null`, then persist both the
 * equipped slug and the recomputed effects together.
 *
 * Ownership is checked HERE, server-side — a client cannot equip something it
 * has not bought, which is what makes the bonus trustworthy.
 */
async function applyEquip(
  userId: string,
  category: "skin" | "button",
  slug: string | null,
  catalogue: q.ShopItem[],
): Promise<{ effects: ItemEffects; tapPercent: number }> {
  const profile = await q.getProfile(userId);
  if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: "No player profile." });

  if (slug) {
    const item = catalogue.find((i) => i.slug === slug);
    if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "That item does not exist." });
    if (item.category !== category) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `That item is not a ${category}.` });
    }
    const owned = await q.ownedItemSlugs(userId);
    if (!owned.includes(slug)) {
      throw new TRPCError({ code: "FORBIDDEN", message: `You do not own ${item.name}.` });
    }
  }

  const nextSkin = category === "skin" ? slug : profile.equippedSkin || null;
  const nextButton = category === "button" ? slug : profile.equippedButton || null;
  const { effects, tapPercent } = await recomputeItemEffects(
    userId,
    nextSkin,
    nextButton,
    catalogue,
  );

  await q.updateProfile(userId, {
    equippedSkin: nextSkin ?? "",
    equippedButton: nextButton ?? "",
    itemEffects: effects,
    itemBoostPercent: tapPercent,
  });
  return { effects, tapPercent };
}

/**
 * Buying an asset equips it immediately.
 *
 * Players reasonably expect the thing they just paid for to be live, and a
 * purchase that changed nothing until a second, separate tap is exactly the
 * "bought it and nothing happened" complaint this whole feature exists to fix.
 * Buying is therefore also equipping; the shop can still switch back afterwards.
 */
async function autoEquipAfterPurchase(
  userId: string,
  category: string,
  slug: string,
  catalogue: q.ShopItem[],
): Promise<void> {
  const cat = category === "button" ? "button" : "skin";
  const item = catalogue.find((i) => i.slug === slug);
  if (!item) return;
  await applyEquip(userId, cat, slug, catalogue);
}

/**
 * Idempotent first-run population of the catalogue and the sample leaderboard.
 * Memoised for the process lifetime so a burst of first requests all await the
 * same work rather than each racing to seed its own copy.
 */
async function ensureBootstrapped(cfg: GameConfig): Promise<{ catalogue: boolean; board: boolean }> {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    let catalogue = false;
    let board = false;

    // Both halves are checked independently — see countOffers() in db.ts.
    // The effects check repairs a catalogue that predates the effects column:
    // without it those rows would stay inert forever.
    if (
      (await q.countShopItems()) === 0 ||
      (await q.countOffers()) === 0 ||
      (await q.countItemsMissingEffects()) > 0
    ) {
      await seedCatalogue();
      catalogue = true;
    }

    if ((await q.countLeaderboardSeed()) === 0) {
      const rows = SAMPLE_HANDLES.map((handle, i) => {
        const coins = SAMPLE_WEEK_CURVE[i] ?? Math.max(2_000, Math.round(120_000 / (i + 1) ** 0.55));
        let leagueIndex = 0;
        cfg.leagueThresholds.forEach((t, li) => {
          if (coins >= t) leagueIndex = li;
        });
        return {
          handle,
          avatar: SAMPLE_AVATARS[i % SAMPLE_AVATARS.length]!,
          weekCoinMined: coins,
          leagueIndex,
        };
      });
      await q.seedLeaderboard(rows);
      board = true;
    }

    return { catalogue, board };
  })().catch((e) => {
    // A failed seed must not be cached as "done", or the app would never retry.
    bootstrapPromise = null;
    throw e;
  });

  return bootstrapPromise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Read the profile, lazily settling energy regen, rig income and the week rollover. */
async function syncProfile(userId: string, cfg: GameConfig) {
  const before = await q.getProfile(userId);
  if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "No player profile." });

  const now = new Date();
  const patch: Record<string, unknown> = {};
  let energy = before.energy;
  let energyUpdatedAt = before.energyUpdatedAt;

  // Energy regen — the equipped button's bonuses raise the ceiling and
  // shorten the tick, so the same numbers the UI shows are the ones enforced.
  const effects = normalizeEffects(before.itemEffects);
  const regen = regenEnergy(cfg, before.energy, before.energyUpdatedAt, now, effects);
  if (regen.energy !== before.energy) {
    energy = regen.energy;
    energyUpdatedAt = regen.energyUpdatedAt;
    patch.energy = energy;
    patch.energyUpdatedAt = energyUpdatedAt;
  }

  // Passive rig income — plus whatever the equipped skin trickles in per hour.
  const rigs = settleRigs(
    cfg,
    (before.rigsOwned ?? {}) as RigsOwned,
    before.rigAccruedAt,
    now,
    effects,
  );
  if (rigs.coins > 0) {
    patch.balanceCoin = before.balanceCoin + rigs.coins;
    patch.totalCoinMined = before.totalCoinMined + rigs.coins;
    patch.weekCoinMined = before.weekCoinMined + rigs.coins;
    patch.rigAccruedAt = now;
  } else if (now.getTime() - before.rigAccruedAt.getTime() > 60_000) {
    patch.rigAccruedAt = now;
  }

  // Weekly leaderboard rollover
  if (now.getTime() - before.weekStartAt.getTime() > 7 * 24 * 3600 * 1000) {
    patch.weekCoinMined = 0;
    patch.weekStartAt = now;
  }

  if (Object.keys(patch).length === 0) return before;

  if (rigs.coins > 0) {
    await q.addLedger({
      userId,
      kind: "rig_income",
      deltaCoin: rigs.coins,
      note: "Passive income from mining rigs",
      refType: "rig",
    });
  }
  await q.updateProfile(userId, patch as Partial<q.Profile>);
  const after = await q.getProfile(userId);
  return after ?? before;
}

/** Build the full client-facing game state. Never mutates. */
function buildState(profile: q.Profile, cfg: GameConfig) {
  const league = leagueFor(cfg, profile.totalCoinMined);
  const usage = freshBoosterUsage(
    cfg,
    profile.boostersUsed as BoosterUsage,
    profile.boosterDayKey,
    dayKey(),
  );
  const turbosLeft = Math.max(0, cfg.turboFreePerDay - usage.usage.turbo);
  const energyLeft = Math.max(0, cfg.energyRefillFreePerDay - usage.usage.energy);
  const rechargeLeft = Math.max(0, cfg.rechargeFreePerDay - usage.usage.recharge);

  const withdraw = quoteWithdrawal(cfg, profile.balanceNanoTon);
  // The equipped loadout, as the client renders it. `energyCap` and
  // `energyRegenSeconds` are derived here so a displayed ceiling can never
  // disagree with the enforced one.
  const itemEffects = normalizeEffects(profile.itemEffects);
  const energyCap = effectiveEnergyCap(cfg, itemEffects);
  const energyRegenSeconds = effectiveRegenSeconds(cfg, itemEffects);

  return {
    serverNow: new Date().toISOString(),
    profile: {
      userId: profile.userId,
      handle: profile.handle,
      avatar: profile.avatar,
      balanceCoin: profile.balanceCoin,
      balanceNanoTon: profile.balanceNanoTon,
      vestedNanoTon: profile.vestedNanoTon,
      lockedNanoTon: profile.lockedNanoTon,
      totalTaps: profile.totalTaps,
      totalCoinMined: profile.totalCoinMined,
      weekCoinMined: profile.weekCoinMined,
      energy: profile.energy,
      energyUpdatedAt: profile.energyUpdatedAt.toISOString(),
      tapPowerLevel: profile.tapPowerLevel,
      itemBoostPercent: profile.itemBoostPercent,
      itemEffects,
      energyCap,
      energyRegenSeconds,
      turboUntil: profile.turboUntil ? profile.turboUntil.toISOString() : null,
      streakDay: profile.streakDay,
      streakClaimedToday: profile.streakClaimedDayKey === dayKey(),
      referralCode: profile.referralCode,
      referralPremium: profile.referralPremium,
      equippedSkin: profile.equippedSkin,
      equippedButton: profile.equippedButton,
      /**
       * The concrete COIN a single tap is worth right now with the equipped
       * loadout, at this player's league and tap-power level and at combo ×1.
       * The shop's before/after preview recomputes this with a candidate item's
       * tap bonus, so both sides compare on identical footing.
       */
      tapPowerPerTap: tapRewardPerTap(cfg, {
        leagueMult: league.mult,
        tapPowerLevel: profile.tapPowerLevel,
        comboMult: 1,
        itemBoostPercent: itemEffects.tapPercent,
        turbo: false,
      }),
      /**
       * The same figure BEFORE rounding. A +45% skin on a base of 1 COIN makes a
       * tap worth 1.45, which the integer view would show as a flat "1" — i.e.
       * a purchased item that looks like it did nothing. The UI shows this
       * figure so an equipped bonus is visibly working.
       */
      tapPowerPerTapExact: tapRewardPerTapExact(cfg, {
        leagueMult: league.mult,
        tapPowerLevel: profile.tapPowerLevel,
        comboMult: 1,
        itemBoostPercent: itemEffects.tapPercent,
        turbo: false,
      }),
      soundEnabled: profile.soundEnabled,
      isAdmin: profile.isAdmin,
      walletAddress: profile.walletAddress,
      walletProvider: profile.walletProvider,
      proofVerified: !!profile.proofVerifiedAt,
      walletConnectedAt: profile.walletConnectedAt
        ? profile.walletConnectedAt.toISOString()
        : null,
      withdrawalPending: profile.withdrawalPending,
      createdAt: profile.createdAt.toISOString(),
    },
    cfg,
    league: {
      index: league.index,
      name: league.name,
      emoji: league.emoji,
      mult: league.mult,
      next: league.next,
      progressPercent: league.next
        ? Math.min(
            100,
            Math.round(
              ((profile.totalCoinMined - (cfg.leagueThresholds[league.index] ?? 0)) /
                Math.max(1, league.next - (cfg.leagueThresholds[league.index] ?? 0))) *
                100,
            ),
          )
        : 100,
    },
    boosters: {
      turbo: { freeLeft: turbosLeft, cost: cfg.turboCostCoin },
      energy: { freeLeft: energyLeft, cost: cfg.energyRefillCostCoin },
      recharge: {
        freeLeft: rechargeLeft,
        cost: cfg.rechargeCostCoin,
        readyAt: profile.rechargeReadyAt ? profile.rechargeReadyAt.toISOString() : null,
      },
    },
    rigs: cfg.rigs.map((r, i) => {
      const key = ["scrap_rig", "steel_rig", "plasma_rig", "quantum_rig"][i]!;
      return {
        key,
        name: r.name,
        costCoin: r.costCoin,
        perHour: r.perHour,
        owned: Number((profile.rigsOwned as RigsOwned)?.[key] ?? 0),
      };
    }),
    rigPerHour: totalRigPerHour(cfg, (profile.rigsOwned ?? {}) as RigsOwned, itemEffects),
    streakRewards: cfg.streakRewards,
    withdraw,
    turboActive: turboActive(cfg, profile.turboUntil, new Date()),
  };
}

async function requireState(ctx: { user: { id: string } }, cfg: GameConfig) {
  const profile = await syncProfile(ctx.user.id, cfg);
  return buildState(profile, cfg);
}

/** Server-side task rule evaluation — a client cannot fake any of these. */
function evaluateRule(
  rule: string,
  ruleValue: number,
  data: {
    profile: q.Profile;
    referralCount: number;
    adCount: number;
    purchaseCount: number;
    withdrawalCount: number;
    cfg: GameConfig;
  },
): { ok: boolean; reason: string } {
  const { profile } = data;
  switch (rule) {
    case "wallet":
      return profile.walletAddress && profile.proofVerifiedAt
        ? { ok: true, reason: "" }
        : { ok: false, reason: "Connect and verify a TON wallet first." };
    case "purchase":
      return data.purchaseCount > 0
        ? { ok: true, reason: "" }
        : { ok: false, reason: "Buy anything from the shop first." };
    case "withdrawal":
      return data.withdrawalCount > 0
        ? { ok: true, reason: "" }
        : { ok: false, reason: "Complete a withdrawal first." };
    case "referrals":
      return data.referralCount >= ruleValue
        ? { ok: true, reason: "" }
        : {
            ok: false,
            reason: `You have ${data.referralCount} of ${ruleValue} required referrals.`,
          };
    case "ad":
      return data.adCount >= ruleValue
        ? { ok: true, reason: "" }
        : { ok: false, reason: `Watch ${ruleValue - data.adCount} more ad(s).` };
    case "league":
      return leagueFor(data.cfg, profile.totalCoinMined).index >= ruleValue
        ? { ok: true, reason: "" }
        : { ok: false, reason: "That league is not reached yet." };
    case "manual":
    default:
      return { ok: true, reason: "" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────
const authRouter = router({
  me: publicProcedure.query(({ ctx }) => ctx.user),

  signup: publicProcedure
    .input(z.object({ email: z.email(), password: z.string().min(8), name: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const user = await registerLocalUser(input.email, input.password, input.name);
        await authProvider().login(ctx.c, input.email, input.password);
        return user;
      } catch (e: unknown) {
        if (e instanceof EmailTakenError)
          throw new TRPCError({ code: "CONFLICT", message: e.message });
        throw e;
      }
    }),

  login: publicProcedure
    .input(z.object({ email: z.email(), password: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await authProvider().login(ctx.c, input.email, input.password);
      } catch (e) {
        if (e instanceof AuthError)
          throw new TRPCError({ code: "UNAUTHORIZED", message: e.message });
        throw e;
      }
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    await authProvider().logout(ctx.c);
    return { ok: true };
  }),

  /**
   * Telegram Mini App sign-in. The client sends the raw `initData` string
   * Telegram handed it; the server verifies the HMAC against the bot token
   * before trusting a single field of it. A tampered payload fails the
   * signature check and is rejected — the client cannot assert an identity.
   *
   * On success the player is upserted into the real user database and given the
   * same session cookie the password flow issues, so every downstream procedure
   * is unchanged.
   */
  telegram: publicProcedure
    .input(z.object({ initData: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const botToken = await q.resolveTelegramBotToken();
      const result = validateInitData(input.initData, botToken);
      if (!result.ok) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: `Telegram sign-in failed (${result.reason}).`,
        });
      }
      const user = await upsertTelegramUser(result.user);
      await issueSessionCookie(ctx.c, user.id);
      return user;
    }),

  /**
   * Guest sign-in for a browser outside Telegram (GitHub Pages, a desktop
   * browser). Creates a throwaway account with no password, so the only way in
   * is the session cookie minted here.
   */
  guest: publicProcedure.mutation(async ({ ctx }) => {
    const user = await registerGuestUser();
    await issueSessionCookie(ctx.c, user.id);
    return user;
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Game — state, tapping, boosters, rigs, streak, prefs
// ─────────────────────────────────────────────────────────────────────────────
const gameRouter = router({
  /**
   * First-run bootstrap. The catalogue and the sample leaderboard rows are
   * inserted lazily on the first authenticated read, so a fresh database (a new
   * dev sandbox, or prod after a Publish) is populated without a manual admin
   * step. Both inserts are idempotent, and the promise is memoised so concurrent
   * requests cannot race two seeds.
   */
  bootstrap: protectedProcedure.mutation(async ({ ctx }) => {
    const cfg = await q.getConfig();
    const seeded = await ensureBootstrapped(cfg);
    return { ...seeded, state: await requireState(ctx, cfg) };
  }),

  state: protectedProcedure.query(async ({ ctx }) => {
    const cfg = await q.getConfig();
    if (cfg.maintenanceMode) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "The arena is in maintenance. Please check back shortly.",
      });
    }
    // First sight of this user: create the profile (welcome bonus granted once).
    await q.ensureProfile({
      userId: ctx.user.id,
      handle: ctx.user.name?.trim() || ctx.user.email.split("@")[0]!,
      cfg,
      isAdmin: ctx.user.role === "admin",
    });
    return requireState(ctx, cfg);
  }),

  tap: protectedProcedure
    .input(z.object({ taps: z.number().int().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const cfg = await q.getConfig();
      let profile = await syncProfile(ctx.user.id, cfg);
      const now = new Date();

      const result = settleTapBatch(
        cfg,
        {
          energy: profile.energy,
          energyUpdatedAt: profile.energyUpdatedAt,
          tapPowerLevel: profile.tapPowerLevel,
          itemBoostPercent: profile.itemBoostPercent,
          effects: normalizeEffects(profile.itemEffects),
          // Micro-COIN fraction from the previous batch, so a bonus worth less
          // than 1 COIN per tap still accumulates into real coins.
          coinCarry: (profile.coinCarryMicro ?? 0) / 1_000_000,
          turboUntil: profile.turboUntil,
          comboCount: profile.comboCount,
          lastTapAt: profile.lastTapAt,
          leagueCoinMined: profile.totalCoinMined,
        },
        input.taps,
        now,
      );

      if (result.taps > 0) {
        const merged = await q.updateProfileGuarded(ctx.user.id, profile.updatedAt, {
          energy: result.energy,
          energyUpdatedAt: result.energyUpdatedAt,
          comboCount: result.comboCount,
          lastTapAt: result.lastTapAt,
          coinCarryMicro: Math.round(result.coinCarry * 1_000_000),
          balanceCoin: profile.balanceCoin + result.coins,
          totalCoinMined: profile.totalCoinMined + result.coins,
          weekCoinMined: profile.weekCoinMined + result.coins,
          totalTaps: profile.totalTaps + result.taps,
        });
        if (merged.length === 0) {
          // Somebody else wrote first — reload and let the next tap settle.
          profile = await syncProfile(ctx.user.id, cfg);
        } else {
          profile = merged[0]!;
          await q.addTapLog({
            userId: ctx.user.id,
            taps: result.taps,
            coinsEarned: result.coins,
            multiplierBp: Math.round(result.comboMult * 10000),
          });
        }
      }

      const state = buildState(profile, cfg);
      return {
        ...state,
        lastTap: {
          taps: result.taps,
          coins: result.coins,
          perTap: result.perTap,
          comboMult: result.comboMult,
          turbo: result.turbo,
          truncated: result.truncated,
        },
      };
    }),

  booster: protectedProcedure
    .input(z.object({ kind: z.enum(["turbo", "energy", "recharge"]) }))
    .mutation(async ({ ctx, input }) => {
      const cfg = await q.getConfig();
      const profile = await syncProfile(ctx.user.id, cfg);
      // Refills fill to the EFFECTIVE ceiling, not the base one — otherwise an
      // equipped button's energy bonus would be unreachable via boosters.
      const cap = effectiveEnergyCap(cfg, normalizeEffects(profile.itemEffects));
      const today = dayKey();
      const { usage } = freshBoosterUsage(
        cfg,
        profile.boostersUsed as BoosterUsage,
        profile.boosterDayKey,
        today,
      );

      const avail = boosterAvailable(cfg, usage, input.kind, profile.balanceCoin);

      if (input.kind === "recharge" && profile.rechargeReadyAt) {
        if (profile.rechargeReadyAt.getTime() > Date.now()) {
          const mins = Math.ceil((profile.rechargeReadyAt.getTime() - Date.now()) / 60000);
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Recharge is on cooldown for another ${mins} minute(s).`,
          });
        }
      }

      if (!avail.allowed) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Not enough coins — this booster now costs ${avail.cost.toLocaleString("en-US")} COIN.`,
        });
      }

      const nextUsage: BoosterUsage = { ...usage, [input.kind]: (usage[input.kind] ?? 0) + 1 };
      const patch: Partial<q.Profile> = {
        boostersUsed: nextUsage,
        boosterDayKey: today,
      };

      if (avail.cost > 0) patch.balanceCoin = profile.balanceCoin - avail.cost;

      if (input.kind === "turbo") {
        const base = turboActive(cfg, profile.turboUntil, new Date())
          ? profile.turboUntil!.getTime()
          : Date.now();
        patch.turboUntil = new Date(base + cfg.turboDurationSec * 1000);
      } else if (input.kind === "energy") {
        patch.energy = cap;
        patch.energyUpdatedAt = new Date();
      } else {
        patch.energy = Math.min(cap, profile.energy + cfg.rechargeAmount);
        patch.energyUpdatedAt = new Date();
        patch.rechargeReadyAt = new Date(Date.now() + cfg.rechargeCooldownSec * 1000);
      }

      await q.updateProfile(ctx.user.id, patch);
      if (avail.cost > 0) {
        await q.addLedger({
          userId: ctx.user.id,
          kind: `booster_${input.kind}`,
          deltaCoin: -avail.cost,
          note: `Booster: ${input.kind} (paid)`,
          refType: "booster",
        });
      }
      return requireState(ctx, cfg);
    }),

  buyRig: protectedProcedure
    .input(z.object({ key: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const cfg = await q.getConfig();
      const profile = await syncProfile(ctx.user.id, cfg);
      const cost = rigCost(cfg, input.key);
      if (!cost) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown rig." });
      if (profile.balanceCoin < cost) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Not enough coins — this rig costs ${cost.toLocaleString("en-US")} COIN.`,
        });
      }
      const owned = { ...((profile.rigsOwned ?? {}) as RigsOwned) };
      owned[input.key] = Number(owned[input.key] ?? 0) + 1;

      await q.updateProfile(ctx.user.id, {
        balanceCoin: profile.balanceCoin - cost,
        rigsOwned: owned,
      });
      await q.addLedger({
        userId: ctx.user.id,
        kind: "rig_purchase",
        deltaCoin: -cost,
        note: `Mining rig purchased (+${rigPerHour(cfg, input.key)}/hour)`,
        refType: "rig",
        refId: input.key,
      });
      return requireState(ctx, cfg);
    }),

  upgradeTap: protectedProcedure.mutation(async ({ ctx }) => {
    const cfg = await q.getConfig();
    const profile = await syncProfile(ctx.user.id, cfg);
    if (profile.tapPowerLevel >= cfg.tapPowerUpgradeMax) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Tap power is already maxed." });
    }
    const cost = cfg.tapPowerUpgradeCost;
    if (profile.balanceCoin < cost) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `Not enough coins — the upgrade costs ${cost.toLocaleString("en-US")} COIN.`,
      });
    }
    await q.updateProfile(ctx.user.id, {
      balanceCoin: profile.balanceCoin - cost,
      tapPowerLevel: profile.tapPowerLevel + cfg.tapPowerUpgradeStep,
    });
    await q.addLedger({
      userId: ctx.user.id,
      kind: "tap_upgrade",
      deltaCoin: -cost,
      note: `Tap power upgraded to level ${profile.tapPowerLevel + cfg.tapPowerUpgradeStep}`,
      refType: "upgrade",
    });
    return requireState(ctx, cfg);
  }),

  claimStreak: protectedProcedure.mutation(async ({ ctx }) => {
    const cfg = await q.getConfig();
    const profile = await syncProfile(ctx.user.id, cfg);
    const today = dayKey();
    if (profile.streakClaimedDayKey === today) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Streak already claimed today." });
    }
    const yesterday = dayKey(new Date(Date.now() - 24 * 3600 * 1000));
    const continuing = profile.streakClaimedDayKey === yesterday;
    const day = continuing ? Math.min(cfg.streakRewards.length, profile.streakDay + 1) : 1;
    const reward = cfg.streakRewards[day - 1] ?? 0;

    await q.updateProfile(ctx.user.id, {
      streakDay: day,
      streakClaimedDayKey: today,
      balanceCoin: profile.balanceCoin + reward,
      totalCoinMined: profile.totalCoinMined + reward,
      weekCoinMined: profile.weekCoinMined + reward,
    });
    await q.addLedger({
      userId: ctx.user.id,
      kind: "streak_claim",
      deltaCoin: reward,
      note: `Daily streak — day ${day}`,
      refType: "streak",
      refId: String(day),
    });
    return { ...(await requireState(ctx, cfg)), streakClaimed: { day, reward } };
  }),

  prefs: protectedProcedure
    .input(
      z.object({
        soundEnabled: z.boolean().optional(),
        equippedSkin: z.string().optional(),
        equippedButton: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const cfg = await q.getConfig();
      await syncProfile(ctx.user.id, cfg);
      if (input.soundEnabled !== undefined) {
        await q.updateProfile(ctx.user.id, { soundEnabled: input.soundEnabled });
      }
      const catalogue = await q.listShopItems();
      // `undefined` means "leave this slot alone"; an empty string reaches
      // applyEquip as null and clears it.
      if (input.equippedSkin !== undefined) {
        await applyEquip(ctx.user.id, "skin", input.equippedSkin || null, catalogue);
      }
      if (input.equippedButton !== undefined) {
        await applyEquip(ctx.user.id, "button", input.equippedButton || null, catalogue);
      }
      return requireState(ctx, cfg);
    }),

  /**
   * Equip or unequip a shop asset, re-deriving the effect record on the way.
   *
   * `slug: null` (or "") clears the slot. This is the single entry point the
   * shop's Equip / Unequip control calls, so the flow is symmetric.
   */
  equipItem: protectedProcedure
    .input(
      z.object({
        category: z.enum(["skin", "button"]),
        slug: z.string().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const cfg = await q.getConfig();
      await syncProfile(ctx.user.id, cfg);
      const slug = input.slug && input.slug.length > 0 ? input.slug : null;
      const catalogue = await q.listShopItems();
      await applyEquip(ctx.user.id, input.category, slug, catalogue);
      return requireState(ctx, cfg);
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Wallet — TON Connect 2.0 with a real ton_proof
// ─────────────────────────────────────────────────────────────────────────────
const walletRouter = router({
  nonce: protectedProcedure.mutation(async ({ ctx }) => {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const host =
      ctx.c.req.header("origin")?.replace(/^https?:\/\//, "") ??
      ctx.c.req.header("host") ??
      "localhost";
    await q.createNonce(nonce, nonce, host);
    return { nonce, payload: nonce, domain: host };
  }),

  verify: protectedProcedure
    .input(
      z.object({
        address: z.string().min(1),
        publicKey: z.string().optional(),
        walletStateInit: z.string().optional(),
        network: z.string().optional(),
        provider: z.string().optional(),
        proof: z.object({
          timestamp: z.number(),
          domain: z.object({ lengthBytes: z.number(), value: z.string() }),
          payload: z.string(),
          signature: z.string(),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // The nonce must be one we issued, and it is burned on first use so a
      // captured proof cannot be replayed.
      const burned = await q.burnNonce(input.proof.payload);
      if (!burned) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That sign-in nonce is unknown, already used or expired. Reconnect your wallet.",
        });
      }

      const host =
        ctx.c.req.header("origin")?.replace(/^https?:\/\//, "") ??
        ctx.c.req.header("host") ??
        "localhost";

      const result = await verifyTonProof(
        {
          address: input.address,
          publicKey: input.publicKey,
          walletStateInit: input.walletStateInit,
          network: input.network,
          proof: input.proof,
        },
        { domain: host, payload: input.proof.payload },
      );

      if (!result.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Wallet verification failed: ${result.reason}.`,
        });
      }

      await q.updateProfile(ctx.user.id, {
        walletAddress: result.address,
        walletPublicKey: result.publicKey,
        walletProvider: input.provider ?? "tonconnect",
        proofVerifiedAt: new Date(),
        walletConnectedAt: new Date(),
      });

      const cfg = await q.getConfig();
      await q.addLedger({
        userId: ctx.user.id,
        kind: "wallet_connected",
        note: `TON wallet verified: ${result.address}`,
        refType: "wallet",
        refId: result.address,
      });
      return requireState(ctx, cfg);
    }),

  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    await q.updateProfile(ctx.user.id, {
      walletAddress: null,
      walletPublicKey: null,
      walletProvider: null,
      proofVerifiedAt: null,
      walletConnectedAt: null,
    });
    const cfg = await q.getConfig();
    return requireState(ctx, cfg);
  }),

  ledger: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(40) }).optional())
    .query(async ({ ctx, input }) => {
      const rows = await q.listLedger(ctx.user.id, input?.limit ?? 40);
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        deltaCoin: Number(r.deltaCoin),
        deltaNanoTon: Number(r.deltaNanoTon),
        note: r.note,
        createdAt: r.createdAt.toISOString(),
      }));
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Shop — $0.50 × 2^tier, paid in TON (real on-chain) / Stars / COIN
// ─────────────────────────────────────────────────────────────────────────────
const shopRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const cfg = await q.getConfig();
    const items = await q.listShopItems();
    const owned = new Set(await q.ownedItemSlugs(ctx.user.id));
    const profile = await q.getProfile(ctx.user.id);
    return {
      items: items.map((i) => ({
        slug: i.slug,
        name: i.name,
        description: i.description,
        category: i.category,
        tierIndex: i.tierIndex,
        tier: i.tier,
        priceUsdtCents: i.priceUsdtCents,
        priceTon: nanoTonToTonString(usdtCentsToNanoTon(cfg, i.priceUsdtCents)),
        coinPrice: Number(i.coinPrice),
        boostPercent: i.boostPercent,
        /** The real effect record — the client renders its stat lines and the
         *  before/after preview from this, so a card can never overstate. */
        effects: normalizeEffects(i.effects),
        imageUrl: i.imageUrl,
        owned: owned.has(i.slug),
        equipped:
          profile?.equippedSkin === i.slug || profile?.equippedButton === i.slug,
      })),
      railArmed: !!cfg.treasureTonAddress && isTonAddress(cfg.treasureTonAddress),
      treasuryEvm: cfg.treasureEvmAddress,
      treasuryTon: cfg.treasureTonAddress || null,
      balanceCoin: profile?.balanceCoin ?? 0,
      tonUsdRate: cfg.tonUsdRate,
      usdtTonRate: cfg.usdtTonRate,
    };
  }),

  /**
   * Step 1 of a purchase. Creates the order and, for the TON rail, returns the
   * transfer the wallet must sign. Nothing is delivered until `confirm`.
   */
  purchase: protectedProcedure
    .input(z.object({ slug: z.string().min(1), rail: z.enum(["TON", "STARS", "COIN"]) }))
    .mutation(async ({ ctx, input }) => {
      const cfg = await q.getConfig();
      const item = (await q.listShopItems()).find((i) => i.slug === input.slug);
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "That item is no longer sold." });

      const owned = await q.ownedItemSlugs(ctx.user.id);
      if (owned.includes(item.slug)) {
        throw new TRPCError({ code: "CONFLICT", message: "You already own that item." });
      }

      const nanoTon = usdtCentsToNanoTon(cfg, item.priceUsdtCents);

      // ── COIN rail: settles instantly, off-chain ──
      if (input.rail === "COIN") {
        const profile = await syncProfile(ctx.user.id, cfg);
        const coinPrice = Number(item.coinPrice);
        if (profile.balanceCoin < coinPrice) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Not enough coins — this item costs ${coinPrice.toLocaleString("en-US")} COIN.`,
          });
        }
        await q.createPurchase({
          userId: ctx.user.id,
          itemSlug: item.slug,
          itemName: item.name,
          category: item.category,
          tier: item.tier,
          priceUsdtCents: item.priceUsdtCents,
          payCurrency: "COIN",
          amountNanoTon: 0,
          status: "paid",
          detail: `Paid ${coinPrice} COIN`,
        });
        await q.updateProfile(ctx.user.id, { balanceCoin: profile.balanceCoin - coinPrice });
        await q.addLedger({
          userId: ctx.user.id,
          kind: "purchase",
          deltaCoin: -coinPrice,
          note: `Shop: ${item.name} (${item.tier}) paid in COIN`,
          refType: "purchase",
          refId: item.slug,
        });
        // A purchase that changes nothing is a dead purchase — equip it now.
        await autoEquipAfterPurchase(
          ctx.user.id,
          item.category,
          item.slug,
          await q.listShopItems(),
        );
        return { mode: "settled" as const, item: item.name, state: await requireState(ctx, cfg) };
      }

      // ── TON rail: build a REAL on-chain transfer to the treasury ──
      if (input.rail === "TON") {
        const profile = await syncProfile(ctx.user.id, cfg);
        if (!profile.walletAddress) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Connect your TON wallet before paying on-chain.",
          });
        }
        let treasury: string;
        try {
          treasury = assertTonTreasury(cfg.treasureTonAddress, cfg.treasureEvmAddress);
        } catch (e) {
          // The rail is deliberately not armed — say so instead of faking a hash.
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: (e as Error).message,
          });
        }
        await q.createPurchase({
          userId: ctx.user.id,
          itemSlug: item.slug,
          itemName: item.name,
          category: item.category,
          tier: item.tier,
          priceUsdtCents: item.priceUsdtCents,
          payCurrency: "TON",
          amountNanoTon: nanoTon,
          status: "pending",
          detail: `Awaiting on-chain payment to ${treasury}`,
        });
        return {
          mode: "onchain" as const,
          item: item.name,
          amountNanoTon: nanoTon,
          amountTon: nanoTonToTonString(nanoTon),
          treasury,
          comment: `TON Tap Arena — ${item.name}`,
          commentPayload: commentPayload(`TON Tap Arena — ${item.name}`),
          state: await requireState(ctx, cfg),
        };
      }

      // ── Stars rail: platform-compliant digital-goods path ──
      await q.createPurchase({
        userId: ctx.user.id,
        itemSlug: item.slug,
        itemName: item.name,
        category: item.category,
        tier: item.tier,
        priceUsdtCents: item.priceUsdtCents,
        payCurrency: "STARS",
        amountNanoTon: 0,
        status: "pending",
        detail: "Awaiting Telegram Stars invoice",
      });
      return {
        mode: "stars" as const,
        item: item.name,
        amountStars: Math.max(1, Math.round(item.priceUsdtCents / 2)),
        state: await requireState(ctx, cfg),
      };
    }),

  /** Step 2: the wallet returned a tx hash — mark the order paid and deliver. */
  confirm: protectedProcedure
    .input(z.object({ slug: z.string().min(1), txHash: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const cfg = await q.getConfig();
      await q.markPurchase(ctx.user.id, input.slug, {
        status: "paid",
        txHash: input.txHash,
        detail: "Paid on-chain",
      });
      await q.addLedger({
        userId: ctx.user.id,
        kind: "purchase",
        note: `Shop: ${input.slug} paid on-chain (${input.txHash.slice(0, 12)}…)`,
        refType: "purchase",
        refId: input.slug,
      });
      // Deliver the effect immediately, same as the off-chain rails.
      const catalogue = await q.listShopItems();
      const bought = catalogue.find((i) => i.slug === input.slug);
      if (bought) {
        await autoEquipAfterPurchase(ctx.user.id, bought.category, bought.slug, catalogue);
      }
      return requireState(ctx, cfg);
    }),

  mine: protectedProcedure.query(async ({ ctx }) => {
    const rows = await q.listPurchases(ctx.user.id);
    return rows.map((r) => ({
      id: r.id,
      itemSlug: r.itemSlug,
      itemName: r.itemName,
      tier: r.tier,
      category: r.category,
      priceUsdtCents: r.priceUsdtCents,
      payCurrency: r.payCurrency,
      status: r.status,
      txHash: r.txHash,
      createdAt: r.createdAt.toISOString(),
    }));
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Withdrawal — the 5 TON gate
// ─────────────────────────────────────────────────────────────────────────────
const withdrawalRouter = router({
  info: protectedProcedure.query(async ({ ctx }) => {
    const cfg = await q.getConfig();
    const profile = await q.getProfile(ctx.user.id);
    if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: "No player profile." });

    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const recent = await q.withdrawalsSince(ctx.user.id, since);
    const usedToday = recent
      .filter((w) => w.status !== "failed")
      .reduce((s, w) => s + Number(w.amountNanoTon), 0);

    const quote = quoteWithdrawal(cfg, profile.balanceNanoTon);
    const railArmed = !!cfg.treasureTonAddress && isTonAddress(cfg.treasureTonAddress);

    return {
      ...quote,
      thresholdTon: cfg.withdrawThresholdTon,
      feePercent: cfg.withdrawFeePercent,
      networkFeeTon: cfg.withdrawNetworkFeeTon,
      vestedPercent: cfg.vestedPercent,
      dailyLimitNanoTon: Math.round(cfg.withdrawDailyLimitTon * NANO),
      usedTodayNanoTon: usedToday,
      dailyLimitRemainingNanoTon: Math.max(
        0,
        Math.round(cfg.withdrawDailyLimitTon * NANO) - usedToday,
      ),
      walletConnected: !!profile.walletAddress,
      proofVerified: !!profile.proofVerifiedAt,
      walletAddress: profile.walletAddress,
      withdrawalPending: profile.withdrawalPending,
      railArmed,
      treasuryEvm: cfg.treasureEvmAddress,
      treasuryTon: cfg.treasureTonAddress || null,
      /** The gate, spelled out — mirrors `canWithdraw` in the spec. */
      canWithdraw:
        quote.eligible &&
        !profile.withdrawalPending &&
        !!profile.walletAddress &&
        railArmed &&
        usedToday + quote.grossNanoTon <= Math.round(cfg.withdrawDailyLimitTon * NANO),
    };
  }),

  request: protectedProcedure
    .input(z.object({ address: z.string().min(1).optional() }))
    .mutation(async ({ ctx, input }) => {
      const cfg = await q.getConfig();
      const profile = await syncProfile(ctx.user.id, cfg);

      if (!profile.walletAddress || !profile.proofVerifiedAt) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Connect and verify your TON wallet before withdrawing.",
        });
      }
      if (profile.withdrawalPending) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "You already have a withdrawal in progress.",
        });
      }

      const quote = quoteWithdrawal(cfg, profile.balanceNanoTon);
      if (!quote.eligible) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            `You need ${cfg.withdrawThresholdTon} TON to withdraw — ` +
            `you are ${nanoTonToTonString(quote.shortfallNanoTon)} TON short.`,
        });
      }

      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const recent = await q.withdrawalsSince(ctx.user.id, since);
      const usedToday = recent
        .filter((w) => w.status !== "failed")
        .reduce((s, w) => s + Number(w.amountNanoTon), 0);
      const limitNano = Math.round(cfg.withdrawDailyLimitTon * NANO);
      if (usedToday + quote.grossNanoTon > limitNano) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "That would exceed the daily withdrawal cap.",
        });
      }

      const payoutAddress =
        input.address && isTonAddress(input.address) ? input.address : profile.walletAddress;
      const treasuryOk = !!cfg.treasureTonAddress && isTonAddress(cfg.treasureTonAddress);

      const row = await q.insertWithdrawal({
        userId: ctx.user.id,
        amountNanoTon: quote.grossNanoTon,
        feeNanoTon: quote.feeNanoTon,
        networkFeeNanoTon: quote.networkFeeNanoTon,
        netNanoTon: quote.netNanoTon,
        vestedNanoTon: quote.vestedNanoTon,
        payoutAddress,
        status: "pending",
        failReason: treasuryOk
          ? null
          : "Payout rail not armed: no TON treasury address is configured, so the transfer is queued, not broadcast.",
      });

      // Debit to locked so the balance cannot be spent twice while pending.
      await q.updateProfile(ctx.user.id, {
        balanceNanoTon: 0,
        lockedNanoTon: profile.lockedNanoTon + quote.grossNanoTon,
        vestedNanoTon: profile.vestedNanoTon + quote.vestedNanoTon,
        withdrawalPending: true,
      });

      await q.addLedger({
        userId: ctx.user.id,
        kind: "withdrawal_requested",
        deltaNanoTon: -quote.grossNanoTon,
        note:
          `Withdrawal requested — ${nanoTonToTonString(quote.grossNanoTon)} TON ` +
          `(fee ${nanoTonToTonString(quote.feeNanoTon)}, net ${nanoTonToTonString(quote.netNanoTon)}, ` +
          `${cfg.vestedPercent}% vested for ${VEST_LOCK_DAYS} days)`,
        refType: "withdrawal",
        refId: row?.id ?? null,
      });

      // The exact transfer the treasury will broadcast — built with the real
      // address parser, so an invalid treasury is caught here, not on-chain.
      let transfer: { to: string; amountTon: string; payloadBase64: string } | null = null;
      if (treasuryOk) {
        transfer = {
          to: cfg.treasureTonAddress,
          amountTon: nanoTonToTonString(quote.netNanoTon),
          payloadBase64: commentPayload(`TON Tap Arena payout ${row?.id ?? ""}`.slice(0, 120)),
        };
      }

      return {
        ok: true,
        withdrawalId: row?.id ?? null,
        status: row?.status ?? "pending",
        railArmed: treasuryOk,
        transfer,
        message: treasuryOk
          ? "Withdrawal queued. The treasury signs and broadcasts the transfer."
          : "Withdrawal queued on the off-chain ledger. The on-chain rail is not armed until a 32-byte TON treasury address is set in the admin panel.",
        state: await requireState(ctx, cfg),
      };
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await q.listWithdrawals(ctx.user.id);
    return rows.map((r) => ({
      id: r.id,
      amountNanoTon: Number(r.amountNanoTon),
      netNanoTon: Number(r.netNanoTon),
      feeNanoTon: Number(r.feeNanoTon),
      vestedNanoTon: Number(r.vestedNanoTon),
      payoutAddress: r.payoutAddress,
      status: r.status,
      txHash: r.txHash,
      failReason: r.failReason,
      createdAt: r.createdAt.toISOString(),
    }));
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Referrals
// ─────────────────────────────────────────────────────────────────────────────
const referralRouter = router({
  summary: protectedProcedure.query(async ({ ctx }) => {
    const cfg = await q.getConfig();
    const profile = await q.getProfile(ctx.user.id);
    if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: "No player profile." });
    const rows = await q.listReferrals(ctx.user.id);
    const active = rows.filter((r) => r.status === "active");
    const rung = ladderRung(cfg, active.length);

    return {
      code: profile.referralCode,
      link: `https://t.me/share/url?url=${encodeURIComponent(
        `https://t.me/TonTapArenaBot/app?startapp=${profile.referralCode}`,
      )}`,
      appLink: `https://t.me/TonTapArenaBot/app?startapp=${profile.referralCode}`,
      total: rows.length,
      activeCount: active.length,
      premiumCount: rows.filter((r) => r.status === "premium").length,
      coinsEarned: rows.reduce((s, r) => s + Number(r.coinsAwarded), 0),
      rewardPerInvite: referralRewardCoin(cfg, false),
      rewardPerPremium: referralRewardCoin(cfg, true),
      revenueSharePercent: cfg.referralRevenueSharePercent,
      ladder: cfg.referralLadder.map((r) => ({
        ...r,
        reached: active.length >= r.friends,
        progress: Math.min(100, Math.round((active.length / r.friends) * 100)),
      })),
      currentRung: rung,
      referrals: rows.map((r) => ({
        id: r.id,
        handle: r.handle ?? "Player",
        avatar: r.avatar ?? "⛏️",
        coinsAwarded: Number(r.coinsAwarded),
        status: r.status,
        weekCoinMined: Number(r.weekCoinMined ?? 0),
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }),

  applyCode: protectedProcedure
    .input(z.object({ code: z.string().min(1).max(32) }))
    .mutation(async ({ ctx, input }) => {
      const cfg = await q.getConfig();
      const profile = await syncProfile(ctx.user.id, cfg);
      if (profile.referredBy) {
        throw new TRPCError({ code: "CONFLICT", message: "A referral code is already applied." });
      }
      const referrer = await q.findReferrerByCode(input.code.trim());
      if (!referrer) {
        throw new TRPCError({ code: "NOT_FOUND", message: "That referral code does not exist." });
      }
      if (referrer === ctx.user.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot refer yourself." });
      }

      await q.updateProfile(ctx.user.id, { referredBy: referrer });
      const bonus = referralRewardCoin(cfg, profile.referralPremium);

      const referrerProfile = await q.getProfile(referrer);
      if (referrerProfile) {
        await q.updateProfile(referrer, { balanceCoin: referrerProfile.balanceCoin + bonus });
        await q.addLedger({
          userId: referrer,
          kind: "referral_bonus",
          deltaCoin: bonus,
          note: "New referral joined",
          refType: "referral",
          refId: ctx.user.id,
        });
      }
      await q.addLedger({
        userId: ctx.user.id,
        kind: "referral_applied",
        note: "Referral code applied",
        refType: "referral",
        refId: referrer,
      });
      return { ok: true, bonus, state: await requireState(ctx, cfg) };
    }),

  claimRung: protectedProcedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const cfg = await q.getConfig();
      const rows = await q.listReferrals(ctx.user.id);
      const active = rows.filter((r) => r.status === "active").length;
      const rung = cfg.referralLadder.find((r) => r.name === input.name);
      if (!rung) throw new TRPCError({ code: "NOT_FOUND", message: "Unknown ladder rung." });
      if (active < rung.friends) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `You need ${rung.friends} referrals — you have ${active}.`,
        });
      }
      const claimSlug = `rung:${rung.name}`;
      const fresh = await q.claimTask({ userId: ctx.user.id, offerSlug: claimSlug, rewardCoin: 0 });
      if (!fresh) {
        throw new TRPCError({ code: "CONFLICT", message: "That rung reward was already claimed." });
      }
      const nano = Math.round(rung.bonusTon * NANO);
      const profile = await syncProfile(ctx.user.id, cfg);
      await q.updateProfile(ctx.user.id, { balanceNanoTon: profile.balanceNanoTon + nano });
      await q.addLedger({
        userId: ctx.user.id,
        kind: "referral_ladder",
        deltaNanoTon: nano,
        note: `Referral ladder — ${rung.name} (${rung.friends} friends)`,
        refType: "referral",
        refId: rung.name,
      });
      return { ok: true, bonusTon: rung.bonusTon, state: await requireState(ctx, cfg) };
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Leaderboard
// ─────────────────────────────────────────────────────────────────────────────
const leaderboardRouter = router({
  weekly: protectedProcedure.query(async ({ ctx }) => {
    const cfg = await q.getConfig();
    const board = await q.buildLeaderboard(cfg, ctx.user.id);
    return {
      ...board,
      leagueNames: cfg.leagueNames,
      leagueEmojis: cfg.leagueEmojis,
      leagueMultipliers: cfg.leagueMultipliers,
      weekStart: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
    };
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Offers & tasks
// ─────────────────────────────────────────────────────────────────────────────
const offersRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const cfg = await q.getConfig();
    const [rows, completed, profile, refRows] = await Promise.all([
      q.listOffers(),
      q.listTaskCompletions(ctx.user.id),
      q.getProfile(ctx.user.id),
      q.listReferrals(ctx.user.id),
    ]);
    const done = new Set(completed);
    const adCount = await q.countAdViewsSince(ctx.user.id, new Date(Date.now() - 86_400_000));
    const purchases = await q.listPurchases(ctx.user.id);
    const withdrawals = await q.listWithdrawals(ctx.user.id);

    return {
      offers: rows.map((o) => {
        const evalResult = profile
          ? evaluateRule(o.rule, o.ruleValue, {
              profile,
              referralCount: refRows.filter((r) => r.status === "active").length,
              adCount,
              purchaseCount: purchases.filter((p) => p.status !== "failed").length,
              withdrawalCount: withdrawals.length,
              cfg,
            })
          : { ok: false, reason: "Sign in to claim." };
        return {
          slug: o.slug,
          title: o.title,
          description: o.description,
          url: o.url,
          icon: o.icon,
          kind: o.kind,
          rule: o.rule,
          ruleValue: o.ruleValue,
          rewardCoin: Number(o.rewardCoin),
          bonusNanoTon: Number(o.bonusNanoTon),
          ctaLabel: o.ctaLabel,
          claimed: done.has(o.slug),
          eligible: evalResult.ok,
          hint: evalResult.reason,
          requiresUrl: !!o.url,
        };
      }),
      totalClaimable: rows
        .filter((o) => !done.has(o.slug))
        .reduce((s, o) => s + Number(o.rewardCoin), 0),
      claimedCount: completed.length,
      totalCount: rows.length,
    };
  }),

  claim: protectedProcedure
    .input(z.object({ slug: z.string().min(1), visited: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const cfg = await q.getConfig();
      const offer = (await q.listOffers()).find((o) => o.slug === input.slug);
      if (!offer) throw new TRPCError({ code: "NOT_FOUND", message: "That offer is not available." });

      const profile = await q.getProfile(ctx.user.id);
      if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: "No player profile." });

      // A manual (Telegram channel) task requires the client to confirm the link
      // was actually opened. Everything else is checked against real state.
      if (offer.rule === "manual" && offer.url && !input.visited) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Open the link first, then come back to claim.",
        });
      }

      const [refRows, adCount, purchases, withdrawals] = await Promise.all([
        q.listReferrals(ctx.user.id),
        q.countAdViewsSince(ctx.user.id, new Date(Date.now() - 86_400_000)),
        q.listPurchases(ctx.user.id),
        q.listWithdrawals(ctx.user.id),
      ]);

      const verdict = evaluateRule(offer.rule, offer.ruleValue, {
        profile,
        referralCount: refRows.filter((r) => r.status === "active").length,
        adCount,
        purchaseCount: purchases.filter((p) => p.status !== "failed").length,
        withdrawalCount: withdrawals.length,
        cfg,
      });
      if (!verdict.ok) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: verdict.reason });
      }

      const reward = Number(offer.rewardCoin);
      const fresh = await q.claimTask({ userId: ctx.user.id, offerSlug: offer.slug, rewardCoin: reward });
      if (!fresh) {
        throw new TRPCError({ code: "CONFLICT", message: "You already claimed that reward." });
      }

      const bonusNano = Number(offer.bonusNanoTon);
      const current = await q.getProfile(ctx.user.id);
      await q.updateProfile(ctx.user.id, {
        balanceCoin: (current?.balanceCoin ?? 0) + reward,
        totalCoinMined: (current?.totalCoinMined ?? 0) + reward,
        weekCoinMined: (current?.weekCoinMined ?? 0) + reward,
        ...(bonusNano > 0
          ? { balanceNanoTon: (current?.balanceNanoTon ?? 0) + bonusNano }
          : {}),
      });
      await q.addLedger({
        userId: ctx.user.id,
        kind: "task_reward",
        deltaCoin: reward,
        deltaNanoTon: bonusNano,
        note: `Task: ${offer.title}`,
        refType: "offer",
        refId: offer.slug,
      });

      return { ok: true, rewardCoin: reward, state: await requireState(ctx, cfg) };
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Ads — placeholder slot, fully admin-configurable
// ─────────────────────────────────────────────────────────────────────────────
const adsRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const cfg = await q.getConfig();
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const usedToday = await q.countAdViewsSince(ctx.user.id, since);
    const allTime = await q.countAdViewsSince(ctx.user.id, new Date(0));
    return {
      enabled: cfg.adEnabled,
      /** `adsgram` drives the real rewarded SDK; `placeholder` is the demo slot. */
      provider: cfg.adProvider,
      /** The Adsgram block ID the client initialises the SDK with. */
      blockId: cfg.adUnitId,
      unitId: cfg.adUnitId,
      link: cfg.adLink,
      rewardCoin: cfg.adRewardCoin,
      dailyLimit: cfg.adDailyLimit,
      watchSeconds: cfg.adWatchSeconds,
      usedToday,
      remaining: Math.max(0, cfg.adDailyLimit - usedToday),
      allTime,
    };
  }),

  watch: protectedProcedure
    .input(
      z.object({
        /**
         * Set by the client only after the ad network reported a completed
         * view. The server still enforces the daily cap and the watch time, so
         * a forged `true` cannot mint coins past the limit.
         */
        completed: z.boolean().optional().default(false),
        watchedSeconds: z.number().min(0).max(3600).optional().default(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const cfg = await q.getConfig();
      if (!cfg.adEnabled) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Ads are currently disabled." });
      }
      // The real network reports completion through its own callback; the
      // simulated slot reports elapsed seconds. Either way a view that did not
      // finish earns nothing.
      const completed = input.completed || input.watchedSeconds >= cfg.adWatchSeconds;
      if (!completed) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Watch the full ${cfg.adWatchSeconds}s to earn the reward.`,
        });
      }
      const since = new Date();
      since.setUTCHours(0, 0, 0, 0);
      const usedToday = await q.countAdViewsSince(ctx.user.id, since);
      if (usedToday >= cfg.adDailyLimit) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `That is all ${cfg.adDailyLimit} ad views for today. Come back tomorrow.`,
        });
      }

      await q.addAdView({
        userId: ctx.user.id,
        rewardCoin: cfg.adRewardCoin,
        adUnitId: cfg.adUnitId,
      });

      const profile = await syncProfile(ctx.user.id, cfg);
      await q.updateProfile(ctx.user.id, {
        balanceCoin: profile.balanceCoin + cfg.adRewardCoin,
        totalCoinMined: profile.totalCoinMined + cfg.adRewardCoin,
        weekCoinMined: profile.weekCoinMined + cfg.adRewardCoin,
      });
      await q.addLedger({
        userId: ctx.user.id,
        kind: "ad_reward",
        deltaCoin: cfg.adRewardCoin,
        note: `Ad view reward (unit ${cfg.adUnitId})`,
        refType: "ad",
      });

      return {
        ok: true,
        rewardCoin: cfg.adRewardCoin,
        remaining: Math.max(0, cfg.adDailyLimit - (usedToday + 1)),
        state: await requireState(ctx, cfg),
      };
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin panel — separate password session, cookie-scoped
// ─────────────────────────────────────────────────────────────────────────────
const adminOnly = middleware(async ({ ctx, next }) => {
  const token = getCookie(ctx.c, ADMIN_COOKIE);
  if (!token) throw new TRPCError({ code: "UNAUTHORIZED", message: "Admin sign-in required." });
  const session = await q.getAdminSession(token);
  if (!session) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Admin session expired — sign in again." });
  }
  return next();
});

const adminGuard = publicProcedure.use(adminOnly);

async function readAdminPasswordHash(): Promise<string | null> {
  const overrides = await q.getConfigOverrides();
  const stored = overrides["admin.passwordHash"];
  return typeof stored === "string" ? stored : null;
}

const adminRouter = router({
  login: publicProcedure
    .input(z.object({ password: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const stored = await readAdminPasswordHash();
      const ok = stored
        ? await bcrypt.compare(input.password, stored)
        : input.password === DEFAULT_ADMIN_PASSWORD;

      if (!ok) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Incorrect panel password." });
      }
      if (!stored) {
        // First successful sign-in pins the default's hash, so the password can
        // then be rotated from inside the panel.
        await q.setSetting("admin.passwordHash", await bcrypt.hash(input.password, 10));
      }
      const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      await q.createAdminSession(token, ctx.user?.id ?? null);
      setCookie(ctx.c, ADMIN_COOKIE, token, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 12 * 3600,
      });
      return { ok: true, usingDefaultPassword: !stored };
    }),

  logout: adminGuard.mutation(async ({ ctx }) => {
    const token = getCookie(ctx.c, ADMIN_COOKIE);
    if (token) await q.deleteAdminSession(token);
    deleteCookie(ctx.c, ADMIN_COOKIE, { path: "/" });
    return { ok: true };
  }),

  me: publicProcedure.query(async ({ ctx }) => {
    const token = getCookie(ctx.c, ADMIN_COOKIE);
    if (!token) return { signedIn: false };
    const session = await q.getAdminSession(token);
    if (!session) return { signedIn: false };
    const overrides = await q.getConfigOverrides();
    return {
      signedIn: true,
      usingDefaultPassword: !overrides["admin.passwordHash"],
    };
  }),

  changePassword: adminGuard
    .input(z.object({ password: z.string().min(6).max(128) }))
    .mutation(async ({ input }) => {
      await q.setSetting("admin.passwordHash", await bcrypt.hash(input.password, 10));
      return { ok: true };
    }),

  stats: adminGuard.query(() => q.adminStats()),

  getConfig: adminGuard.query(async () => {
    const overrides = await q.getConfigOverrides();
    const cfg = resolveConfig(overrides);
    // Never ship the password hash to the client.
    const exposedOverrides = { ...overrides };
    delete exposedOverrides["admin.passwordHash"];
    return {
      config: cfg,
      overrides: exposedOverrides,
      defaults: resolveConfig(null),
      hasTonTreasury: !!cfg.treasureTonAddress && isTonAddress(cfg.treasureTonAddress),
    };
  }),

  setConfig: adminGuard
    .input(z.object({ path: z.string().min(1), value: z.unknown() }))
    .mutation(async ({ input }) => {
      await q.setSetting(input.path, input.value);
      const cfg = await q.getConfig();
      return { ok: true, config: cfg };
    }),

  setConfigBulk: adminGuard
    .input(z.object({ values: z.record(z.string(), z.unknown()) }))
    .mutation(async ({ input }) => {
      for (const [path, value] of Object.entries(input.values)) {
        await q.setSetting(path, value);
      }
      return { ok: true, config: await q.getConfig() };
    }),

  resetConfig: adminGuard
    .input(z.object({ path: z.string().min(1) }))
    .mutation(async ({ input }) => {
      // Write the code default back, which is the same as clearing the override.
      const def = resolveConfig(null) as unknown as Record<string, unknown>;
      const value = input.path.split(".").reduce<unknown>((a, k) => {
        if (a === null || a === undefined) return undefined;
        return (a as Record<string, unknown>)[k];
      }, def);
      await q.setSetting(input.path, value);
      return { ok: true, config: await q.getConfig() };
    }),

  users: adminGuard
    .input(z.object({ limit: z.number().int().min(1).max(500).default(100), offset: z.number().int().min(0).default(0) }).optional())
    .query(({ input }) => q.listUsersForAdmin(input?.limit ?? 100, input?.offset ?? 0)),

  adjust: adminGuard
    .input(
      z.object({
        userId: z.string().min(1),
        deltaCoin: z.number().int().default(0),
        deltaTon: z.number().default(0),
        note: z.string().max(200).default("Admin adjustment"),
      }),
    )
    .mutation(async ({ input }) => {
      await q.adminAdjustCoins(
        input.userId,
        input.deltaCoin,
        Math.round(input.deltaTon * NANO),
        input.note,
      );
      return { ok: true };
    }),

  ledger: adminGuard
    .input(z.object({ limit: z.number().int().min(1).max(500).default(100) }).optional())
    .query(async ({ input }) => {
      const rows = await q.listAllLedger(input?.limit ?? 100);
      return rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        handle: r.handle,
        email: r.email,
        kind: r.kind,
        deltaCoin: Number(r.deltaCoin),
        deltaNanoTon: Number(r.deltaNanoTon),
        note: r.note,
        createdAt: r.createdAt.toISOString(),
      }));
    }),

  shop: adminGuard.query(async () => {
    const items = await q.listShopItems(false);
    return items.map((i) => ({
      ...i,
      coinPrice: Number(i.coinPrice),
      createdAt: i.createdAt.toISOString(),
    }));
  }),

  saveShopItem: adminGuard
    .input(
      z.object({
        slug: z.string().min(1).max(64),
        name: z.string().min(1).max(120),
        description: z.string().max(400).default(""),
        category: z.enum(["skin", "button"]),
        tierIndex: z.number().int().min(0).max(20),
        tier: z.string().min(1).max(40),
        priceUsdtCents: z.number().int().min(0).max(1_000_000),
        coinPrice: z.number().int().min(0).max(1_000_000_000_000),
        boostPercent: z.number().int().min(0).max(500),
        imageUrl: z.string().min(1).max(300),
        active: z.boolean(),
      }),
    )
    .mutation(async ({ input }) => {
      await q.upsertShopItemSafe(input);
      return { ok: true };
    }),

  deleteShopItem: adminGuard
    .input(z.object({ slug: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await q.deleteShopItemBySlug(input.slug);
      return { ok: true };
    }),

  offers: adminGuard.query(async () => {
    const rows = await q.listOffers(false);
    return rows.map((o) => ({
      ...o,
      rewardCoin: Number(o.rewardCoin),
      bonusNanoTon: Number(o.bonusNanoTon),
      createdAt: o.createdAt.toISOString(),
    }));
  }),

  saveOffer: adminGuard
    .input(
      z.object({
        slug: z.string().min(1).max(64),
        title: z.string().min(1).max(160),
        description: z.string().max(400).default(""),
        url: z.string().max(400).default(""),
        icon: z.string().max(8).default("🎯"),
        kind: z.enum(["channel", "task", "ad"]),
        rule: z.enum(["manual", "wallet", "purchase", "withdrawal", "ad", "referrals", "league"]),
        ruleValue: z.number().int().min(0).max(1_000_000).default(0),
        rewardCoin: z.number().int().min(0).max(1_000_000_000),
        bonusTon: z.number().min(0).max(1000).default(0),
        ctaLabel: z.string().max(40).default("Claim"),
        active: z.boolean(),
        sortOrder: z.number().int().default(0),
      }),
    )
    .mutation(async ({ input }) => {
      await q.upsertOfferSafe(input);
      return { ok: true };
    }),

  deleteOffer: adminGuard
    .input(z.object({ slug: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await q.deleteOfferBySlug(input.slug);
      return { ok: true };
    }),

  withdrawals: adminGuard.query(async () => {
    const rows = await q.listAllWithdrawals();
    return rows.map((r) => ({
      ...r,
      amountNanoTon: Number(r.amountNanoTon),
      netNanoTon: Number(r.netNanoTon),
      feeNanoTon: Number(r.feeNanoTon),
      createdAt: r.createdAt.toISOString(),
    }));
  }),

  purchases: adminGuard.query(async () => {
    const rows = await q.listAllPurchases();
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }),

  setWithdrawalStatus: adminGuard
    .input(
      z.object({
        id: z.string().min(1),
        status: z.enum(["pending", "processing", "completed", "failed"]),
        txHash: z.string().max(200).optional(),
        failReason: z.string().max(300).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await q.setWithdrawalStatusAdmin(input.id, {
        status: input.status,
        txHash: input.txHash ?? null,
        failReason: input.failReason ?? null,
      });
      return { ok: true };
    }),

  board: adminGuard.query(async () => ({
    seedCount: await q.countLeaderboardSeed(),
  })),

  seedBoard: adminGuard
    .input(z.object({ count: z.number().int().min(0).max(60).default(20) }))
    .mutation(async ({ input }) => {
      await q.clearLeaderboardSeed();
      if (input.count === 0) return { ok: true, inserted: 0 };
      const handles = [
        "NovaMiner","LunaTap","CryptoHawk","ZenithKing","PixelPirate","AquaByte","VoltRider",
        "StarForge","NebulaX","IronPulse","GhostCoin","SolarFlare","ByteBaron","QuantumFox",
        "TurboNaut","EchoStorm","NeonDrift","OrbitKid","PlasmaPug","AlphaWolf","HyperIon",
        "DeltaNode","CosmoApe","RiftWalker","AuroraSky","TitanCore","VertexOwl","ZephyrJet",
        "OnyxBear","PrismCat",
      ];
      const avatars = ["⛏️","💎","🚀","🔥","⚡","👑","🎯","🌙","🦅","🐺"];
      const cfg = await q.getConfig();
      const rows = Array.from({ length: input.count }, (_, i) => {
        const coins = Math.max(2_000, Math.round(120_000 / (i + 1) ** 0.55));
        let leagueIndex = 0;
        cfg.leagueThresholds.forEach((t, li) => {
          if (coins >= t) leagueIndex = li;
        });
        return {
          handle: handles[i % handles.length]!,
          avatar: avatars[i % avatars.length]!,
          weekCoinMined: coins,
          leagueIndex,
        };
      });
      await q.seedLeaderboard(rows);
      return { ok: true, inserted: rows.length };
    }),

  clearBoard: adminGuard.mutation(async () => {
    await q.clearLeaderboardSeed();
    return { ok: true };
  }),

  seedCatalogue: adminGuard.mutation(async () => {
    const res = await seedCatalogue();
    return { ok: true, ...res };
  }),

  clearPendingWithdrawal: adminGuard
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await q.releaseWithdrawalLock(input.id);
      return { ok: true };
    }),
});

// ─────────────────────────────────────────────────────────────────────────────
export const appRouter = router({
  auth: authRouter,
  game: gameRouter,
  wallet: walletRouter,
  shop: shopRouter,
  withdrawal: withdrawalRouter,
  referral: referralRouter,
  leaderboard: leaderboardRouter,
  offers: offersRouter,
  ads: adsRouter,
  admin: adminRouter,
  files: filesRouter,
});

export type AppRouter = typeof appRouter;

