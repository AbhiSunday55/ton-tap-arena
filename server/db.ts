// ── AGENT-OWNED: business data-access ───────────────────────────────────────
// Raw SQL/ORM lives here so routers stay thin. Every player-scoped query takes
// the owner id and filters on it, so one player can never read or write
// another's rows.
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "./_core/db";
import {
  adViews,
  adminSessions,
  leaderboardSeed,
  ledger,
  offers,
  playerProfiles,
  purchases,
  referrals,
  settings,
  shopItems,
  tapLogs,
  taskCompletions,
  tonProofNonces,
  users,
  withdrawals,
} from "../drizzle/schema";
import { resolveConfig, type GameConfig } from "../shared/game-config";
import { tierEffects } from "../shared/item-effects";

export type Profile = typeof playerProfiles.$inferSelect;
export type ShopItem = typeof shopItems.$inferSelect;
export type Offer = typeof offers.$inferSelect;
export type LedgerRow = typeof ledger.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// Settings / config
// ─────────────────────────────────────────────────────────────────────────────
export async function getConfigOverrides(): Promise<Record<string, unknown>> {
  const rows = await db.select().from(settings);
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function getConfig(): Promise<GameConfig> {
  return resolveConfig(await getConfigOverrides());
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value: value as never, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: value as never, updatedAt: new Date() },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Profiles
// ─────────────────────────────────────────────────────────────────────────────
export function makeReferralCode(userId: string): string {
  return userId.replace(/-/g, "").slice(0, 8);
}

export async function getProfile(userId: string): Promise<Profile | undefined> {
  const [row] = await db
    .select()
    .from(playerProfiles)
    .where(eq(playerProfiles.userId, userId));
  return row;
}

/**
 * Create the profile on first sight, granting the welcome bonus exactly once.
 * `onConflictDoNothing().returning()` returning zero rows IS the "already
 * existed" signal — no read-then-write race, no duplicated bonus.
 */
export async function ensureProfile(input: {
  userId: string;
  handle: string;
  avatar?: string;
  cfg: GameConfig;
  referredBy?: string | null;
  isAdmin?: boolean;
}): Promise<{ profile: Profile; created: boolean }> {
  const NANO = 1_000_000_000;
  const now = new Date();
  const walletAdd = Math.round(input.cfg.startingTon * NANO);

  const [created] = await db
    .insert(playerProfiles)
    .values({
      userId: input.userId,
      handle: input.handle,
      avatar: input.avatar ?? "⛏️",
      balanceCoin: input.cfg.startingCoin,
      balanceNanoTon: walletAdd,
      weekStartAt: now,
      energy: input.cfg.energyCap,
      energyUpdatedAt: now,
      rigAccruedAt: now,
      referralCode: makeReferralCode(input.userId),
      referredBy: input.referredBy ?? null,
      isAdmin: input.isAdmin ?? false,
    })
    .onConflictDoNothing()
    .returning();

  if (!created) {
    const existing = await getProfile(input.userId);
    if (!existing) throw new Error("profile vanished after conflict");
    return { profile: existing, created: false };
  }

  await db.insert(ledger).values({
    userId: input.userId,
    kind: "welcome_bonus",
    deltaCoin: input.cfg.startingCoin,
    deltaNanoTon: walletAdd,
    note: `Welcome bonus — ${input.cfg.startingCoin.toLocaleString("en-US")} COIN + ${input.cfg.startingTon} TON`,
    refType: "system",
  });

  // Bind the referral edge (unique per referee, so a repeat is a no-op).
  if (input.referredBy) {
    try {
      await db
        .insert(referrals)
        .values({ referrerId: input.referredBy, refereeId: input.userId })
        .onConflictDoNothing();
    } catch {
      /* a bad referrer must never block signup */
    }
  }

  return { profile: created, created: true };
}

/**
 * Optimistic-concurrency write. `expectedUpdatedAt` is the version we READ;
 * zero rows back means somebody else wrote first, so the caller recomputes.
 */
export async function updateProfileGuarded(
  userId: string,
  expectedUpdatedAt: Date,
  patch: Partial<typeof playerProfiles.$inferInsert>,
): Promise<Profile[]> {
  return db
    .update(playerProfiles)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(eq(playerProfiles.userId, userId), eq(playerProfiles.updatedAt, expectedUpdatedAt)),
    )
    .returning();
}

