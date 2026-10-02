import { fmtShort, fmtInt } from "../lib/format";
import { AD_CHEST_IMG } from "../lib/assets";
import { useAdReward } from "../lib/useAdReward";
import { isTelegramMiniApp } from "../lib/adsgram";

/**
 * Watch-an-ad screen.
 *
 * The slot is driven entirely by server config — network, block ID, reward and
 * daily cap — so switching networks is a configuration change with no redeploy.
 *
 * The reward is server-authoritative: `ads.watch` enforces the daily cap and
 * refuses a view that did not complete, so a client cannot mint coins by calling
 * the endpoint directly.
 *
 * ── Why this screen now explains itself ──────────────────────────────────────
 * Adsgram picks a creative from the Telegram user context, so a rewarded ad can
 * only play inside a real Mini App launch. Previously a tap outside Telegram did
 * nothing at all, which is indistinguishable from a broken button. The screen
 * now states the requirement up front, shows a loading state while the ad is
 * requested, and surfaces every failure as visible text.
 */
export default function Ads({ active }: { active: boolean }) {
  const ad = useAdReward(active);
  const s = ad.status;

  // The SDK script is present in every browser, so `window.Telegram` alone is
  // not proof of a Mini App — `initData` is.
  const inTelegram = isTelegramMiniApp();
  const needsTelegram = s?.provider === "adsgram" && !inTelegram;

  if (!s) {
    return (
      <section className={`screen ads ${active ? "active" : ""}`} aria-hidden={!active}>
        <div className="empty">
          <div className="em">🎬</div>
          <div className="t">Loading the ad slot…</div>
        </div>
      </section>
    );
  }

  const exhausted = s.remaining <= 0;
  const disabled = ad.playing || exhausted || !s.enabled;

  const label = !s.enabled
    ? "Ads disabled"
    : exhausted
      ? "Come back tomorrow"
      : ad.playing
        ? "Loading ad…"
        : ad.countdown !== null
          ? `Watching… ${ad.countdown}s`
          : `▶ Watch ad · +${fmtInt(s.rewardCoin)}`;

  return (
    <section className={`screen ads ${active ? "active" : ""}`} aria-hidden={!active}>
      <div className="sec-title" style={{ marginTop: 12 }}>
        <h2>
          <span className="dot" /> Watch &amp; earn
        </h2>
        <span className="hint">
          {s.usedToday}/{s.dailyLimit} today
        </span>
      </div>

      <div className="ad-slot">
        <span className="lb">SPONSORED SLOT</span>
        <img src={AD_CHEST_IMG} alt="" />
        <div className="t">
          {exhausted ? "No views left today" : `Earn ${fmtInt(s.rewardCoin)} COIN`}
        </div>
        <div className="s">
          {exhausted
            ? `You have used all ${s.dailyLimit} views. The counter resets at midnight UTC.`
            : `Watch a short ad to collect the reward. ${s.remaining} view${s.remaining === 1 ? "" : "s"} remaining today.`}
        </div>

        {ad.countdown !== null && (
          <div className="ad-timer">{ad.countdown > 0 ? ad.countdown : "✓"}</div>
        )}
      </div>

      {/* The honest explanation, shown before the player taps rather than after. */}
      {needsTelegram && (
        <div className="warn-box warn" style={{ marginTop: 12 }}>
          <b>Ads play inside Telegram only</b>
          Rewarded ads are served by Adsgram, which needs your Telegram session to pick a
          creative. Open the game from the bot's menu button in Telegram and the ad will play
          here. Everything else in the game works normally in a browser.
        </div>
      )}

      {/* A visible failure, never a silent no-op. */}
      {ad.error && (
        <div className="warn-box bad" style={{ marginTop: 12 }} role="alert">
          <b>Ad not played</b>
          {ad.error}
        </div>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn btn-cyan" onClick={ad.play} disabled={disabled}>
          {ad.playing && <span className="spinner sm" aria-hidden />}
          {label}
        </button>
      </div>

      <div className="sec-title">
        <h2>
          <span className="dot" /> Your ad slot
        </h2>
        <span className="hint">
          {s.usedToday}/{s.dailyLimit} used today
        </span>
      </div>

      <div className="card">
        <div className="list-row">
          <div className="em">📡</div>
          <div className="mid">
            <div className="t">
              {s.provider === "adsgram" ? "Adsgram (rewarded)" : "Simulated slot"}
            </div>
            <div className="s">Ad network</div>
          </div>
        </div>
        <div className="list-row">
          <div className="em">🆔</div>
          <div className="mid">
            <div className="t mono">{s.blockId || "not set"}</div>
            <div className="s">Ad block ID</div>
          </div>
        </div>
        <div className="list-row">
          <div className="em">🪙</div>
          <div className="mid">
            <div className="t">{fmtInt(s.rewardCoin)} COIN per view</div>
            <div className="s">Reward per completed view</div>
          </div>
        </div>
        <div className="list-row">
          <div className="em">📊</div>
          <div className="mid">
            <div className="t">
              {s.usedToday} today · {s.allTime} all-time
            </div>
            <div className="s">Daily cap of {s.dailyLimit} views</div>
          </div>
        </div>
      </div>

      <div className="warn-box warn" style={{ marginTop: 12 }}>
        <b>Sponsored views</b>
        Ads are placed by our partners. You currently have {s.dailyLimit} view
        {s.dailyLimit === 1 ? "" : "s"} a day, and the counter resets at midnight UTC.{" "}
        {s.allTime > 0 ? `You have watched ${fmtShort(s.allTime)} so far.` : ""}
      </div>
    </section>
  );
}
