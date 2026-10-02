import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  bigint,
  integer,
  boolean,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ItemEffects } from "../shared/item-effects";

// ═════════════════════════════════════════════════════════════════════════════
// SYSTEM TABLES — managed by the scaffold. The Agent MUST NOT redefine or drop
// the auth columns here; business tables are additive only.
// ═════════════════════════════════════════════════════════════════════════════
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"), // null for SSO-linked users (future)
  name: text("name"),
  role: text("role").notNull().default("user"), // 'user' | 'admin'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * How this account authenticates: 'password' | 'telegram' | 'guest'.
   * ADDITIVE — the scaffold's auth columns above are untouched. Telegram
   * identity itself lives in `telegram_accounts` (one row per linked account),
   * so this table stays the single credential record for every method.
   */
  authMethod: text("auth_method").notNull().default("password"),
});

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    contentType: text("content_type"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("files_owner_idx").on(t.ownerId), index("files_created_idx").on(t.createdAt)],
);

// ═════════════════════════════════════════════════════════════════════════════
// TON TAP ARENA — business tables.
//
// Money is stored in NANOTON as bigint (1 TON = 1_000_000_000 nanoTON) so no
// float ever touches a balance. Coins are bigint too. Every player-owned table
// carries a userId FK and is only ever read through an owner-scoped query.
// ═════════════════════════════════════════════════════════════════════════════

/** One row per player — the whole mutable game state. */
export const playerProfiles = pgTable(
  "player_profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    handle: text("handle").notNull(),
    avatar: text("avatar").notNull().default("⛏️"),

    // ── wallet (TON Connect 2.0) ──
    walletAddress: text("wallet_address"),
    walletProvider: text("wallet_provider"),
    walletPublicKey: text("wallet_public_key"),
    proofVerifiedAt: timestamp("proof_verified_at", { withTimezone: true }),
    walletConnectedAt: timestamp("wallet_connected_at", { withTimezone: true }),

    // ── balances ──
    balanceCoin: bigint("balance_coin", { mode: "number" }).notNull().default(0),
    balanceNanoTon: bigint("balance_nano_ton", { mode: "number" }).notNull().default(0),
    vestedNanoTon: bigint("vested_nano_ton", { mode: "number" }).notNull().default(0),
    lockedNanoTon: bigint("locked_nano_ton", { mode: "number" }).notNull().default(0),

    // ── mining ──
    totalTaps: bigint("total_taps", { mode: "number" }).notNull().default(0),
    totalCoinMined: bigint("total_coin_mined", { mode: "number" }).notNull().default(0),
    weekCoinMined: bigint("week_coin_mined", { mode: "number" }).notNull().default(0),
    weekStartAt: timestamp("week_start_at", { withTimezone: true }).notNull().defaultNow(),
    energy: integer("energy").notNull().default(1000),
    energyUpdatedAt: timestamp("energy_updated_at", { withTimezone: true }).notNull().defaultNow(),
    tapPowerLevel: integer("tap_power_level").notNull().default(1),
    rigsOwned: jsonb("rigs_owned").notNull().default([]),
    rigAccruedAt: timestamp("rig_accrued_at", { withTimezone: true }).notNull().defaultNow(),
    itemBoostPercent: integer("item_boost_percent").notNull().default(0),
    /**
     * The equipped skin + button effects, COMBINED and cached at equip time.
     * This is the record every reward calculation reads; `shared/item-effects.ts`
     * owns its shape. It is derived from owned rows on the server, never sent up
     * by a client — that is what makes a shop bonus un-fakeable.
     */
    itemEffects: jsonb("item_effects")
      .$type<ItemEffects>()
      .notNull()
      .default({ tapPercent: 0, energyCapBonus: 0, energyRegenPercent: 0, comboBonusPercent: 0, passivePerHour: 0 }),
    comboCount: integer("combo_count").notNull().default(0),
    /**
     * Sub-coin fraction left over from the last tap batch, carried forward.
     * Stored as micro-COIN (1e-6) in an integer so the arithmetic stays exact —
     * this is what makes a +3% or +16% skin actually pay instead of rounding to
     * nothing tap after tap.
     */
    coinCarryMicro: integer("coin_carry_micro").notNull().default(0),
    lastTapAt: timestamp("last_tap_at", { withTimezone: true }),
    turboUntil: timestamp("turbo_until", { withTimezone: true }),
    boosterDayKey: text("booster_day_key"),
    boostersUsed: jsonb("boosters_used").notNull().default({ turbo: 0, energy: 0, recharge: 0 }),
    rechargeReadyAt: timestamp("recharge_ready_at", { withTimezone: true }),

    // ── streak ──
    streakDay: integer("streak_day").notNull().default(0),
    streakClaimedDayKey: text("streak_claimed_day_key"),

    // ── referrals ──
    referralCode: text("referral_code").notNull(),
    referredBy: uuid("referred_by"),
    referralPremium: boolean("referral_premium").notNull().default(false),

    // ── cosmetics / prefs ──
    equippedSkin: text("equipped_skin").notNull().default("skin_common"),
    equippedButton: text("equipped_button").notNull().default("btn_common"),
    soundEnabled: boolean("sound_enabled").notNull().default(true),

    // ── flags ──
    isAdmin: boolean("is_admin").notNull().default(false),
    isSeed: boolean("is_seed").notNull().default(false),
    withdrawalPending: boolean("withdrawal_pending").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("player_profiles_referral_code_idx").on(t.referralCode),
    index("player_profiles_week_idx").on(t.weekCoinMined),
    index("player_profiles_created_idx").on(t.createdAt),
  ],
);

