import { Suspense, lazy, useEffect } from "react";
import { useAuth } from "./_core/useAuth";
import { useGame } from "./lib/store";
import { useAudio } from "./lib/audio";
import { applyTelegramChrome } from "./_core/telegram-webapp";
import Shell from "./components/Shell";
import Auth from "./pages/Auth";

/**
 * The TON Connect SDK is ~200 KB and the login screen never touches it, so it is
 * split into its own chunk and mounted only once a player is signed in. The
 * wallet chunk then downloads in parallel with the first game state.
 */
const TonConnectBoundary = lazy(() => import("./_core/TonConnectBoundary"));

/**
 * Route shell — the game, and only the game.
 *
 * This build ships the player-facing app alone. Management tooling is a
 * separate, unreleased surface with no route, link or reference here, so there
 * is nothing in the shipped product for a player to find, click or guess at.
 *
 * ── First paint ────────────────────────────────────────────────────────────
 * There is deliberately NO blocking gate here. `useAuth()` resolves the session
 * synchronously from cache, so this component decides between the login screen
 * and the game on its very first render — no spinner, no round trip. The server
 * check runs in the background and corrects the cache when it answers.
 */
export default function App() {
  const { user } = useAuth();
  const { state, toasts } = useGame();
  const { unlock } = useAudio();

  // Adopt Telegram's chrome (full height, matching header) as early as possible.
  useEffect(() => {
    applyTelegramChrome();
  }, []);

  // The first real user gesture is what unlocks WebAudio in every browser.
  useEffect(() => {
    const onFirst = () => {
      void unlock();
      window.removeEventListener("pointerdown", onFirst);
      window.removeEventListener("keydown", onFirst);
    };
    window.addEventListener("pointerdown", onFirst);
    window.addEventListener("keydown", onFirst);
    return () => {
      window.removeEventListener("pointerdown", onFirst);
      window.removeEventListener("keydown", onFirst);
    };
  }, [unlock]);

  const toastLayer = toasts.length > 0 && (
    <div className="toasts">
      {toasts.map((t) => (
        <div
          className={`toast ${t.kind === "err" ? "bad" : t.kind === "ok" ? "ok" : ""}`}
          key={t.id}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );

  // No session → the front door, painted immediately.
  if (!user) return <Auth />;

  // Signed in, game state still arriving. Brief, and only ever after auth.
  if (!state) {
    return (
      <div className="center-fill">
        <div className="spinner" />
        <div className="loading-note">Waking the arena…</div>
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="center-fill">
          <div className="spinner" />
          <div className="loading-note">Waking the arena…</div>
        </div>
      }
    >
      <TonConnectBoundary>
        <Shell />
        {toastLayer}
      </TonConnectBoundary>
    </Suspense>
  );
}
