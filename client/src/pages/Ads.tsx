import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../_core/trpc";
import { useGame } from "../lib/store";
import { useAudio } from "../lib/audio";
import { fmtShort, fmtInt } from "../lib/format";
import { AD_CHEST_IMG } from "../lib/assets";

/**
 * Watch-an-ad screen. No ad network is wired yet, so the slot renders a
 * clearly-labelled placeholder with an editable unit ID, destination link,
 * reward and daily cap — all four are read from the server config and changeable
 * from the admin panel without a redeploy.
 *
 * The reward is server-authoritative: `ads.watch` rejects anything shorter than
 * the configured watch time and enforces the daily cap, so a client cannot mint
 * coins by calling the endpoint directly.
 */
export default function Ads({ active }: { active: boolean }) {
  const { applyState, toast } = useGame();
  const { sfx } = useAudio();
  const statusQ = trpc.ads.status.useQuery(undefined, { enabled: active });
  const watchM = trpc.ads.watch.useMutation();

  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<number | null>(null);
  const elapsedRef = useRef(0);

  // countdown driven off a ref so a re-render cannot restart it mid-view
  useEffect(() => {
    if (secondsLeft === null) return;
    if (secondsLeft <= 0) return;
    timerRef.current = window.setTimeout(() => {
      elapsedRef.current += 1;
      setSecondsLeft((s) => (s === null ? null : s - 1));
    }, 1000);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [secondsLeft]);

  const finish = useCallback(
    async (watched: number) => {
      setBusy(true);
      try {
        const res = await watchM.mutateAsync({ watchedSeconds: watched });
        applyState(res.state);
        sfx("coin");
        toast(`Ad reward: +${fmtInt(res.rewardCoin)} COIN`, "ok");
      } catch (e) {
        sfx("error");
        toast(e instanceof Error ? e.message : "Ad reward failed", "err");
      } finally {
        setSecondsLeft(null);
        elapsedRef.current = 0;
        setBusy(false);
        void statusQ.refetch();
      }
    },
    [watchM, applyState, sfx, toast, statusQ],
  );

  // The countdown hitting zero is what earns the reward — never the click.
  useEffect(() => {
    if (secondsLeft !== 0) return;
    void finish(elapsedRef.current);
  }, [secondsLeft, finish]);

  const start = useCallback(() => {
    const dur = statusQ.data?.watchSeconds ?? 15;
    elapsedRef.current = 0;
    setSecondsLeft(dur);
    sfx("turbo");
  }, [statusQ.data, sfx]);

  if (!statusQ.data) {
    return (
      <section className={`screen ads ${active ? "active" : ""}`} aria-hidden={!active}>
        <div className="empty">
          <div className="em">🎬</div>
          <div className="t">Loading the ad slot…</div>
        </div>
      </section>
    );
  }

  const s = statusQ.data;
  const exhausted = s.remaining <= 0;

  return (
    <section className={`screen ads ${active ? "active" : ""}`} aria-hidden={!active}>
      <div className="sec-title" style={{ marginTop: 12 }}>
        <h2>
          <span className="dot" /> Watch & earn
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
            : `Watch a ${s.watchSeconds}-second ad to collect the reward. ${s.remaining} view${s.remaining === 1 ? "" : "s"} remaining today.`}
        </div>

        {secondsLeft !== null && (
          <div className="ad-timer">
            {secondsLeft > 0 ? secondsLeft : "✓"}
          </div>
        )}
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="btn btn-cyan"
          onClick={start}
          disabled={busy || exhausted || secondsLeft !== null || !s.enabled}
        >
          {!s.enabled
            ? "Ads disabled"
            : exhausted
              ? "Come back tomorrow"
              : secondsLeft !== null
                ? `Watching… ${secondsLeft}s`
                : `▶ Watch ad · +${fmtInt(s.rewardCoin)}`}
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
          <div className="em">🆔</div>
          <div className="mid">
            <div className="t mono">{s.unitId || "not set"}</div>
            <div className="s">Ad unit ID</div>
          </div>
        </div>
        <div className="list-row">
          <div className="em">🔗</div>
          <div className="mid">
            <div className="t">
              {s.link ? (
                <a href={s.link} target="_blank" rel="noreferrer noopener">
                  {s.link.length > 42 ? `${s.link.slice(0, 42)}…` : s.link}
                </a>
              ) : (
                "not set"
              )}
            </div>
            <div className="s">Where the ad sends the player</div>
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
          <div className="em">⏱️</div>
          <div className="mid">
            <div className="t">{s.watchSeconds}s minimum watch</div>
            <div className="s">
              Enforced by the server — a shorter view is rejected outright
            </div>
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
