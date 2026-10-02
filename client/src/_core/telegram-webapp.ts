// ── Telegram Mini App bridge ────────────────────────────────────────────────
// Thin, typed access to the SDK Telegram injects into the webview. Everything
// here is READ-ONLY: the client never decides who it is — it forwards the raw
// `initData` string to the server, which verifies the signature before trusting
// a single field of it.

export interface TelegramWebAppLike {
  initData?: string;
  initDataUnsafe?: {
    user?: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
      photo_url?: string;
    };
  };
  colorScheme?: string;
  isExpanded?: boolean;
  ready?: () => void;
  expand?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  HapticFeedback?: {
    impactOccurred?: (style: string) => void;
    notificationOccurred?: (type: string) => void;
  };
}

export function getTelegramWebApp(): TelegramWebAppLike | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Telegram?: { WebApp?: TelegramWebAppLike } }).Telegram?.WebApp;
}

/** The signed payload. Empty string outside Telegram. */
export function getInitData(): string {
  return getTelegramWebApp()?.initData ?? "";
}

/**
 * True only when Telegram actually handed us a signed payload. Checking for the
 * SDK object alone is not enough: the script also loads in a plain browser
 * (where `initData` is empty), and treating that as "inside Telegram" would
 * send an empty payload to the server and fail the login.
 */
export function isInsideTelegram(): boolean {
  return getInitData().length > 0;
}

/**
 * Wait for the SDK to appear. The script is deferred, so on a cold load it can
 * land a few milliseconds after the app module starts. Polls briefly rather
 * than blocking the first paint — the caller runs this in the background.
 */
export async function waitForTelegramWebApp(
  timeoutMs = 2500,
): Promise<TelegramWebAppLike | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const wa = getTelegramWebApp();
    if (wa) return wa;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Adopt Telegram's chrome (full height, matching header/background). */
export function applyTelegramChrome(): void {
  const wa = getTelegramWebApp();
  if (!wa) return;
  try {
    wa.ready?.();
    wa.expand?.();
    wa.setHeaderColor?.("#070b18");
    wa.setBackgroundColor?.("#070b18");
  } catch {
    /* a browser without the SDK is a first-class target too */
  }
}
