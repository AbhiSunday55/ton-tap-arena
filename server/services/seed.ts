// ── AGENT-OWNED: idempotent seed ────────────────────────────────────────────
// Runs on demand from the admin panel. Offers are inserted with
// onConflictDoNothing (a second run changes nothing); shop rows upsert their
// DERIVED columns so a re-run also repairs items whose effects are missing.
import { db } from "../_core/db";
import { sql } from "drizzle-orm";
import { offers, shopItems } from "../../drizzle/schema";
import { ASSET, DEFAULT_CONFIG } from "../../shared/game-config";
import { effectChips, tierEffects } from "../../shared/item-effects";
import { tierPriceCoin, tierPriceUsdtCents } from "../../shared/game-rules";

const TIERS = [
  { index: 0, name: "Common", skin: ASSET.skin.skin_common!, btn: ASSET.btn.btn_common! },
  { index: 1, name: "Rare", skin: ASSET.skin.skin_rare!, btn: ASSET.btn.btn_rare! },
  { index: 2, name: "Epic", skin: ASSET.skin.skin_epic!, btn: ASSET.btn.btn_epic! },
  { index: 3, name: "Legendary", skin: ASSET.skin.skin_legendary!, btn: ASSET.btn.btn_legendary! },
  { index: 4, name: "Mythic", skin: ASSET.skin.skin_mythic!, btn: ASSET.btn.btn_mythic! },
];

const SKIN_NAMES = ["Copper Coin", "Azure Coin", "Violet Coin", "Solar Coin", "Void Coin"];
const BTN_NAMES = ["Basic Pad", "Circuit Pad", "Plasma Pad", "Eclipse Pad", "Celestial Pad"];

/**
 * Descriptions are DERIVED from the item's real effect record rather than
 * hand-written, so a card can never advertise a bonus the server does not
 * enforce. Change a tier curve and the copy follows automatically.
 */
function describe(category: "skin" | "button", index: number, flavor: string): string {
  const chips = effectChips(tierEffects(category, index));
  return chips.length ? `${flavor} ${chips.join(" · ")}.` : flavor;
}

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


