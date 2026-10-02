import { useEffect } from "react";
import { useAuth } from "./_core/useAuth";
import { useGame } from "./lib/store";
import { useAudio } from "./lib/audio";
import Shell from "./components/Shell";
import Auth from "./pages/Auth";

/** Telegram Mini App bootstrap: expand to full height and adopt its chrome. */
function useTelegramChrome() {
  useEffect(() => {
    const tg = (window as unknown as { Telegram?: { WebApp?: Record<string, unknown> } }).Telegram
      ?.WebApp as
      | {
          ready?: () => void;
          expand?: () => void;
          setHeaderColor?: (c: string) => void;
          setBackgroundColor?: (c: string) => void;
        }
      | undefined;
    if (!tg) return;
    try {
      tg.ready?.();
      tg.expand?.();
      tg.setHeaderColor?.("#070b18");
      tg.setBackgroundColor?.("#070b18");
    } catch {
      /* not inside Telegram — the plain browser is a first-class target too */
    }
  }, []);
}

/**
 * Route shell — the game, and only the game.
 *
 * This build ships the player-facing app alone. Management tooling is a
 * separate, unreleased surface with no route, link or reference here, so there
 * is nothing in the shipped product for a player to find, click or guess at.
 */
export default function App() {
  useTelegramChrome();
  const { user, isLoading } = useAuth();
  const { state, toasts } = useGame();
  const { unlock } = useAudio();

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

  if (isLoading) {
    return (
      <div className="center-fill">
        <div className="spinner" />
      </div>
    );
  }

  if (!user) return <Auth />;

  if (!state) {
    return (
      <div className="center-fill">
        <div className="spinner" />
        <div className="loading-note">Waking the arena…</div>
      </div>
    );
  }

  return (
    <>
      <Shell />
      {toastLayer}
    </>
  );
}
