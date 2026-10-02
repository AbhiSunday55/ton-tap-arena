// ── Standalone demo backend ─────────────────────────────────────────────────
// GitHub Pages serves STATIC files: there is no Node process, no Postgres and
// no bot token, so the real tRPC server cannot run there. This module is a
// faithful, in-browser re-implementation of the game's API surface so the
// published site is a fully playable demo instead of a dead login screen.
//
// It is NOT a second source of truth. Every number it produces comes from the
// SAME `shared/` modules the server uses — `settleTapBatch`, `quoteWithdrawal`,
// `tierEffects`, `resolveConfig` — so the demo cannot drift from the real rules.
// What it deliberately does NOT do is anything that needs a secret or a chain:
// no initData verification, no on-chain broadcast, no real money. Those live in
// the server build, which is what the Telegram Mini App runs.
//
// State is persisted to localStorage, so a demo player's progress survives a
// reload on the same device.
import {
  ASSET,
  NANO,
  dayKey,
  leagueFor,
  resolveConfig,
  type GameConfig,
} from "../../../shared/game-config";
import {
  ZERO_EFFECTS,
  combineEffects,
  effectiveEnergyCap,
  effectiveRegenSeconds,
  normalizeEffects,
  tierEffects,
  type ItemEffects,
} from "../../../shared/item-effects";
import {
  freshBoosterUsage,
  ladderRung,
  quoteWithdrawal,
  referralRewardCoin,
  settleTapBatch,
  tapRewardPerTapExact,
  tierPriceCoin,
  tierPriceUsdtCents,
  totalRigPerHour,
  turboActive,
  usdtCentsToNanoTon,
  type BoosterUsage,
  type RigsOwned,
} from "../../../shared/game-rules";

const STORAGE_KEY = "tta.demo.v1";

const TIER_NAMES = ["Common", "Rare", "Epic", "Legendary", "Mythic"] as const;
const SKIN_NAMES = ["Copper Coin", "Azure Coin", "Violet Coin", "Solar Coin", "Void Coin"];
const BTN_NAMES = ["Basic Pad", "Circuit Pad", "Plasma Pad", "Eclipse Pad", "Celestial Pad"];
const SKIN_FLAVOR = [
  "A humble starting coin.",
  "Cobalt plating.",
  "Amethyst core.",
  "Forged in gold light.",
  "A shard of the void itself.",
];
const BTN_FLAVOR = [
  "Standard mining control surface.",
  "Etched circuitry.",
  "Ionised plasma surface.",
  "Dark-matter coating.",
  "Blessed by the stars.",
];

const RIVAL_HANDLES = [
  "CoinTycoon", "NovaMiner", "TapLord", "VoidRunner", "GoldFinger", "ByteSmith",
  "LunaStack", "IronThumb", "PixelPirate", "QuantumFox", "SolarFlare", "NeonDrift",
  "CryptoOtter", "MidnightMint", "TurboToad", "ZenithWolf", "EchoNomad", "PrimeCog",
  "AstroApe", "DeltaDuck",
];
const RIVAL_AVATARS = ["🦊", "🐺", "🐸", "🦉", "🐙", "🦄", "🐲", "🦅", "🐳", "🦁"];

interface DemoProfile {
  handle: string;
  avatar: string;
  balanceCoin: number;
  balanceNanoTon: number;
  vestedNanoTon: number;
  lockedNanoTon: number;
  totalTaps: number;
  totalCoinMined: number;
  weekCoinMined: number;
  energy: number;
  energyUpdatedAt: string;
  tapPowerLevel: number;
  itemBoostPercent: number;
  itemEffects: ItemEffects;
  turboUntil: string | null;
  comboCount: number;
  lastTapAt: string | null;
  coinCarry: number;
  streakDay: number;
  streakClaimedDayKey: string | null;
  referralCode: string;
  referralPremium: boolean;
  equippedSkin: string | null;
  equippedButton: string | null;
  rigsOwned: RigsOwned;
  boostersUsed: BoosterUsage;
  boosterDayKey: string;
  rechargeReadyAt: string | null;
  walletAddress: string | null;
  walletProvider: string | null;
  proofVerifiedAt: string | null;
  walletConnectedAt: string | null;
  withdrawalPending: boolean;
  soundEnabled: boolean;
  isAdmin: boolean;
  createdAt: string;
}

interface DemoState {
  profile: DemoProfile;
  owned: string[];
  purchases: {
    id: string;
    itemSlug: string;
    itemName: string;
    tier: string;
    category: string;
    priceUsdtCents: number;
    payCurrency: string;
    status: string;
    txHash: string | null;
    createdAt: string;
  }[];
  ledger: {
    id: string;
    kind: string;
    note: string;
    deltaCoin: number;
    deltaNanoTon: number;
    createdAt: string;
  }[];
  withdrawals: {
    id: string;
    amountNanoTon: number;
    netNanoTon: number;
    feeNanoTon: number;
    payoutAddress: string;
    status: string;
    txHash: string | null;
    createdAt: string;
  }[];
  claimedOffers: string[];
  adViews: { at: string; rewardCoin: number }[];
  referrals: { id: string; handle: string; avatar: string; coinsAwarded: number; status: string; createdAt: string }[];
  claimedRungs: string[];
  weekStart: string;
}