/** Unguarded write for admin actions and one-shot pref changes. */
export async function updateProfile(
  userId: string,
  patch: Partial<typeof playerProfiles.$inferInsert>,
): Promise<void> {
  await db
    .update(playerProfiles)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(playerProfiles.userId, userId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger
// ─────────────────────────────────────────────────────────────────────────────
export async function addLedger(entry: typeof ledger.$inferInsert): Promise<void> {
  await db.insert(ledger).values(entry);
}

export async function listLedger(userId: string, limit = 40): Promise<LedgerRow[]> {
  return db
    .select()
    .from(ledger)
    .where(eq(ledger.userId, userId))
    .orderBy(desc(ledger.createdAt))
    .limit(limit);
}

export async function listAllLedger(limit = 100, offset = 0) {
  const rows = await db
    .select({ l: ledger, handle: playerProfiles.handle, email: users.email })
    .from(ledger)
    .leftJoin(playerProfiles, eq(playerProfiles.userId, ledger.userId))
    .leftJoin(users, eq(users.id, ledger.userId))
    .orderBy(desc(ledger.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({ ...r.l, handle: r.handle, email: r.email }));
}

export async function addTapLog(entry: typeof tapLogs.$inferInsert): Promise<void> {
  await db.insert(tapLogs).values(entry);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shop & offers
// ─────────────────────────────────────────────────────────────────────────────
export async function listShopItems(activeOnly = true): Promise<ShopItem[]> {
  const rows = activeOnly
    ? await db.select().from(shopItems).where(eq(shopItems.active, true))
    : await db.select().from(shopItems);
  return rows.sort((a, b) =>
    a.category === b.category
      ? a.tierIndex - b.tierIndex
      : a.category.localeCompare(b.category),
  );
}

export async function listOffers(activeOnly = true): Promise<Offer[]> {
  const rows = activeOnly
    ? await db.select().from(offers).where(eq(offers.active, true))
    : await db.select().from(offers);
  return rows.sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function deleteShopItemBySlug(slug: string): Promise<void> {
  await db.delete(shopItems).where(eq(shopItems.slug, slug));
}

/** Insert-or-update the whole catalogue row (admin editor). */
export async function upsertShopItemSafe(row: {
  slug: string;
  name: string;
  description: string;
  category: "skin" | "button";
  tierIndex: number;
  tier: string;
  priceUsdtCents: number;
  coinPrice: number;
  boostPercent: number;
  imageUrl: string;
  active: boolean;
}): Promise<void> {
  // Effects are DERIVED from (category, tier) rather than taken from the form.
  // That keeps two invariants no matter what an operator types: an item always
  // has a real effect, and a higher tier is always stronger. `boostPercent` is
  // then kept in step with the curve so the legacy column cannot disagree.
  const derived = tierEffects(row.category, row.tierIndex);
  const values = {
    ...row,
    sortOrder: row.tierIndex,
    effects: derived,
    boostPercent: derived.tapPercent,
  };
  await db
    .insert(shopItems)
    .values(values)
    .onConflictDoUpdate({
      target: shopItems.slug,
      set: {
        name: values.name,
        description: values.description,
        category: values.category,
        tierIndex: values.tierIndex,
        tier: values.tier,
        priceUsdtCents: values.priceUsdtCents,
        coinPrice: values.coinPrice,
        boostPercent: values.boostPercent,
        effects: values.effects,
        imageUrl: values.imageUrl,
        active: values.active,
        sortOrder: values.sortOrder,
      },
    });
}

/** Insert-or-update one offer (admin editor). */
export async function upsertOfferSafe(row: {
  slug: string;
  title: string;
  description: string;
  url: string;
  icon: string;
  kind: "channel" | "task" | "ad";
  rule: string;
  ruleValue: number;
  rewardCoin: number;
  bonusTon: number;
  ctaLabel: string;
  active: boolean;
  sortOrder: number;
}): Promise<void> {
  const values = {
    slug: row.slug,
    title: row.title,
    description: row.description,
    url: row.url,
    icon: row.icon,
    kind: row.kind,
    rule: row.rule,
    ruleValue: row.ruleValue,
    rewardCoin: row.rewardCoin,
    bonusNanoTon: Math.round(row.bonusTon * 1_000_000_000),
    ctaLabel: row.ctaLabel,
    active: row.active,
    sortOrder: row.sortOrder,
  };
  await db
    .insert(offers)
    .values(values)
    .onConflictDoUpdate({
      target: offers.slug,
      set: {
        title: values.title,
        description: values.description,
        url: values.url,
        icon: values.icon,
        kind: values.kind,
        rule: values.rule,
        ruleValue: values.ruleValue,
        rewardCoin: values.rewardCoin,
        bonusNanoTon: values.bonusNanoTon,
        ctaLabel: values.ctaLabel,
        active: values.active,
        sortOrder: values.sortOrder,
      },
    });
}

/** Admin: move a withdrawal through its state machine. */
export async function setWithdrawalStatusAdmin(
  id: string,
  patch: { status: string; txHash: string | null; failReason: string | null },
): Promise<void> {
  const [row] = await db.update(withdrawals).set(patch).where(eq(withdrawals.id, id)).returning();
  // A completed or failed payout releases the lock and pays out the balance.
  if (row && (patch.status === "completed" || patch.status === "failed")) {
    await db
      .update(playerProfiles)
      .set({
        withdrawalPending: false,
        lockedNanoTon: sql`greatest(0, ${playerProfiles.lockedNanoTon} - ${Number(row.amountNanoTon)})`,
        updatedAt: new Date(),
      })
      .where(eq(playerProfiles.userId, row.userId));

    if (patch.status === "completed") {
      await db.insert(ledger).values({
        userId: row.userId,
        kind: "withdrawal_completed",
        deltaNanoTon: 0,
        note: `Withdrawal completed${patch.txHash ? ` — tx ${patch.txHash.slice(0, 14)}…` : ""}`,
        refType: "withdrawal",
        refId: row.id,
      });
    } else {
      // Failed: give the money back rather than stranding it in `locked`.
      await db
        .update(playerProfiles)
        .set({
          balanceNanoTon: sql`${playerProfiles.balanceNanoTon} + ${Number(row.amountNanoTon)}`,
          vestedNanoTon: sql`greatest(0, ${playerProfiles.vestedNanoTon} - ${Number(row.vestedNanoTon)})`,
          updatedAt: new Date(),
        })
        .where(eq(playerProfiles.userId, row.userId));
      await db.insert(ledger).values({
        userId: row.userId,
        kind: "withdrawal_refunded",
        deltaNanoTon: Number(row.amountNanoTon),
        note: `Withdrawal failed and was returned — ${patch.failReason ?? "no reason given"}`,
        refType: "withdrawal",
        refId: row.id,
      });
    }
  }
}

/** Admin: unlock a stuck withdrawal without changing its status. */
export async function releaseWithdrawalLock(id: string): Promise<void> {
  const [row] = await db.select().from(withdrawals).where(eq(withdrawals.id, id));
  if (!row) return;
  await db
    .update(playerProfiles)
    .set({ withdrawalPending: false, updatedAt: new Date() })
    .where(eq(playerProfiles.userId, row.userId));
}

export async function deleteOfferBySlug(slug: string): Promise<void> {
  await db.delete(offers).where(eq(offers.slug, slug));
}

// ─────────────────────────────────────────────────────────────────────────────
// Task completions & ad views
// ─────────────────────────────────────────────────────────────────────────────
export async function listTaskCompletions(userId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: taskCompletions.offerSlug })
    .from(taskCompletions)
    .where(eq(taskCompletions.userId, userId));
  return rows.map((r) => r.slug);
}

/** Returns false when this user already claimed this offer. */
export async function claimTask(input: {
  userId: string;
  offerSlug: string;
  rewardCoin: number;
}): Promise<boolean> {
  const [row] = await db
    .insert(taskCompletions)
    .values({ userId: input.userId, offerSlug: input.offerSlug, rewardCoin: input.rewardCoin })
    .onConflictDoNothing()
    .returning();
  return !!row;
}

export async function countAdViewsSince(userId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ id: adViews.id })
    .from(adViews)
    .where(and(eq(adViews.userId, userId), gte(adViews.createdAt, since)));
  return rows.length;
}

export async function addAdView(entry: typeof adViews.$inferInsert): Promise<void> {
  await db.insert(adViews).values(entry);
}

export async function countAllAdViews(): Promise<number> {
  const rows = await db.select({ id: adViews.id }).from(adViews);
  return rows.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Purchases & withdrawals
// ─────────────────────────────────────────────────────────────────────────────
export async function listPurchases(userId: string, limit = 50) {
  return db
    .select()
    .from(purchases)
    .where(eq(purchases.userId, userId))
    .orderBy(desc(purchases.createdAt))
    .limit(limit);
}

export async function listAllPurchases(limit = 100) {
  const rows = await db
    .select({ p: purchases, handle: playerProfiles.handle, email: users.email })
    .from(purchases)
    .leftJoin(playerProfiles, eq(playerProfiles.userId, purchases.userId))
    .leftJoin(users, eq(users.id, purchases.userId))
    .orderBy(desc(purchases.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.p, handle: r.handle, email: r.email }));
}

/**
 * Catalogue rows with an INERT effect record (every stat zero).
 *
 * This is the bootstrap trigger for repairing a catalogue seeded before the
 * effects column existed. Without it, `countShopItems()` stays non-zero after
 * the column is added, the seed never re-runs, and every asset silently keeps a
 * zeroed effect forever — the shop would look healthy while nothing worked.
 *
 * A real item always has at least one non-zero stat, so "all five are zero"
 * reliably means "not yet stamped with a curve". `coalesce` covers both a null
 * column and a jsonb object that predates the keys.
 */
export async function countItemsMissingEffects(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(shopItems)
    .where(
      sql`coalesce((${shopItems.effects}->>'tapPercent')::int, 0) = 0
          and coalesce((${shopItems.effects}->>'energyCapBonus')::int, 0) = 0
          and coalesce((${shopItems.effects}->>'energyRegenPercent')::int, 0) = 0
          and coalesce((${shopItems.effects}->>'comboBonusPercent')::int, 0) = 0
          and coalesce((${shopItems.effects}->>'passivePerHour')::int, 0) = 0`,
    );
  return Number(row?.n ?? 0);
}

export async function ownedItemSlugs(userId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: purchases.itemSlug, status: purchases.status })
    .from(purchases)
    .where(eq(purchases.userId, userId));
  // Only SETTLED orders grant ownership. Counting `pending` here would let a
  // player equip an item whose on-chain payment has not been confirmed — i.e.
  // claim the gameplay bonus for free by walking away from the invoice.
  return rows.filter((r) => SETTLED_PURCHASE_STATUSES.includes(r.status)).map((r) => r.slug);
}

