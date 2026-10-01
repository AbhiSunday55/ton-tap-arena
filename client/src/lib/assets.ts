/**
 * Asset helpers. Shop slugs are asset basenames (`btn_rare` → `/assets/btn_rare.png`),
 * so the equipped skin/button can be rendered from the profile alone without
 * waiting for the catalogue query.
 */
const FALLBACK_BUTTON = "/assets/tap.png";
const FALLBACK_SKIN = "/assets/coin.png";

export function assetFor(slug: string | null | undefined, kind: "skin" | "button"): string {
  if (!slug) return kind === "skin" ? FALLBACK_SKIN : FALLBACK_BUTTON;
  if (slug.startsWith("/") || slug.startsWith("http")) return slug;
  return `/assets/${slug}.png`;
}

export function skinImage(slug: string | null | undefined): string {
  return assetFor(slug, "skin");
}

export function buttonImage(slug: string | null | undefined): string {
  return assetFor(slug, "button");
}

export const COIN_IMG = "/assets/coin.png";
export const TAP_IMG = "/assets/tap.png";
export const AD_CHEST_IMG = "/assets/ad_chest.png";