const cfg: GameConfig = resolveConfig(null);

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function makeCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function freshState(): DemoState {
  const now = new Date();
  return {
    profile: {
      handle: "Guest Miner",
      avatar: "⛏️",
      balanceCoin: cfg.startingCoin,
      balanceNanoTon: Math.round(cfg.startingTon * NANO),
      vestedNanoTon: 0,
      lockedNanoTon: 0,
      totalTaps: 0,
      totalCoinMined: 0,
      weekCoinMined: 0,
      energy: cfg.energyCap,
      energyUpdatedAt: now.toISOString(),
      tapPowerLevel: 1,
      itemBoostPercent: 0,
      itemEffects: ZERO_EFFECTS,
      turboUntil: null,
      comboCount: 0,
      lastTapAt: null,
      coinCarry: 0,
      streakDay: 1,
      streakClaimedDayKey: null,
      referralCode: makeCode(),
      referralPremium: false,
      equippedSkin: null,
      equippedButton: null,
      rigsOwned: {},
      boostersUsed: { turbo: 0, energy: 0, recharge: 0 },
      boosterDayKey: dayKey(now),
      rechargeReadyAt: null,
      walletAddress: null,
      walletProvider: null,
      proofVerifiedAt: null,
      walletConnectedAt: null,
      withdrawalPending: false,
      soundEnabled: true,
      isAdmin: false,
      createdAt: now.toISOString(),
    },
    owned: [],
    purchases: [],
    ledger: [
      {
        id: uid(),
        kind: "welcome_bonus",
        note: "Welcome bonus — 1,000 COIN + 0.10 TON",
        deltaCoin: cfg.startingCoin,
        deltaNanoTon: Math.round(cfg.startingTon * NANO),
        createdAt: now.toISOString(),
      },
    ],
    withdrawals: [],
    claimedOffers: [],
    adViews: [],
    referrals: [],
    claimedRungs: [],
    weekStart: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
  };
}

let state: DemoState | null = null;

function load(): DemoState {
  if (state) return state;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DemoState;
      if (parsed?.profile?.referralCode) {
        state = parsed;
        return state;
      }
    }
  } catch {
    /* private mode / corrupt payload — start clean */
  }
  state = freshState();
  save();
  return state;
}

function save(): void {
  try {
    if (state) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — the demo still works for this session */
  }
}

function log(kind: string, note: string, deltaCoin = 0, deltaNanoTon = 0): void {
  const s = load();
  s.ledger.unshift({ id: uid(), kind, note, deltaCoin, deltaNanoTon, createdAt: new Date().toISOString() });
  s.ledger = s.ledger.slice(0, 120);
}

/** The shop catalogue, derived from the same tier curves the server seeds. */
function catalogue() {
  const rows: {
    slug: string;
    name: string;
    description: string;
    category: "skin" | "button";
    tierIndex: number;
    tier: string;
    priceUsdtCents: number;
    coinPrice: number;
    boostPercent: number;
    effects: ItemEffects;
    imageUrl: string;
  }[] = [];

  for (let i = 0; i < 5; i++) {
    const skinFx = tierEffects("skin", i);
    const btnFx = tierEffects("button", i);
    rows.push({
      slug: `skin_${TIER_NAMES[i]!.toLowerCase()}`,
      name: SKIN_NAMES[i]!,
      description: `${SKIN_FLAVOR[i]} +${skinFx.tapPercent}% tap power.`,
      category: "skin",
      tierIndex: i,
      tier: TIER_NAMES[i]!,
      priceUsdtCents: tierPriceUsdtCents(cfg, i),
      coinPrice: tierPriceCoin(cfg, i),
      boostPercent: skinFx.tapPercent,
      effects: skinFx,
      imageUrl: ASSET.skin[`skin_${TIER_NAMES[i]!.toLowerCase()}` as keyof typeof ASSET.skin]!,
    });
    rows.push({
      slug: `btn_${TIER_NAMES[i]!.toLowerCase()}`,
      name: BTN_NAMES[i]!,
      description: `${BTN_FLAVOR[i]} +${btnFx.energyCapBonus} energy cap.`,
      category: "button",
      tierIndex: i,
      tier: TIER_NAMES[i]!,
      priceUsdtCents: tierPriceUsdtCents(cfg, i),
      coinPrice: tierPriceCoin(cfg, i),
      boostPercent: btnFx.tapPercent,
      effects: btnFx,
      imageUrl: ASSET.btn[`btn_${TIER_NAMES[i]!.toLowerCase()}` as keyof typeof ASSET.btn]!,
    });
  }
  return rows;
}

const CATALOGUE = catalogue();