/** Order states that mean "the money actually arrived". */
export const SETTLED_PURCHASE_STATUSES = ["paid", "offchain"];

/** Records the order. `onConflictDoNothing` makes a repeat purchase a no-op. */
export async function createPurchase(row: typeof purchases.$inferInsert): Promise<boolean> {
  const [created] = await db
    .insert(purchases)
    .values(row)
    .onConflictDoNothing()
    .returning();
  return !!created;
}

export async function markPurchase(
  userId: string,
  itemSlug: string,
  patch: { status: string; txHash?: string | null; detail?: string | null },
): Promise<void> {
  await db
    .update(purchases)
    .set(patch)
    .where(and(eq(purchases.userId, userId), eq(purchases.itemSlug, itemSlug)));
}

export async function listWithdrawals(userId: string, limit = 30) {
  return db
    .select()
    .from(withdrawals)
    .where(eq(withdrawals.userId, userId))
    .orderBy(desc(withdrawals.createdAt))
    .limit(limit);
}

export async function listAllWithdrawals(limit = 100) {
  const rows = await db
    .select({ w: withdrawals, handle: playerProfiles.handle, email: users.email })
    .from(withdrawals)
    .leftJoin(playerProfiles, eq(playerProfiles.userId, withdrawals.userId))
    .leftJoin(users, eq(users.id, withdrawals.userId))
    .orderBy(desc(withdrawals.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r.w, handle: r.handle, email: r.email }));
}

