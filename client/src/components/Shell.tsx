import { Suspense, lazy, useEffect, useState } from "react";
import { useGame } from "../lib/store";
import { useAudio } from "../lib/audio";
import { fmtShort, nanoToTon, fmtTon } from "../lib/format";
import { skinImage } from "../lib/assets";

/**
 * Screens are code-split. The login screen is the first thing anyone sees, and
 * it needs none of them — so they load after sign-in, in parallel with the
 * first game state, and are preloaded during idle time so switching tabs is
 * still instant.
 */
const Mine = lazy(() => import("../pages/Mine"));
const Wallet = lazy(() => import("../pages/Wallet"));
const Referral = lazy(() => import("../pages/Referral"));
const Shop = lazy(() => import("../pages/Shop"));
const Leaderboard = lazy(() => import("../pages/Leaderboard"));
const Ads = lazy(() => import("../pages/Ads"));

type TabKey = "mine" | "wallet" | "board" | "referral" | "shop" | "ads";

const TABS: { key: TabKey; icon: string; label: string; screen: string }[] = [
  { key: "mine", icon: "⛏️", label: "Mine", screen: "mine" },
  { key: "wallet", icon: "👛", label: "Wallet", screen: "wallet" },
  { key: "board", icon: "🏆", label: "Board", screen: "board" },
  { key: "referral", icon: "👥", label: "Friends", screen: "referral" },
  { key: "shop", icon: "🛒", label: "Shop", screen: "shop" },
  { key: "ads", icon: "🎬", label: "Ads", screen: "ads" },
];

/** Warm every screen chunk once the browser is idle, so tab switches never wait. */
function usePreloadScreens() {
  useEffect(() => {
    const warm = () => {
      void import("../pages/Mine");
      void import("../pages/Wallet");
      void import("../pages/Referral");
      void import("../pages/Shop");
      void import("../pages/Leaderboard");
      void import("../pages/Ads");
    };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
      .requestIdleCallback;
    if (ric) {
      const id = ric(warm);
      return () => {
        const cic = (window as unknown as { cancelIdleCallback?: (id: number) => void })
          .cancelIdleCallback;
        cic?.(id);
      };
    }
    const t = window.setTimeout(warm, 1200);
    return () => window.clearTimeout(t);
  }, []);
}

function ScreenFallback() {
  return (
    <div className="center-fill">
      <div className="spinner" />
    </div>
  );
}

export default function Shell() {
  const { state, coin, loading, error, refetch } = useGame();
  const { muted, toggleMute } = useAudio();
  const [tab, setTab] = useState<TabKey>("mine");
  usePreloadScreens();

  if (loading) {
    return (
      <div className="phone">
        <div className="center-fill">
          <div>
            <div className="spinner" />
            <div className="charge-note">Warming up the mine…</div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !state) {
    return (
      <div className="phone">
        <div className="center-fill">
          <div className="auth-box">
            <div className="card">
              <div className="empty">
                <div className="em">🔌</div>
                <div className="t">Could not reach the arena</div>
                <div className="s">{error ?? "No game state came back from the server."}</div>
              </div>
              <button className="btn btn-gold" onClick={refetch}>
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { profile, cfg, league } = state;
  const tonBalance = nanoToTon(profile.balanceNanoTon);

  return (
    <div className="phone">
      <div className="topbar">
        <div className="avatar">
          {profile.avatar}
          <span className="lvl">LVL {profile.tapPowerLevel}</span>
        </div>

        <div className="who">
          <div className="nm">{profile.handle}</div>
          <div className="lg">
            {league.emoji} {league.name} <b>×{league.mult}</b>
          </div>
        </div>

        <button
          className="icon-btn"
          onClick={toggleMute}
          title={muted ? "Unmute" : "Mute"}
          aria-label={muted ? "Unmute sound" : "Mute sound"}
        >
          {muted ? "🔇" : "🔊"}
        </button>

        <div className="pills">
          <div className="pill">
            <img className="ic" src={skinImage(profile.equippedSkin)} alt="" />
            <span className="v">{fmtShort(coin)}</span>
          </div>
          <div className="pill">
            <span className="ic ton">◈</span>
            <span className="v">
              {fmtTon(profile.balanceNanoTon, 3)}
              <small>TON</small>
            </span>
          </div>
        </div>
      </div>

      {cfg.announcementBanner && <div className="announce">📣 {cfg.announcementBanner}</div>}

      <div className="screens">
        <Suspense fallback={<ScreenFallback />}>
          <Mine active={tab === "mine"} />
          <Wallet active={tab === "wallet"} tonBalance={tonBalance} />
          <Leaderboard active={tab === "board"} />
          <Referral active={tab === "referral"} />
          <Shop active={tab === "shop"} />
          <Ads active={tab === "ads"} />
        </Suspense>
      </div>

      <nav className="tabbar">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? "on" : ""}`}
            onClick={() => setTab(t.key)}
            aria-label={t.label}
            aria-current={tab === t.key ? "page" : undefined}
          >
            <span className="ti">{t.icon}</span>
            {t.label}
            {t.key === "wallet" && state.withdraw.eligible && !profile.withdrawalPending && (
              <span className="badge">!</span>
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}