const OFFERS = [
  { slug: "channel-myduck", title: "Join MyDuck on Telegram", description: "Join the MyDuck channel to unlock your reward.", url: "https://t.me/myduck?start=r581731ebec1cdae", icon: "🦆", kind: "channel", rule: "manual", ruleValue: 0, rewardCoin: 25_000, ctaLabel: "Join, then claim" },
  { slug: "channel-totalhash", title: "Open the TotalHash bot", description: "Start the TotalHash bot to unlock your reward.", url: "https://t.me/totalhashbot/start?startapp=954512685", icon: "🤖", kind: "channel", rule: "manual", ruleValue: 0, rewardCoin: 25_000, ctaLabel: "Open, then claim" },
  { slug: "follow-x", title: "Follow us on X", description: "Follow the official account for announcements.", url: "https://x.com/", icon: "𝕏", kind: "task", rule: "manual", ruleValue: 0, rewardCoin: 10_000, ctaLabel: "Open, then claim" },
  { slug: "invite-1-friend", title: "Invite 1 friend", description: "Share your referral link and get your first signup.", url: "", icon: "👥", kind: "task", rule: "referrals", ruleValue: 1, rewardCoin: 15_000, ctaLabel: "Claim" },
  { slug: "invite-5-friends", title: "Invite 5 friends", description: "Build a squad of five.", url: "", icon: "🔥", kind: "task", rule: "referrals", ruleValue: 5, rewardCoin: 100_000, ctaLabel: "Claim" },
  { slug: "connect-wallet", title: "Connect your TON wallet", description: "Verify a wallet to enable withdrawals.", url: "", icon: "👛", kind: "task", rule: "wallet", ruleValue: 0, rewardCoin: 20_000, ctaLabel: "Claim" },
  { slug: "first-purchase", title: "Make your first purchase", description: "Buy anything from the shop.", url: "", icon: "🛍️", kind: "task", rule: "purchase", ruleValue: 0, rewardCoin: 50_000, ctaLabel: "Claim" },
  { slug: "first-withdrawal", title: "Complete a withdrawal", description: "Reach the threshold and cash out.", url: "", icon: "🏦", kind: "task", rule: "withdrawal", ruleValue: 0, rewardCoin: 250_000, ctaLabel: "Claim" },
  { slug: "watch-3-ads", title: "Watch 3 ads", description: "Sit through three ad views.", url: "", icon: "📺", kind: "task", rule: "ad", ruleValue: 3, rewardCoin: 30_000, ctaLabel: "Claim" },
  { slug: "reach-silver", title: "Reach Silver league", description: "Mine 50,000 coins in total.", url: "", icon: "🥈", kind: "task", rule: "league", ruleValue: 1, rewardCoin: 75_000, ctaLabel: "Claim" },
];

/** Settle lazy regen, rig income and the weekly rollover, exactly as the server does. */
function sync(): DemoProfile {
  const s = load();
  const p = s.profile;
  const now = new Date();

  const effects = normalizeEffects(p.itemEffects);
  const cap = effectiveEnergyCap(cfg, effects);
  const regen = Math.floor(
    ((now.getTime() - new Date(p.energyUpdatedAt).getTime()) / 1000) /
      effectiveRegenSeconds(cfg, effects),
  );
  if (regen > 0) {
    p.energy = Math.min(cap, p.energy + regen);
    p.energyUpdatedAt = now.toISOString();
  }

  // Passive rig income since the last settle.
  const perHour = totalRigPerHour(cfg, p.rigsOwned, effects);
  if (perHour > 0) {
    const hours = (now.getTime() - new Date(p.energyUpdatedAt).getTime()) / 3_600_000;
    if (hours > 0.001) {
      const earned = Math.floor(perHour * hours);
      if (earned > 0) {
        p.balanceCoin += earned;
        p.totalCoinMined += earned;
        p.weekCoinMined += earned;
      }
    }
  }

  // Weekly board rollover.
  if (now.getTime() - new Date(s.weekStart).getTime() > 7 * 24 * 3600 * 1000) {
    s.weekStart = now.toISOString();
    p.weekCoinMined = 0;
  }

  save();
  return p;
}

function buildState() {
  const p = sync();
  const league = leagueFor(cfg, p.totalCoinMined);
  const usage = freshBoosterUsage(cfg, p.boostersUsed, p.boosterDayKey, dayKey());
  const effects = normalizeEffects(p.itemEffects);
  const cap = effectiveEnergyCap(cfg, effects);
  const withdraw = quoteWithdrawal(cfg, p.balanceNanoTon);

  return {
    serverNow: new Date().toISOString(),
    profile: {
      userId: "demo-player",
      handle: p.handle,
      avatar: p.avatar,
      balanceCoin: p.balanceCoin,
      balanceNanoTon: p.balanceNanoTon,
      vestedNanoTon: p.vestedNanoTon,
      lockedNanoTon: p.lockedNanoTon,
      totalTaps: p.totalTaps,
      totalCoinMined: p.totalCoinMined,
      weekCoinMined: p.weekCoinMined,
      energy: p.energy,
      energyUpdatedAt: p.energyUpdatedAt,
      tapPowerLevel: p.tapPowerLevel,
      itemBoostPercent: p.itemBoostPercent,
      itemEffects: effects,
      energyCap: cap,
      energyRegenSeconds: effectiveRegenSeconds(cfg, effects),
      turboUntil: p.turboUntil,
      streakDay: p.streakDay,
      streakClaimedToday: p.streakClaimedDayKey === dayKey(),
      referralCode: p.referralCode,
      referralPremium: p.referralPremium,
      equippedSkin: p.equippedSkin,
      equippedButton: p.equippedButton,
      tapPowerPerTap: Math.floor(
        tapRewardPerTapExact(cfg, {
          leagueMult: league.mult,
          tapPowerLevel: p.tapPowerLevel,
          comboMult: 1,
          itemBoostPercent: effects.tapPercent,
          turbo: false,
        }),
      ),
      tapPowerPerTapExact: tapRewardPerTapExact(cfg, {
        leagueMult: league.mult,
        tapPowerLevel: p.tapPowerLevel,
        comboMult: 1,
        itemBoostPercent: effects.tapPercent,
        turbo: false,
      }),
      soundEnabled: p.soundEnabled,
      isAdmin: false,
      walletAddress: p.walletAddress,
      walletProvider: p.walletProvider,
      proofVerified: !!p.proofVerifiedAt,
      walletConnectedAt: p.walletConnectedAt,
      withdrawalPending: p.withdrawalPending,
      createdAt: p.createdAt,
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
              ((p.totalCoinMined - (cfg.leagueThresholds[league.index] ?? 0)) /
                Math.max(1, league.next - (cfg.leagueThresholds[league.index] ?? 0))) *
                100,
            ),
          )
        : 100,
    },
    boosters: {
      turbo: { freeLeft: Math.max(0, cfg.turboFreePerDay - usage.usage.turbo), cost: cfg.turboCostCoin },
      energy: { freeLeft: Math.max(0, cfg.energyRefillFreePerDay - usage.usage.energy), cost: cfg.energyRefillCostCoin },
      recharge: {
        freeLeft: Math.max(0, cfg.rechargeFreePerDay - usage.usage.recharge),
        cost: cfg.rechargeCostCoin,
        readyAt: p.rechargeReadyAt,
      },
    },
    rigs: cfg.rigs.map((r, i) => {
      const key = ["scrap_rig", "steel_rig", "plasma_rig", "quantum_rig"][i]!;
      return {
        key,
        name: r.name,
        costCoin: r.costCoin,
        perHour: r.perHour,
        owned: Number(p.rigsOwned[key] ?? 0),
      };
    }),
    rigPerHour: totalRigPerHour(cfg, p.rigsOwned, effects),
    streakRewards: cfg.streakRewards,
    withdraw,
    turboActive: turboActive(cfg, p.turboUntil ? new Date(p.turboUntil) : null, new Date()),
  };
}

