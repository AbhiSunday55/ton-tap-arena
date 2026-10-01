import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useGame } from "../lib/store";
import { useAudio } from "../lib/audio";
import { fmtShort, nanoToTon, fmtTon } from "../lib/format";
import { skinImage } from "../lib/assets";
import Mine from "../pages/Mine";
import Wallet from "../pages/Wallet";
import Referral from "../pages/Referral";
import Shop from "../pages/Shop";
import Leaderboard from "../pages/Leaderboard";
import Ads from "../pages/Ads";

type TabKey = "mine" | "wallet" | "board" | "referral" | "shop" | "ads";

const TABS: { key: TabKey; icon: string; label: string; screen: string }[] = [
  { key: "mine", icon: "⛏️", label: "Mine", screen: "mine" },
  { key: "wallet", icon: "👛", label: "Wallet", screen: "wallet" },
  { key: "board", icon: "🏆", label: "Board", screen: "board" },
  { key: "referral", icon: "👥", label: "Friends", screen: "referral" },
  { key: "shop", icon: "🛒", label: "Shop", screen: "shop" },
  { key: "ads", icon: "🎬", label: "Ads", screen: "ads" },
];

/** Telegram Mini App chrome — no-op in a normal browser. */
function useTelegramChrome() {
  useEffect(() => {
    const wa = (
      window as unknown as {
        Telegram?: { WebApp?: { ready?: () => void; expand?: () => void; setHeaderColor?: (c: string) => void } };
      }
    ).Telegram?.WebApp;
    try {
      wa?.ready?.();
      wa?.expand?.();
      wa?.setHeaderColor?.("#070b16");
    } catch {
      /* not inside Telegram */
    }
  }, []);
}

export default function Shell() {
  const { state, coin, loading, error, refetch } = useGame();
  const { muted, toggleMute } = useAudio();
  const [tab, setTab] = useState<TabKey>("mine");
  useTelegramChrome();

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

        <Link href="/admin" className="icon-btn" title="Admin panel" aria-label="Admin panel">
          ⚙️
        </Link>

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
        <Mine active={tab === "mine"} />
        <Wallet active={tab === "wallet"} tonBalance={tonBalance} />
        <Leaderboard active={tab === "board"} />
        <Referral active={tab === "referral"} />
        <Shop active={tab === "shop"} />
        <Ads active={tab === "ads"} />
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
