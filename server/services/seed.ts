// ── AGENT-OWNED: idempotent seed ────────────────────────────────────────────
// Runs on demand from the admin panel. Every write is onConflictDoNothing, so
// running it twice changes nothing.
import { db } from "../_core/db";
import { offers, shopItems } from "../../drizzle/schema";
import { ASSET, DEFAULT_CONFIG } from "../../shared/game-config";
import { tierPriceCoin, tierPriceUsdtCents } from "../../shared/game-rules";

const TIERS = [
  { index: 0, name: "Common", skin: ASSET.skin.skin_common!, btn: ASSET.btn.btn_common! },
  { index: 1, name: "Rare", skin: ASSET.skin.skin_rare!, btn: ASSET.btn.btn_rare! },
  { index: 2, name: "Epic", skin: ASSET.skin.skin_epic!, btn: ASSET.btn.btn_epic! },
  { index: 3, name: "Legendary", skin: ASSET.skin.skin_legendary!, btn: ASSET.btn.btn_legendary! },
  { index: 4, name: "Mythic", skin: ASSET.skin.skin_mythic!, btn: ASSET.btn.btn_mythic! },
];

const SKIN_NAMES = ["Copper Coin", "Azure Coin", "Violet Coin", "Solar Coin", "Void Coin"];
const SKIN_DESC = [
  "A humble starting coin.",
  "Cobalt plating. +2% tap power.",
  "Amethyst core. +5% tap power.",
  "Forged in gold light. +9% tap power.",
  "A shard of the void itself. +15% tap power.",
];
const SKIN_BOOST = [0, 2, 5, 9, 15];

const BTN_NAMES = ["Basic Pad", "Circuit Pad", "Plasma Pad", "Eclipse Pad", "Celestial Pad"];
const BTN_DESC = [
  "Standard mining control surface.",
  "Etched circuitry. +2% tap power.",
  "Ionised plasma surface. +5% tap power.",
  "Dark-matter coating. +9% tap power.",
  "Blessed by the stars. +15% tap power.",
];

export async function seedCatalogue(): Promise<{ shop: number; offers: number }> {
  const cfg = DEFAULT_CONFIG;
  const shopRows: (typeof shopItems.$inferInsert)[] = [];

  TIERS.forEach((t) => {
    shopRows.push({
      slug: t.skin.replace("/assets/", "").replace(".png", ""),
      name: SKIN_NAMES[t.index]!,
      description: SKIN_DESC[t.index]!,
      category: "skin",
      tierIndex: t.index,
      tier: t.name,
      priceUsdtCents: tierPriceUsdtCents(cfg, t.index),
      coinPrice: tierPriceCoin(cfg, t.index),
      boostPercent: SKIN_BOOST[t.index]!,
      imageUrl: t.skin,
      active: true,
      sortOrder: t.index,
    });
    shopRows.push({
      slug: t.btn.replace("/assets/", "").replace(".png", ""),
      name: BTN_NAMES[t.index]!,
      description: BTN_DESC[t.index]!,
      category: "button",
      tierIndex: t.index,
      tier: t.name,
      priceUsdtCents: tierPriceUsdtCents(cfg, t.index),
      coinPrice: tierPriceCoin(cfg, t.index),
      boostPercent: 0,
      imageUrl: t.btn,
      active: true,
      sortOrder: t.index,
    });
  });

  await db.insert(shopItems).values(shopRows).onConflictDoNothing();

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