function shopList() {
  const s = load();
  const p = sync();
  return {
    items: CATALOGUE.map((i) => ({
      slug: i.slug,
      name: i.name,
      description: i.description,
      category: i.category,
      tierIndex: i.tierIndex,
      tier: i.tier,
      priceUsdtCents: i.priceUsdtCents,
      priceTon: (usdtCentsToNanoTon(cfg, i.priceUsdtCents) / NANO).toFixed(4),
      coinPrice: i.coinPrice,
      boostPercent: i.boostPercent,
      effects: i.effects,
      imageUrl: i.imageUrl,
      owned: s.owned.includes(i.slug),
      equipped: p.equippedSkin === i.slug || p.equippedButton === i.slug,
    })),
    // The demo has no treasury key, so the on-chain rail is honestly reported as
    // not armed. The real server build arms it from the admin panel.
    railArmed: false,
    treasuryEvm: cfg.treasureEvmAddress,
    treasuryTon: cfg.treasureTonAddress || null,
    balanceCoin: p.balanceCoin,
    tonUsdRate: cfg.tonUsdRate,
    usdtTonRate: cfg.usdtTonRate,
  };
}

function leaderboard() {
  const s = load();
  const p = sync();
  const rows = RIVAL_HANDLES.map((handle, i) => {
    const coins = Math.max(2_000, Math.round(120_000 / (i + 1) ** 0.55));
    let leagueIndex = 0;
    cfg.leagueThresholds.forEach((t, li) => {
      if (coins >= t) leagueIndex = li;
    });
    return {
      rank: 0,
      handle,
      avatar: RIVAL_AVATARS[i % RIVAL_AVATARS.length]!,
      weekCoinMined: coins,
      leagueIndex,
      isYou: false,
      isSeed: true,
    };
  });

  const you = {
    rank: 0,
    handle: p.handle,
    avatar: p.avatar,
    weekCoinMined: p.weekCoinMined,
    leagueIndex: leagueFor(cfg, p.totalCoinMined).index,
    isYou: true,
    isSeed: false,
  };

  const all = [...rows, you].sort((a, b) => b.weekCoinMined - a.weekCoinMined);
  all.forEach((r, i) => (r.rank = i + 1));

  return {
    rows: all,
    yourRank: all.find((r) => r.isYou)?.rank ?? null,
    totalPlayers: all.length,
    leagueNames: cfg.leagueNames,
    leagueEmojis: cfg.leagueEmojis,
    leagueMultipliers: cfg.leagueMultipliers,
    weekStart: s.weekStart,
  };
}

