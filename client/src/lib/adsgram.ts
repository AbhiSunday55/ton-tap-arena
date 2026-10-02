// ─────────────────────────────────────────────────────────────────────────────
// Adsgram rewarded-ad bridge.
//
// Adsgram serves rewarded video inside a Telegram Mini App. The SDK is loaded
// LAZILY — only when a player actually asks for an ad — so it never touches the
// login path or the first paint.
//
// ── Why the ad cannot play outside Telegram ──────────────────────────────────
// Adsgram picks a creative from the Telegram user context (`initData`). Opened
// in a plain browser or on a static host there is no `initData`, so the SDK has
// nothing to serve and `show()` rejects. That is a property of the ad network,
// not a bug in this integration — so the UI detects it up front and says so
// plainly instead of failing silently.
// ─────────────────────────────────────────────────────────────────────────────

const SDK_SRC = "https://sad.adsgram.ai/js/sad.min.js";

/** The subset of the Adsgram SDK surface this app uses. */
interface AdController {
  show: () => Promise<ShowResult>;
}

interface ShowResult {
  error?: boolean;
  done?: boolean;
  description?: string;
  [k: string]: unknown;
}

interface AdsgramGlobal {
  init: (opts: { blockId: string; debug?: boolean; debugBannerType?: string }) => AdController;
}

declare global {
  interface Window {
    Adsgram?: AdsgramGlobal;
    Telegram?: {
      WebApp?: {
        initData?: string;
        ready?: () => void;
        expand?: () => void;
      };
    };
  }
}

/**
 * True only inside a real Telegram Mini App launch.
 *
 * `initData` is the discriminator, not the presence of `window.Telegram` — the
 * SDK script is loaded on every page, so `window.Telegram.WebApp` exists in a
 * plain browser too, but with an EMPTY `initData`. Checking the object alone
 * would wrongly report "inside Telegram" and then fail at `show()`.
 */
export function isTelegramMiniApp(): boolean {
  try {
    const data = window.Telegram?.WebApp?.initData;
    return typeof data === "string" && data.length > 0;
  } catch {
    return false;
  }
}

let sdkPromise: Promise<AdsgramGlobal> | null = null;

/** Inject the SDK once and resolve when `window.Adsgram` is usable. */
export function loadAdsgramSdk(): Promise<AdsgramGlobal> {
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<AdsgramGlobal>((resolve, reject) => {
    if (window.Adsgram) {
      resolve(window.Adsgram);
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SDK_SRC}"]`);
    const script = existing ?? document.createElement("script");
    let settled = false;

    const done = () => {
      if (settled) return;
      settled = true;
      if (window.Adsgram) resolve(window.Adsgram);
      else reject(new Error("The ad service loaded but did not initialise."));
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      // A failed load must not poison the cache — a later tap retries.
      sdkPromise = null;
      reject(new Error("Could not reach the ad service. Check your connection and try again."));
    };

    script.addEventListener("load", done);
    script.addEventListener("error", fail);

    if (!existing) {
      script.src = SDK_SRC;
      script.async = true;
      document.head.appendChild(script);
    }

    // The SDK is a small bundle, but a hung request must not leave the button
    // spinning forever.
    window.setTimeout(() => {
      if (window.Adsgram) done();
      else fail();
    }, 12_000);
  });

  return sdkPromise;
}

/**
 * Controllers are cached per block ID. Adsgram documents that `init` is
 * idempotent for a given block and returns the same controller, but holding the
 * reference ourselves keeps `show()` off the init path on every tap.
 */
const controllers = new Map<string, AdController>();

async function getController(blockId: string): Promise<AdController> {
  const cached = controllers.get(blockId);
  if (cached) return cached;
  const sdk = await loadAdsgramSdk();
  const controller = sdk.init({ blockId });
  controllers.set(blockId, controller);
  return controller;
}

export type AdOutcome =
  | { ok: true }
  | { ok: false; reason: "not_telegram" | "no_block" | "no_fill" | "skipped" | "error"; message: string };

/** Turn an Adsgram rejection into something a player can act on. */
function describe(result: ShowResult | undefined): AdOutcome {
  const raw = String(result?.description ?? "").toLowerCase();

  // Low fill for the player's geo/block is the most common launch-time result,
  // and it is NOT a code fault — say so rather than implying the game is broken.
  if (raw.includes("not found") || raw.includes("no banner") || raw.includes("no ad")) {
    return {
      ok: false,
      reason: "no_fill",
      message: "No ad is available for you right now. Please try again in a little while.",
    };
  }
  if (raw.includes("too long") || raw.includes("non stop") || raw.includes("nonstop")) {
    return {
      ok: false,
      reason: "error",
      message: "You have watched a lot of ads in a row. Take a short break and try again.",
    };
  }
  if (raw.includes("skip") || raw.includes("close")) {
    return { ok: false, reason: "skipped", message: "Ad closed early — no reward this time." };
  }
  return {
    ok: false,
    reason: "error",
    message: result?.description
      ? `The ad could not be played (${result.description}).`
      : "The ad could not be played. Please try again.",
  };
}

/**
 * Play a rewarded ad and resolve with whether the player earned the reward.
 *
 * The reward is granted ONLY on the resolved path — Adsgram resolves `show()`
 * when the ad was watched to the end, and rejects on skip, close or error. The
 * caller must not grant anything on `ok: false`.
 */
export async function showRewardedAd(blockId: string): Promise<AdOutcome> {
  if (!blockId) {
    return { ok: false, reason: "no_block", message: "No ad block is configured yet." };
  }
  if (!isTelegramMiniApp()) {
    return {
      ok: false,
      reason: "not_telegram",
      message: "Ads only play inside the Telegram Mini App. Open the game from the bot to watch ads.",
    };
  }

  try {
    const controller = await getController(blockId);
    const result = await controller.show();
    // A resolved promise with `error: true` still means no reward.
    if (result && result.error) return describe(result);
    return { ok: true };
  } catch (e) {
    return describe(e as ShowResult);
  }
}
