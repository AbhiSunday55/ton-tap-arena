/**
 * Asset helpers. Shop slugs are asset basenames (`btn_rare` → `/assets/btn_rare.png`),
 * so the equipped skin/button can be rendered from the profile alone without
 * waiting for the catalogue query.
 *
 * ── Why every path goes through `asset()` ───────────────────────────────────
 * The app ships to two different mount points: the platform serves it from the
 * root (`/assets/coin.png`), while GitHub Pages serves it from a repo subpath
 * (`/ton-tap-arena/assets/coin.png`). A hardcoded leading slash resolves against
 * the DOMAIN, not the app, so on Pages every image 404s and the game renders
 * with broken-image placeholders. Prefixing with Vite's `BASE_URL` makes the
 * same build work at both mount points.
 */
function base(): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  const b = env?.BASE_URL ?? "/";
  return b.endsWith("/") ? b : `${b}/`;
}

/** Resolve an app-relative asset path against the current mount point. */
export function asset(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${base()}${path.replace(/^\/+/, "")}`;
}

const FALLBACK_BUTTON = "assets/tap.png";
const FALLBACK_SKIN = "assets/coin.png";

export function assetFor(slug: string | null | undefined, kind: "skin" | "button"): string {
  if (!slug) return asset(kind === "skin" ? FALLBACK_SKIN : FALLBACK_BUTTON);
  if (slug.startsWith("http")) return slug;
  // An already-resolved path (from the server catalogue) is passed through.
  if (slug.startsWith("/") || slug.startsWith("assets/")) return asset(slug);
  return asset(`assets/${slug}.png`);
}

export function skinImage(slug: string | null | undefined): string {
  return assetFor(slug, "skin");
}

export function buttonImage(slug: string | null | undefined): string {
  return assetFor(slug, "button");
}

export const COIN_IMG = asset("assets/coin.png");
export const TAP_IMG = asset("assets/tap.png");
export const AD_CHEST_IMG = asset("assets/ad_chest.png");