export async function insertWithdrawal(row: typeof withdrawals.$inferInsert) {
  const [created] = await db.insert(withdrawals).values(row).returning();
  return created;
}

export async function updateWithdrawal(
  id: string,
  userId: string,
  patch: Partial<typeof withdrawals.$inferInsert>,
): Promise<void> {
  await db
    .update(withdrawals)
    .set(patch)
    .where(and(eq(withdrawals.id, id), eq(withdrawals.userId, userId)));
}

export async function withdrawalsSince(userId: string, since: Date) {
  return db
    .select()
    .from(withdrawals)
    .where(and(eq(withdrawals.userId, userId), gte(withdrawals.createdAt, since)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Referrals
// ─────────────────────────────────────────────────────────────────────────────
export async function listReferrals(referrerId: string) {
  return db
    .select({
      id: referrals.id,
      refereeId: referrals.refereeId,
      coinsAwarded: referrals.coinsAwarded,
      nanoTonAwarded: referrals.nanoTonAwarded,
      status: referrals.status,
      createdAt: referrals.createdAt,
      handle: playerProfiles.handle,
      avatar: playerProfiles.avatar,
      weekCoinMined: playerProfiles.weekCoinMined,
    })
    .from(referrals)
    .leftJoin(playerProfiles, eq(playerProfiles.userId, referrals.refereeId))
    .where(eq(referrals.referrerId, referrerId))
    .orderBy(desc(referrals.createdAt));
}

export async function findReferrerByCode(code: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: playerProfiles.userId })
    .from(playerProfiles)
    .where(eq(playerProfiles.referralCode, code));
  return row?.userId ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Leaderboard — real players ranked by coins mined this week, plus the
// clearly-labelled sample filler so a fresh app is not an empty board.
// ─────────────────────────────────────────────────────────────────────────────
export interface BoardRow {
  rank: number;
  userId: string | null;
  handle: string;
  avatar: string;
  weekCoinMined: number;
  leagueIndex: number;
  isSeed: boolean;
  isYou: boolean;
}

export async function buildLeaderboard(
  cfg: GameConfig,
  viewerId: string,
): Promise<{ rows: BoardRow[]; yourRank: number | null; totalPlayers: number; seedCount: number }> {
  const limit = Math.max(5, Math.min(200, cfg.leaderboardSize));

  const players = await db
    .select({
      userId: playerProfiles.userId,
      handle: playerProfiles.handle,
      avatar: playerProfiles.avatar,
      weekCoinMined: playerProfiles.weekCoinMined,
    })
    .from(playerProfiles)
    .orderBy(desc(playerProfiles.weekCoinMined))
    .limit(limit);

  const seeds = await db
    .select({
      handle: leaderboardSeed.handle,
      avatar: leaderboardSeed.avatar,
      weekCoinMined: leaderboardSeed.weekCoinMined,
      leagueIndex: leaderboardSeed.leagueIndex,
    })
    .from(leaderboardSeed)
    .orderBy(desc(leaderboardSeed.weekCoinMined))
    .limit(limit);

  const leagueIndexFor = (coins: number): number => {
    let idx = 0;
    cfg.leagueThresholds.forEach((t, i) => {
      if (coins >= t) idx = i;
    });
    return idx;
  };

  const merged: Omit<BoardRow, "rank">[] = [
    ...players.map((p) => ({
      userId: p.userId,
      handle: p.handle,
      avatar: p.avatar,
      weekCoinMined: Number(p.weekCoinMined),
      leagueIndex: leagueIndexFor(Number(p.weekCoinMined)),
      isSeed: false,
      isYou: p.userId === viewerId,
    })),
    ...seeds.map((s) => ({
      userId: null,
      handle: s.handle,
      avatar: s.avatar,
      weekCoinMined: Number(s.weekCoinMined),
      leagueIndex: s.leagueIndex,
      isSeed: true,
      isYou: false,
    })),
  ];

  merged.sort((a, b) => b.weekCoinMined - a.weekCoinMined);
  const rows: BoardRow[] = merged.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));

  return {
    rows,
    yourRank: rows.find((r) => r.isYou)?.rank ?? null,
    totalPlayers: merged.length,
    seedCount: seeds.length,
  };
}