/** Admin overrides layered on top of the code defaults in shared/game-config.ts. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Shop catalogue — admin CRUD. */
export const shopItems = pgTable(
  "shop_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull(), // 'skin' | 'button'
    tierIndex: integer("tier_index").notNull().default(0),
    tier: text("tier").notNull().default("Common"),
    /** Real gameplay effect this item grants while equipped. */
    effects: jsonb("effects")
      .$type<ItemEffects>()
      .notNull()
      .default({ tapPercent: 0, energyCapBonus: 0, energyRegenPercent: 0, comboBonusPercent: 0, passivePerHour: 0 }),
    priceUsdtCents: integer("price_usdt_cents").notNull().default(50),
    coinPrice: bigint("coin_price", { mode: "number" }).notNull().default(0),
    boostPercent: integer("boost_percent").notNull().default(0),
    imageUrl: text("image_url").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shop_items_slug_idx").on(t.slug),
    index("shop_items_category_idx").on(t.category, t.tierIndex),
  ],
);

/** Offers, tasks and ad slots — admin CRUD. */
export const offers = pgTable(
  "offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    url: text("url").notNull().default(""),
    icon: text("icon").notNull().default("🎯"),
    kind: text("kind").notNull().default("task"), // 'channel' | 'task' | 'ad'
    /**
     * How the server decides a task is genuinely done. `manual` is the
     * open-the-link-and-claim flow every tap game uses for Telegram channels
     * (client-attested); every other rule is checked server-side against real
     * player state, so the reward cannot be claimed by just calling the API.
     *   manual | wallet | purchase | withdrawal | ad | referrals | league
     */
    rule: text("rule").notNull().default("manual"),
    ruleValue: integer("rule_value").notNull().default(0),
    rewardCoin: bigint("reward_coin", { mode: "number" }).notNull().default(0),
    bonusNanoTon: bigint("bonus_nano_ton", { mode: "number" }).notNull().default(0),
    ctaLabel: text("cta_label").notNull().default("Claim"),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("offers_slug_idx").on(t.slug), index("offers_active_idx").on(t.active)],
);

/** Append-only coin/TON ledger. Never updated, never deleted. */
export const ledger = pgTable(
  "ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    deltaCoin: bigint("delta_coin", { mode: "number" }).notNull().default(0),
    deltaNanoTon: bigint("delta_nano_ton", { mode: "number" }).notNull().default(0),
    note: text("note").notNull().default(""),
    refType: text("ref_type"),
    refId: text("ref_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ledger_user_idx").on(t.userId, t.createdAt)],
);

export const tapLogs = pgTable(
  "tap_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taps: integer("taps").notNull(),
    coinsEarned: bigint("coins_earned", { mode: "number" }).notNull(),
    multiplierBp: integer("multiplier_bp").notNull().default(10000),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tap_logs_user_idx").on(t.userId, t.createdAt)],
);