function offersList() {
  const s = load();
  const p = sync();
  const activeRefs = s.referrals.filter((r) => r.status === "active").length;
  const adCount = s.adViews.filter((v) => Date.now() - new Date(v.at).getTime() < 86_400_000).length;
  const purchases = s.purchases.filter((x) => x.status !== "failed").length;
  const leagueIndex = leagueFor(cfg, p.totalCoinMined).index;

  const evaluate = (rule: string, ruleValue: number): { ok: boolean; reason: string } => {
    switch (rule) {
      case "wallet":
        return p.walletAddress && p.proofVerifiedAt
          ? { ok: true, reason: "" }
          : { ok: false, reason: "Connect and verify a TON wallet first." };
      case "purchase":
        return purchases > 0 ? { ok: true, reason: "" } : { ok: false, reason: "Buy anything from the shop first." };
      case "withdrawal":
        return s.withdrawals.length > 0 ? { ok: true, reason: "" } : { ok: false, reason: "Complete a withdrawal first." };
      case "referrals":
        return activeRefs >= ruleValue
          ? { ok: true, reason: "" }
          : { ok: false, reason: `You have ${activeRefs} of ${ruleValue} required referrals.` };
      case "ad":
        return adCount >= ruleValue ? { ok: true, reason: "" } : { ok: false, reason: `Watch ${ruleValue} ads first.` };
      case "league":
        return leagueIndex >= ruleValue ? { ok: true, reason: "" } : { ok: false, reason: "Reach the required league first." };
      default:
        return { ok: true, reason: "" };
    }
  };

  return {
    offers: OFFERS.map((o) => {
      const ev = evaluate(o.rule, o.ruleValue);
      return {
        slug: o.slug,
        title: o.title,
        description: o.description,
        url: o.url,
        icon: o.icon,
        kind: o.kind,
        rule: o.rule,
        ruleValue: o.ruleValue,
        rewardCoin: o.rewardCoin,
        bonusNanoTon: 0,
        ctaLabel: o.ctaLabel,
        claimed: s.claimedOffers.includes(o.slug),
        eligible: ev.ok,
        hint: ev.reason,
        requiresUrl: !!o.url,
      };
    }),
    totalClaimable: OFFERS.filter((o) => !s.claimedOffers.includes(o.slug)).reduce((a, o) => a + o.rewardCoin, 0),
    claimedCount: s.claimedOffers.length,
    totalCount: OFFERS.length,
  };
}

function referralSummary() {
  const s = load();
  const p = sync();
  const active = s.referrals.filter((r) => r.status === "active");
  const rung = ladderRung(cfg, active.length);
  const appLink = `https://t.me/TonTapArenaBot/app?startapp=${p.referralCode}`;
  return {
    code: p.referralCode,
    link: `https://t.me/share/url?url=${encodeURIComponent(appLink)}`,
    appLink,
    total: s.referrals.length,
    activeCount: active.length,
    premiumCount: s.referrals.filter((r) => r.status === "premium").length,
    coinsEarned: s.referrals.reduce((a, r) => a + r.coinsAwarded, 0),
    rewardPerInvite: referralRewardCoin(cfg, false),
    rewardPerPremium: referralRewardCoin(cfg, true),
    revenueSharePercent: cfg.referralRevenueSharePercent,
    ladder: cfg.referralLadder.map((r) => ({
      ...r,
      reached: active.length >= r.friends,
      progress: Math.min(100, Math.round((active.length / r.friends) * 100)),
    })),
    currentRung: rung,
    referrals: s.referrals.map((r) => ({
      id: r.id,
      handle: r.handle,
      avatar: r.avatar,
      coinsAwarded: r.coinsAwarded,
      status: r.status,
      weekCoinMined: 0,
      createdAt: r.createdAt,
    })),
  };
}

function withdrawalInfo() {
  const s = load();
  const p = sync();
  const since = Date.now() - 24 * 3600 * 1000;
  const usedToday = s.withdrawals
    .filter((w) => w.status !== "failed" && new Date(w.createdAt).getTime() >= since)
    .reduce((a, w) => a + w.amountNanoTon, 0);
  const quote = quoteWithdrawal(cfg, p.balanceNanoTon);
  const dailyLimit = Math.round(cfg.withdrawDailyLimitTon * NANO);

  return {
    ...quote,
    thresholdTon: cfg.withdrawThresholdTon,
    feePercent: cfg.withdrawFeePercent,
    networkFeeTon: cfg.withdrawNetworkFeeTon,
    vestedPercent: cfg.vestedPercent,
    dailyLimitNanoTon: dailyLimit,
    usedTodayNanoTon: usedToday,
    dailyLimitRemainingNanoTon: Math.max(0, dailyLimit - usedToday),
    walletConnected: !!p.walletAddress,
    proofVerified: !!p.proofVerifiedAt,
    walletAddress: p.walletAddress,
    withdrawalPending: p.withdrawalPending,
    railArmed: false,
    treasuryEvm: cfg.treasureEvmAddress,
    treasuryTon: cfg.treasureTonAddress || null,
    canWithdraw: quote.eligible && !!p.walletAddress && !!p.proofVerifiedAt && !p.withdrawalPending,
  };
}

function adsStatus() {
  const s = load();
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const usedToday = s.adViews.filter((v) => new Date(v.at).getTime() >= startOfDay.getTime()).length;
  return {
    enabled: cfg.adEnabled,
    unitId: cfg.adUnitId,
    link: cfg.adLink,
    rewardCoin: cfg.adRewardCoin,
    dailyLimit: cfg.adDailyLimit,
    watchSeconds: cfg.adWatchSeconds,
    usedToday,
    remaining: Math.max(0, cfg.adDailyLimit - usedToday),
    allTime: s.adViews.length,
  };
}

// ── Mutations ───────────────────────────────────────────────────────────────