export async function seedLeaderboard(
  rows: { handle: string; avatar: string; weekCoinMined: number; leagueIndex: number }[],
): Promise<void> {
  if (!rows.length) return;
  await db.insert(leaderboardSeed).values(rows);
}

export async function clearLeaderboardSeed(): Promise<void> {
  await db.delete(leaderboardSeed);
}

export async function countLeaderboardSeed(): Promise<number> {
  const rows = await db.select({ id: leaderboardSeed.id }).from(leaderboardSeed);
  return rows.length;
}

/** Number of catalogue rows — drives the lazy first-run seed. */
export async function countShopItems(): Promise<number> {
  const rows = await db.select({ id: shopItems.id }).from(shopItems);
  return rows.length;
}

/**
 * Counted separately from the shop on purpose: a seed that throws part-way can
 * leave the shop populated and the offers empty, and a single combined check
 * would then skip the repair forever.
 */
export async function countOffers(): Promise<number> {
  const rows = await db.select({ id: offers.id }).from(offers);
  return rows.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// ton_proof nonces
// ─────────────────────────────────────────────────────────────────────────────
export async function createNonce(nonce: string, payload: string, domain: string): Promise<void> {
  await db
    .insert(tonProofNonces)
    .values({ nonce, payload, domain, expiresAt: new Date(Date.now() + 10 * 60 * 1000) })
    .onConflictDoNothing();
}

/** Atomically burns the nonce. Returns false if unknown, already used or expired. */
export async function burnNonce(nonce: string): Promise<boolean> {
  const [row] = await db
    .update(tonProofNonces)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(tonProofNonces.nonce, nonce),
        sql`${tonProofNonces.usedAt} is null`,
        gte(tonProofNonces.expiresAt, new Date()),
      ),
    )
    .returning();
  return !!row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin sessions