export const referrals = pgTable(
  "referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referrerId: uuid("referrer_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refereeId: uuid("referee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    coinsAwarded: bigint("coins_awarded", { mode: "number" }).notNull().default(0),
    nanoTonAwarded: bigint("nano_ton_awarded", { mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("active"), // 'pending' | 'active' | 'reversed'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("referrals_referee_idx").on(t.refereeId),
    index("referrals_referrer_idx").on(t.referrerId),
  ],
);

export const purchases = pgTable(
  "purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    itemSlug: text("item_slug").notNull(),
    itemName: text("item_name").notNull(),
    category: text("category").notNull(),
    tier: text("tier").notNull(),
    priceUsdtCents: integer("price_usdt_cents").notNull(),
    payCurrency: text("pay_currency").notNull().default("TON"), // TON | STARS | COIN
    amountNanoTon: bigint("amount_nano_ton", { mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("pending"), // pending | paid | offchain | failed
    txHash: text("tx_hash"),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("purchases_user_idx").on(t.userId, t.createdAt),
    uniqueIndex("purchases_user_item_idx").on(t.userId, t.itemSlug),
  ],
);

export const withdrawals = pgTable(
  "withdrawals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    amountNanoTon: bigint("amount_nano_ton", { mode: "number" }).notNull(),
    feeNanoTon: bigint("fee_nano_ton", { mode: "number" }).notNull().default(0),
    networkFeeNanoTon: bigint("network_fee_nano_ton", { mode: "number" }).notNull().default(0),
    netNanoTon: bigint("net_nano_ton", { mode: "number" }).notNull().default(0),
    vestedNanoTon: bigint("vested_nano_ton", { mode: "number" }).notNull().default(0),
    payoutAddress: text("payout_address").notNull(),
    status: text("status").notNull().default("pending"), // pending|processing|completed|failed
    txHash: text("tx_hash"),
    failReason: text("fail_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("withdrawals_user_idx").on(t.userId, t.createdAt)],
);

export const taskCompletions = pgTable(
  "task_completions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    offerSlug: text("offer_slug").notNull(),
    rewardCoin: bigint("reward_coin", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("task_completions_user_offer_idx").on(t.userId, t.offerSlug),
    index("task_completions_user_idx").on(t.userId),
  ],
);

export const adViews = pgTable(
  "ad_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rewardCoin: bigint("reward_coin", { mode: "number" }).notNull().default(0),
    adUnitId: text("ad_unit_id").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ad_views_user_idx").on(t.userId, t.createdAt)],
);

/** Single-use nonces for TON Connect ton_proof. */
export const tonProofNonces = pgTable(
  "ton_proof_nonces",
  {
    nonce: text("nonce").primaryKey(),
    payload: text("payload").notNull().default(""),
    domain: text("domain").notNull().default(""),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("ton_proof_nonces_expires_idx").on(t.expiresAt)],
);

/**
 * Telegram Mini App identity. One row per Telegram account that has signed in
 * through the bot, linked to the real `users` row it authenticates.
 *
 * `telegramId` is stored as TEXT, not bigint: Telegram user ids are 64-bit and
 * already exceed the range a JS number represents exactly, so keeping them as
 * strings is the only way to compare them without silent precision loss.
 *
 * The UNIQUE index on `telegramId` is what makes sign-in idempotent — a second
 * visit from the same Telegram account resolves to the same player instead of
 * minting a duplicate.
 */
export const telegramAccounts = pgTable(
  "telegram_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    telegramId: text("telegram_id").notNull(),
    username: text("username"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    languageCode: text("language_code"),
    isPremium: boolean("is_premium").notNull().default(false),
    allowsWriteToPm: boolean("allows_write_to_pm").notNull().default(false),
    photoUrl: text("photo_url"),
    /** `auth_date` from the validated initData — when Telegram signed it. */
    authDate: timestamp("auth_date", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("telegram_accounts_tg_idx").on(t.telegramId),
    uniqueIndex("telegram_accounts_user_idx").on(t.userId),
  ],
);

/** Admin panel sessions — separate from the player session cookie. */
export const adminSessions = pgTable(
  "admin_sessions",
  {
    token: text("token").primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("admin_sessions_expires_idx").on(t.expiresAt)],
);

/**
 * Demo leaderboard filler. Kept OUT of `playerProfiles` on purpose: those rows
 * would need a `users` row to satisfy the FK, and the `users` table belongs to
 * auth. These are clearly-labelled sample players so a brand-new app does not
 * show an empty board; the admin can clear them in one click.
 */
export const leaderboardSeed = pgTable(
  "leaderboard_seed",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    handle: text("handle").notNull(),
    avatar: text("avatar").notNull().default("⛏️"),
    weekCoinMined: bigint("week_coin_mined", { mode: "number" }).notNull().default(0),
    leagueIndex: integer("league_index").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("leaderboard_seed_week_idx").on(t.weekCoinMined)],
);