function tap(taps: number) {
  const p = sync();
  const now = new Date();
  const result = settleTapBatch(
    cfg,
    {
      energy: p.energy,
      energyUpdatedAt: new Date(p.energyUpdatedAt),
      tapPowerLevel: p.tapPowerLevel,
      itemBoostPercent: p.itemBoostPercent,
      turboUntil: p.turboUntil ? new Date(p.turboUntil) : null,
      comboCount: p.comboCount,
      lastTapAt: p.lastTapAt ? new Date(p.lastTapAt) : null,
      leagueCoinMined: p.totalCoinMined,
      coinCarry: p.coinCarry,
      effects: normalizeEffects(p.itemEffects),
    },
    taps,
    now,
  );

  p.balanceCoin += result.coins;
  p.totalCoinMined += result.coins;
  p.weekCoinMined += result.coins;
  p.totalTaps += result.taps;
  p.energy = result.energy;
  p.energyUpdatedAt = result.energyUpdatedAt.toISOString();
  p.comboCount = result.comboCount;
  p.lastTapAt = result.lastTapAt ? result.lastTapAt.toISOString() : null;
  p.coinCarry = result.coinCarry;
  save();

  return {
    accepted: result.taps,
    coins: result.coins,
    perTap: result.perTap,
    comboMult: result.comboMult,
    leagueMult: result.leagueMult,
    turbo: result.turbo,
    state: buildState(),
  };
}

function booster(kind: "turbo" | "energy" | "recharge") {
  const p = sync();
  const usage = freshBoosterUsage(cfg, p.boostersUsed, p.boosterDayKey, dayKey());
  p.boostersUsed = usage.usage;
  p.boosterDayKey = usage.dayKey;

  const free = (k: "turbo" | "energy" | "recharge") =>
    ({ turbo: cfg.turboFreePerDay, energy: cfg.energyRefillFreePerDay, recharge: cfg.rechargeFreePerDay })[k] -
    usage.usage[k];

  const cost = { turbo: cfg.turboCostCoin, energy: cfg.energyRefillCostCoin, recharge: cfg.rechargeCostCoin }[kind];
  const isFree = free(kind) > 0;
  if (!isFree && p.balanceCoin < cost) throw new Error(`Not enough COIN — this booster costs ${cost}.`);
  if (!isFree) p.balanceCoin -= cost;
  else usage.usage[kind] += 1;

  const effects = normalizeEffects(p.itemEffects);
  if (kind === "turbo") {
    p.turboUntil = new Date(Date.now() + cfg.turboDurationSec * 1000).toISOString();
  } else if (kind === "energy") {
    p.energy = effectiveEnergyCap(cfg, effects);
    p.energyUpdatedAt = new Date().toISOString();
  } else {
    if (p.rechargeReadyAt && new Date(p.rechargeReadyAt) > new Date()) {
      throw new Error("Recharge is still cooling down.");
    }
    p.energy = Math.min(effectiveEnergyCap(cfg, effects), p.energy + cfg.rechargeAmount);
    p.energyUpdatedAt = new Date().toISOString();
    p.rechargeReadyAt = new Date(Date.now() + cfg.rechargeCooldownSec * 1000).toISOString();
  }
  save();
  return buildState();
}

function buyRig(key: string) {
  const p = sync();
  const idx = ["scrap_rig", "steel_rig", "plasma_rig", "quantum_rig"].indexOf(key);
  if (idx < 0) throw new Error("Unknown rig.");
  const rig = cfg.rigs[idx]!;
  if (p.balanceCoin < rig.costCoin) throw new Error("Not enough COIN for that rig.");
  p.balanceCoin -= rig.costCoin;
  p.rigsOwned[key] = Number(p.rigsOwned[key] ?? 0) + 1;
  log("rig_purchase", `Bought ${rig.name}`, -rig.costCoin, 0);
  save();
  return buildState();
}

function upgradeTap() {
  const p = sync();
  if (p.tapPowerLevel >= cfg.tapPowerUpgradeMax) throw new Error("Tap power is already at maximum.");
  if (p.balanceCoin < cfg.tapPowerUpgradeCost) throw new Error("Not enough COIN to upgrade.");
  p.balanceCoin -= cfg.tapPowerUpgradeCost;
  p.tapPowerLevel += 1;
  log("tap_upgrade", `Tap power → level ${p.tapPowerLevel}`, -cfg.tapPowerUpgradeCost, 0);
  save();
  return buildState();
}

function claimStreak() {
  const p = sync();
  if (p.streakClaimedDayKey === dayKey()) throw new Error("Already claimed today — come back tomorrow.");
  const day = p.streakDay || 1;
  const reward = cfg.streakRewards[Math.max(0, day - 1)] ?? 0;
  p.balanceCoin += reward;
  p.totalCoinMined += reward;
  p.weekCoinMined += reward;
  p.streakClaimedDayKey = dayKey();
  p.streakDay = day >= cfg.streakRewards.length ? 1 : day + 1;
  log("streak", `Day ${day} streak reward`, reward, 0);
  save();
  const st = buildState();
  return { ...st, streakClaimed: { day, reward } };
}

function equipItem(category: "skin" | "button", slug: string | null) {
  const s = load();
  const p = sync();
  if (slug) {
    const item = CATALOGUE.find((i) => i.slug === slug);
    if (!item) throw new Error("That item does not exist.");
    if (item.category !== category) throw new Error("That item does not fit this slot.");
    if (!s.owned.includes(slug)) throw new Error("You do not own that item yet.");
  }
  if (category === "skin") p.equippedSkin = slug;
  else p.equippedButton = slug;

  const skinFx = p.equippedSkin
    ? normalizeEffects(CATALOGUE.find((i) => i.slug === p.equippedSkin)?.effects)
    : ZERO_EFFECTS;
  const btnFx = p.equippedButton
    ? normalizeEffects(CATALOGUE.find((i) => i.slug === p.equippedButton)?.effects)
    : ZERO_EFFECTS;
  const combined = combineEffects(skinFx, btnFx);
  p.itemEffects = combined;
  p.itemBoostPercent = combined.tapPercent;
  save();
  return buildState();
}