// ─────────────────────────────────────────────────────────────────────────────
export async function createAdminSession(token: string, userId: string | null): Promise<void> {
  await db
    .insert(adminSessions)
    .values({ token, userId, expiresAt: new Date(Date.now() + 12 * 3600 * 1000) });
}

export async function getAdminSession(token: string) {
  const [row] = await db.select().from(adminSessions).where(eq(adminSessions.token, token));
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

export async function deleteAdminSession(token: string): Promise<void> {
  await db.delete(adminSessions).where(eq(adminSessions.token, token));
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin: user directory
// ─────────────────────────────────────────────────────────────────────────────
export async function listUsersForAdmin(limit = 100, offset = 0) {
  const rows = await db
    .select({ u: users, p: playerProfiles })
    .from(users)
    .leftJoin(playerProfiles, eq(playerProfiles.userId, users.id))
    .orderBy(desc(users.createdAt))
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({
    id: r.u.id,
    email: r.u.email,
    name: r.u.name,
    role: r.u.role,
    joinedAt: r.u.createdAt,
    handle: r.p?.handle ?? null,
    avatar: r.p?.avatar ?? null,
    balanceCoin: Number(r.p?.balanceCoin ?? 0),
    balanceNanoTon: Number(r.p?.balanceNanoTon ?? 0),
    totalTaps: Number(r.p?.totalTaps ?? 0),
    weekCoinMined: Number(r.p?.weekCoinMined ?? 0),
    walletAddress: r.p?.walletAddress ?? null,
    isAdmin: r.p?.isAdmin ?? false,
    referredBy: r.p?.referredBy ?? null,
  }));
}

export async function adminAdjustCoins(
  userId: string,
  deltaCoin: number,
  deltaNanoTon: number,
  note: string,
): Promise<void> {
  await db
    .update(playerProfiles)
    .set({
      balanceCoin: sql`greatest(0, ${playerProfiles.balanceCoin} + ${deltaCoin})`,
      balanceNanoTon: sql`greatest(0, ${playerProfiles.balanceNanoTon} + ${deltaNanoTon})`,
      updatedAt: new Date(),
    })
    .where(eq(playerProfiles.userId, userId));

  await db.insert(ledger).values({
    userId,
    kind: "admin_adjustment",
    deltaCoin,
    deltaNanoTon,
    note,
    refType: "admin",
  });
}

export async function adminStats() {
  const [players] = await db.select({ n: sql<number>`count(*)::int` }).from(playerProfiles);
  const [userCount] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  const [taps] = await db
    .select({ n: sql<number>`coalesce(sum(${playerProfiles.totalTaps}),0)::bigint` })
    .from(playerProfiles);
  const [coins] = await db
    .select({ n: sql<number>`coalesce(sum(${playerProfiles.balanceCoin}),0)::bigint` })
    .from(playerProfiles);
  const [ton] = await db
    .select({ n: sql<number>`coalesce(sum(${playerProfiles.balanceNanoTon}),0)::bigint` })
    .from(playerProfiles);
  const [paid] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(purchases)
    .where(inArray(purchases.status, ["paid", "offchain"]));
  const [wds] = await db.select({ n: sql<number>`count(*)::int` }).from(withdrawals);
  return {
    players: Number(players?.n ?? 0),
    accounts: Number(userCount?.n ?? 0),
    totalTaps: Number(taps?.n ?? 0),
    totalCoins: Number(coins?.n ?? 0),
    totalNanoTon: Number(ton?.n ?? 0),
    purchases: Number(paid?.n ?? 0),
    withdrawals: Number(wds?.n ?? 0),
  };
}
