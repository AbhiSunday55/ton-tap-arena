import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { trpc, IS_DEMO } from "./trpc";
import type { SessionUser } from "@shared/types";
import { requestStorageAccessIfEmbedded } from "./storage-access";
import { getInitData, isInsideTelegram, waitForTelegramWebApp } from "./telegram-webapp";

// Frontend auth seam. Wraps the tRPC auth router so pages consume a single
// `useAuth()` — they never see the session mechanism (cookie/JWT/SSO). Mirrors
// the server AuthProvider abstraction (DESIGN §5.1).
//
// ── Why this is non-blocking ────────────────────────────────────────────────
// The old shape awaited `auth.me` before rendering anything, so the login screen
// could not paint until a network round trip finished. Now the session is read
// SYNCHRONOUSLY from a local cache on the first render, so a returning player
// gets the game immediately and a new visitor gets the login form immediately.
// The server check still runs — in the background — and corrects the cache when
// it answers. `isLoading` is therefore always false; `checking` reports the
// background work for a subtle indicator.
interface AuthContextValue {
  user: SessionUser | null;
  /** Always false — kept so existing callers keep compiling. */
  isLoading: boolean;
  /** True while the background session check is in flight. */
  checking: boolean;
  /** True when Telegram handed us a signed payload (i.e. a real Mini App). */
  inTelegram: boolean;
  /** Set when a Telegram sign-in attempt failed, for the UI to surface. */
  telegramError: string | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, name?: string) => Promise<void>;
  loginWithTelegram: () => Promise<void>;
  loginAsGuest: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const CACHE_KEY = "tta.session.user";

/**
 * The identity the static demo build runs as. GitHub Pages has no server to
 * authenticate against, so the demo is always "signed in" as a local guest —
 * which is what makes the published site immediately playable.
 */
const DEMO_USER: SessionUser = {
  id: "demo-player",
  email: "demo@ton-tap-arena.local",
  name: "Guest Miner",
  role: "user",
  authMethod: "guest",
};

/** Read the cached identity synchronously. Never throws (private mode, etc.). */
function readCachedUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionUser;
    return parsed && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedUser(user: SessionUser | null): void {
  try {
    if (user) localStorage.setItem(CACHE_KEY, JSON.stringify(user));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    /* storage unavailable — the server session still works */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const utils = trpc.useUtils();
  const loginM = trpc.auth.login.useMutation();
  const signupM = trpc.auth.signup.useMutation();
  const logoutM = trpc.auth.logout.useMutation();
  const telegramM = trpc.auth.telegram.useMutation();
  const guestM = trpc.auth.guest.useMutation();

  // Seeded from cache → the first render already knows who the player is.
  // In the static demo build there is no session to resolve, so it starts
  // signed in and the game paints on the very first frame.
  const [user, setUser] = useState<SessionUser | null>(() => readCachedUser() ?? (IS_DEMO ? DEMO_USER : null));
  const [checking, setChecking] = useState(true);
  const [inTelegram, setInTelegram] = useState(() => isInsideTelegram());
  const [telegramError, setTelegramError] = useState<string | null>(null);
  const ranRef = useRef(false);

  const persist = useCallback((next: SessionUser | null) => {
    setUser(next);
    writeCachedUser(next);
  }, []);

  const loginWithTelegram = useCallback(async () => {
    const initData = getInitData();
    if (!initData) throw new Error("Not running inside Telegram.");
    const next = await telegramM.mutateAsync({ initData });
    persist(next);
    setTelegramError(null);
  }, [telegramM, persist]);

  const loginAsGuest = useCallback(async () => {
    await requestStorageAccessIfEmbedded();
    const next = await guestM.mutateAsync();
    persist(next);
  }, [guestM, persist]);

  // ── Background session resolution ────────────────────────────────────────
  // Runs once, after paint. Order matters: an existing session wins, then a
  // Telegram payload, and only then do we fall through to the login screen.
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    let cancelled = false;

    (async () => {
      try {
        // The demo build has no server to verify a Telegram payload against, so
        // it skips the SDK wait entirely and resolves the session immediately.
        const wa = IS_DEMO ? undefined : await waitForTelegramWebApp();
        if (cancelled) return;
        const inside = Boolean(wa?.initData);
        setInTelegram(inside);

        const me = await utils.client.auth.me.query();
        if (cancelled) return;
        if (me) {
          persist(me);
          return;
        }

        // No session. Inside Telegram, sign in automatically — a Mini App must
        // never ask a Telegram user to fill in a form.
        if (inside && wa?.initData) {
          try {
            const next = await telegramM.mutateAsync({ initData: wa.initData });
            if (cancelled) return;
            persist(next);
          } catch (e) {
            if (cancelled) return;
            setTelegramError(e instanceof Error ? e.message : "Telegram sign-in failed.");
            persist(null);
          }
        } else {
          persist(null);
        }
      } catch {
        // A failed check must never block the app: keep whatever the cache had.
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [utils, telegramM, persist]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading: false,
      checking,
      inTelegram,
      telegramError,
      login: async (email, password) => {
        await requestStorageAccessIfEmbedded();
        const next = await loginM.mutateAsync({ email, password });
        persist(next);
      },
      signup: async (email, password, name) => {
        await requestStorageAccessIfEmbedded();
        const next = await signupM.mutateAsync({ email, password, name });
        persist(next);
      },
      loginWithTelegram,
      loginAsGuest,
      logout: async () => {
        await requestStorageAccessIfEmbedded();
        await logoutM.mutateAsync();
        persist(null);
      },
    }),
    [
      user,
      checking,
      inTelegram,
      telegramError,
      loginM,
      signupM,
      logoutM,
      loginWithTelegram,
      loginAsGuest,
      persist,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