function purchase(slug: string, rail: "TON" | "STARS" | "COIN") {
  const s = load();
  const p = sync();
  const item = CATALOGUE.find((i) => i.slug === slug);
  if (!item) throw new Error("That item is no longer sold.");
  if (s.owned.includes(slug)) throw new Error("You already own that item.");

  if (rail === "COIN") {
    if (p.balanceCoin < item.coinPrice) throw new Error("Not enough COIN for that item.");
    p.balanceCoin -= item.coinPrice;
    s.owned.push(slug);
    s.purchases.unshift({
      id: uid(),
      itemSlug: slug,
      itemName: item.name,
      tier: item.tier,
      category: item.category,
      priceUsdtCents: item.priceUsdtCents,
      payCurrency: "COIN",
      status: "offchain",
      txHash: null,
      createdAt: new Date().toISOString(),
    });
    log("purchase", `Bought ${item.name} with COIN`, -item.coinPrice, 0);
    save();
    // Buying equips immediately — a purchase that changed nothing is the bug
    // this shop exists to fix.
    const st = equipItem(item.category, slug);
    return { mode: "settled" as const, item: item.name, state: st };
  }

  // TON / STARS: the demo has no treasury key, so the order is recorded as
  // pending and the item is NOT granted. The real server build builds the exact
  // transfer and delivers on confirmation.
  s.purchases.unshift({
    id: uid(),
    itemSlug: slug,
    itemName: item.name,
    tier: item.tier,
    category: item.category,
    priceUsdtCents: item.priceUsdtCents,
    payCurrency: rail,
    status: "pending",
    txHash: null,
    createdAt: new Date().toISOString(),
  });
  log("purchase_pending", `${item.name} — ${rail} order created`, 0, 0);
  save();
  return {
    mode: rail === "STARS" ? ("stars" as const) : ("onchain" as const),
    item: item.name,
    amountStars: Math.round(item.priceUsdtCents / 1.3),
    amountTon: (usdtCentsToNanoTon(cfg, item.priceUsdtCents) / NANO).toFixed(4),
    treasury: cfg.treasureTonAddress || cfg.treasureEvmAddress,
    commentPayload: `order:${slug}`,
    state: buildState(),
  };
}

function confirmPurchase(slug: string, txHash: string) {
  const s = load();
  const item = CATALOGUE.find((i) => i.slug === slug);
  if (!item) throw new Error("Unknown item.");
  const order = s.purchases.find((x) => x.itemSlug === slug && x.status === "pending");
  if (order) {
    order.status = "paid";
    order.txHash = txHash;
  }
  if (!s.owned.includes(slug)) s.owned.push(slug);
  log("purchase", `Bought ${item.name} on-chain`, 0, 0);
  save();
  return equipItem(item.category, slug);
}

function claimOffer(slug: string) {
  const s = load();
  const p = sync();
  const offer = OFFERS.find((o) => o.slug === slug);
  if (!offer) throw new Error("That offer is not available.");
  if (s.claimedOffers.includes(slug)) throw new Error("You have already claimed this.");
  const list = offersList();
  const view = list.offers.find((o) => o.slug === slug);
  if (view && !view.eligible) throw new Error(view.hint || "You are not eligible for this yet.");
  s.claimedOffers.push(slug);
  p.balanceCoin += offer.rewardCoin;
  p.totalCoinMined += offer.rewardCoin;
  p.weekCoinMined += offer.rewardCoin;
  log("task_reward", `Task: ${offer.title}`, offer.rewardCoin, 0);
  save();
  return { rewardCoin: offer.rewardCoin, state: buildState() };
}

function claimRung(name: string) {
  const s = load();
  const p = sync();
  const rung = cfg.referralLadder.find((r) => r.name === name);
  if (!rung) throw new Error("Unknown ladder rung.");
  const active = s.referrals.filter((r) => r.status === "active").length;
  if (active < rung.friends) throw new Error(`You need ${rung.friends} active friends for ${name}.`);
  if (s.claimedRungs.includes(name)) throw new Error("That bonus is already claimed.");
  s.claimedRungs.push(name);
  const nano = Math.round(rung.bonusTon * NANO);
  p.balanceNanoTon += nano;
  log("referral_bonus", `${name} ladder bonus`, 0, nano);
  save();
  return { state: buildState() };
}

function applyCode(code: string) {
  const s = load();
  const p = sync();
  if (p.referralCode === code) throw new Error("You cannot use your own code.");
  if (s.referrals.length > 0) throw new Error("A referral code is already applied.");
  p.referralCode = p.referralCode;
  log("referral_applied", `Applied invite code ${code}`, 0, 0);
  save();
  return { state: buildState() };
}