export async function seedCatalogue(): Promise<{ shop: number; offers: number }> {
  const cfg = DEFAULT_CONFIG;
  const shopRows: (typeof shopItems.$inferInsert)[] = [];

  TIERS.forEach((t) => {
    const skinEffects = tierEffects("skin", t.index);
    const btnEffects = tierEffects("button", t.index);
    shopRows.push({
      slug: t.skin.replace("/assets/", "").replace(".png", ""),
      name: SKIN_NAMES[t.index]!,
      description: describe("skin", t.index, SKIN_FLAVOR[t.index]!),
      category: "skin",
      tierIndex: t.index,
      tier: t.name,
      effects: skinEffects,
      priceUsdtCents: tierPriceUsdtCents(cfg, t.index),
      coinPrice: tierPriceCoin(cfg, t.index),
      boostPercent: skinEffects.tapPercent,
      imageUrl: t.skin,
      active: true,
      sortOrder: t.index,
    });
    shopRows.push({
      slug: t.btn.replace("/assets/", "").replace(".png", ""),
      name: BTN_NAMES[t.index]!,
      description: describe("button", t.index, BTN_FLAVOR[t.index]!),
      category: "button",
      tierIndex: t.index,
      tier: t.name,
      effects: btnEffects,
      priceUsdtCents: tierPriceUsdtCents(cfg, t.index),
      coinPrice: tierPriceCoin(cfg, t.index),
      boostPercent: btnEffects.tapPercent,
      imageUrl: t.btn,
      active: true,
      sortOrder: t.index,
    });
  });

  // One row at a time, so a RE-RUN repairs items that predate the effects
  // column. A plain `onConflictDoNothing` batch would leave a catalogue already
  // in the database with all-zero effects forever — the seed would report
  // success while every asset stayed inert.
  //
  // Only the DERIVED columns are refreshed on conflict (description, effects,
  // boostPercent, tier). Name, image and price are left alone so an admin's own
  // edits survive a re-seed.
  for (const row of shopRows) {
    await db
      .insert(shopItems)
      .values(row)
      .onConflictDoUpdate({
        target: shopItems.slug,
        set: {
          description: sql`excluded.description`,
          effects: sql`excluded.effects`,
          boostPercent: sql`excluded.boost_percent`,
          tierIndex: sql`excluded.tier_index`,
          tier: sql`excluded.tier`,
        },
      });
  }

  const offerRows: (typeof offers.$inferInsert)[] = [
    {
      slug: "channel-myduck",
      title: "Join MyDuck on Telegram",
      description: "Join the MyDuck channel to unlock your reward.",
      url: "https://t.me/myduck?start=r581731ebec1cdae",
      icon: "🦆",
      kind: "channel",
      rule: "manual",
      rewardCoin: 25_000,
      ctaLabel: "Join, then claim",
      active: true,
      sortOrder: 1,
    },
    {
      slug: "channel-totalhash",
      title: "Open the TotalHash bot",
      description: "Start the TotalHash bot to unlock your reward.",
      url: "https://t.me/totalhashbot/start?startapp=954512685",
      icon: "🤖",
      kind: "channel",
      rule: "manual",
      rewardCoin: 25_000,
      ctaLabel: "Open, then claim",
      active: true,
      sortOrder: 2,
    },
    {
      slug: "follow-x",
      title: "Follow us on X",
      description: "Follow the official account for announcements.",
      url: "https://x.com/",
      icon: "𝕏",
      kind: "task",
      rule: "manual",
      rewardCoin: 10_000,
      ctaLabel: "Open, then claim",
      active: true,
      sortOrder: 3,
    },
    {
      slug: "invite-1-friend",
      title: "Invite 1 friend",
      description: "Share your referral link and get your first signup.",
      url: "",
      icon: "👥",
      kind: "task",
      rule: "referrals",
      ruleValue: 1,
      rewardCoin: 15_000,
      ctaLabel: "Claim",
      active: true,
      sortOrder: 4,
    },
    {
      slug: "invite-5-friends",
      title: "Invite 5 friends",
      description: "Build a squad of five.",
      url: "",
      icon: "🔥",
      kind: "task",
      rule: "referrals",
      ruleValue: 5,
      rewardCoin: 100_000,
      ctaLabel: "Claim",
      active: true,
      sortOrder: 5,
    },
    {
      slug: "connect-wallet",
      title: "Connect your TON wallet",
      description: "Verify a wallet to enable withdrawals.",
      url: "",
      icon: "👛",
      kind: "task",
      rule: "wallet",
      rewardCoin: 20_000,
      ctaLabel: "Claim",
      active: true,
      sortOrder: 6,
    },
    {
      slug: "first-purchase",
      title: "Make your first purchase",
      description: "Buy anything from the shop.",
      url: "",
      icon: "🛍️",
      kind: "task",
      rule: "purchase",
      rewardCoin: 50_000,
      ctaLabel: "Claim",
      active: true,
      sortOrder: 7,
    },
    {
      slug: "first-withdrawal",
      title: "Complete a withdrawal",
      description: "Reach the threshold and cash out.",
      url: "",
      icon: "🏦",
      kind: "task",
      rule: "withdrawal",
      rewardCoin: 250_000,
      ctaLabel: "Claim",
      active: true,
      sortOrder: 8,
    },
    {
      slug: "watch-3-ads",
      title: "Watch 3 ads",
      description: "Sit through three ad views.",
      url: "",
      icon: "📺",
      kind: "task",
      rule: "ad",
      ruleValue: 3,
      rewardCoin: 30_000,
      ctaLabel: "Claim",
      active: true,
      sortOrder: 9,
    },
    {
      slug: "reach-silver",
      title: "Reach Silver league",
      description: "Mine 50,000 coins in total.",
      url: "",
      icon: "🥈",
      kind: "task",
      rule: "league",
      ruleValue: 1,
      rewardCoin: 75_000,
      ctaLabel: "Claim",
      active: true,
      sortOrder: 10,
    },
  ];

  await db.insert(offers).values(offerRows).onConflictDoNothing();
  return { shop: shopRows.length, offers: offerRows.length };
}