function watchAd(watchedSeconds: number) {
  const s = load();
  const p = sync();
  if (!cfg.adEnabled) throw new Error("Ads are currently disabled.");
  if (watchedSeconds < cfg.adWatchSeconds) {
    throw new Error(`Watch the full ${cfg.adWatchSeconds}s to earn the reward.`);
  }
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const usedToday = s.adViews.filter((v) => new Date(v.at).getTime() >= startOfDay.getTime()).length;
  if (usedToday >= cfg.adDailyLimit) throw new Error(`That is all ${cfg.adDailyLimit} ad views for today.`);
  s.adViews.push({ at: new Date().toISOString(), rewardCoin: cfg.adRewardCoin });
  p.balanceCoin += cfg.adRewardCoin;
  p.totalCoinMined += cfg.adRewardCoin;
  p.weekCoinMined += cfg.adRewardCoin;
  log("ad_reward", "Ad view reward", cfg.adRewardCoin, 0);
  save();
  return { rewardCoin: cfg.adRewardCoin, state: buildState() };
}

function requestWithdrawal() {
  const s = load();
  const p = sync();
  const info = withdrawalInfo();
  if (!info.canWithdraw) throw new Error("The withdrawal gate is not open yet.");
  const quote = quoteWithdrawal(cfg, p.balanceNanoTon);
  p.balanceNanoTon -= quote.grossNanoTon;
  p.lockedNanoTon += quote.grossNanoTon;
  p.withdrawalPending = true;
  s.withdrawals.unshift({
    id: uid(),
    amountNanoTon: quote.grossNanoTon,
    netNanoTon: quote.netNanoTon,
    feeNanoTon: quote.feeNanoTon,
    payoutAddress: p.walletAddress ?? "",
    status: "pending",
    txHash: null,
    createdAt: new Date().toISOString(),
  });
  log("withdrawal_requested", "Withdrawal requested", 0, -quote.grossNanoTon);
  save();
  return {
    message: "Withdrawal queued. The treasury signs and broadcasts the transfer.",
    railArmed: false,
    transfer: null,
    state: buildState(),
  };
}

function connectWallet(address: string, provider: string) {
  const p = sync();
  p.walletAddress = address;
  p.walletProvider = provider;
  p.proofVerifiedAt = new Date().toISOString();
  p.walletConnectedAt = new Date().toISOString();
  log("wallet_connected", `Wallet verified · ${address.slice(0, 8)}…`, 0, 0);
  save();
  return buildState();
}

function disconnectWallet() {
  const p = sync();
  p.walletAddress = null;
  p.walletProvider = null;
  p.proofVerifiedAt = null;
  p.walletConnectedAt = null;
  save();
  return buildState();
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/** Route a tRPC path to its demo implementation. Unknown paths throw loudly. */
export function handleDemoCall(path: string, input: unknown): unknown {
  const arg = (input ?? {}) as Record<string, unknown>;
  switch (path) {
    // auth — the demo has no server, so any of these simply "sign in".
    case "auth.me":
      return { id: "demo-player", email: "demo@ton-tap-arena.local", name: "Guest Miner", role: "user", authMethod: "guest" };
    case "auth.guest":
    case "auth.login":
    case "auth.signup":
      return { id: "demo-player", email: "demo@ton-tap-arena.local", name: "Guest Miner", role: "user", authMethod: "guest" };
    case "auth.logout":
      return { ok: true };
    case "auth.telegram":
      throw new Error("Telegram sign-in needs the server build — open the game inside Telegram.");

    case "game.bootstrap":
      return { catalogue: true, board: true, state: buildState() };
    case "game.state":
      return buildState();
    case "game.tap":
      return tap(Number(arg.taps ?? 1));
    case "game.booster":
      return booster(arg.kind as "turbo" | "energy" | "recharge");
    case "game.buyRig":
      return buyRig(String(arg.key));
    case "game.upgradeTap":
      return upgradeTap();
    case "game.claimStreak":
      return claimStreak();
    case "game.equipItem":
      return equipItem(arg.category as "skin" | "button", (arg.slug as string | null) ?? null);

    case "shop.list":
      return shopList();
    case "shop.mine":
      return load().purchases;
    case "shop.purchase":
      return purchase(String(arg.slug), arg.rail as "TON" | "STARS" | "COIN");
    case "shop.confirm":
      return confirmPurchase(String(arg.slug), String(arg.txHash ?? "demo"));

    case "leaderboard.weekly":
      return leaderboard();

    case "offers.list":
      return offersList();
    case "offers.claim":
      return claimOffer(String(arg.slug));

    case "referral.summary":
      return referralSummary();
    case "referral.claimRung":
      return claimRung(String(arg.name));
    case "referral.applyCode":
      return applyCode(String(arg.code));

    case "ads.status":
      return adsStatus();
    case "ads.watch":
      return watchAd(Number(arg.watchedSeconds ?? 0));

    case "withdrawal.info":
      return withdrawalInfo();
    case "withdrawal.list":
      return load().withdrawals;
    case "withdrawal.request":
      return requestWithdrawal();

    case "wallet.ledger":
      return load().ledger.slice(0, Number(arg.limit ?? 40));
    case "wallet.nonce":
      return { payload: `demo-${uid()}` };
    case "wallet.verify":
      return connectWallet(String(arg.address ?? "EQDemo"), String(arg.provider ?? "tonconnect"));
    case "wallet.disconnect":
      return disconnectWallet();

    default:
      throw new Error(`The demo build does not implement "${path}".`);
  }
}

/** Wipe the demo save — exposed for a "reset" affordance. */
export function resetDemo(): void {
  state = freshState();
  save();
}
