import { useCallback, useState } from "react";
import { trpc } from "../_core/trpc";
import { useGame } from "../lib/store";
import { useAudio } from "../lib/audio";
import { fmtInt, fmtTon, relativeTime } from "../lib/format";
import { truncAddress } from "../lib/format";
import type { GameState } from "../lib/api-types";

const RUNG_EMOJI: Record<string, string> = {
  Bronze: "🥉",
  Silver: "🥈",
  Gold: "🥇",
  Diamond: "💎",
};

/**
 * Referral tab: the invite link, the four-rung bonus ladder, the task/offer list
 * (including the two Telegram channel joins) and the roster of invited players.
 *
 * Task eligibility is evaluated on the SERVER against real state (wallet
 * verified, purchase made, referrals active, ads watched), so the "Claim" button
 * being enabled is a server fact rather than a client opinion.
 */
export default function Referral({ active }: { active: boolean }) {
  const { state, applyState, toast } = useGame();
  const { sfx } = useAudio();

  const summaryQ = trpc.referral.summary.useQuery(undefined, { enabled: active });
  const offersQ = trpc.offers.list.useQuery(undefined, { enabled: active });
  const claimM = trpc.offers.claim.useMutation();
  const rungM = trpc.referral.claimRung.useMutation();
  const applyM = trpc.referral.applyCode.useMutation();

  const [busy, setBusy] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState("");

  const copy = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast(`${label} copied`, "ok");
      } catch {
        toast("Copy failed — select the text manually", "err");
      }
    },
    [toast],
  );

  /** Opens the task link, then claims on return (the server sees `visited`). */
  const openAndClaim = useCallback(
    async (url: string, slug: string, title: string) => {
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      setBusy(slug);
      try {
        const res = await claimM.mutateAsync({ slug, visited: true });
        applyState(res.state as unknown as GameState);
        sfx("claim");
        toast(`+${fmtInt(res.rewardCoin)} COIN · ${title}`, "ok");
        void offersQ.refetch();
      } catch (e) {
        sfx("error");
        toast(e instanceof Error ? e.message : "Claim failed", "err");
      } finally {
        setBusy(null);
      }
    },
    [claimM, applyState, sfx, toast, offersQ],
  );

  const claimInline = useCallback(
    async (slug: string, title: string) => {
      setBusy(slug);
      try {
        const res = await claimM.mutateAsync({ slug });
        applyState(res.state as unknown as GameState);
        sfx("claim");
        toast(`+${fmtInt(res.rewardCoin)} COIN · ${title}`, "ok");
        void offersQ.refetch();
      } catch (e) {
        sfx("error");
        toast(e instanceof Error ? e.message : "Claim failed", "err");
      } finally {
        setBusy(null);
      }
    },
    [claimM, applyState, sfx, toast, offersQ],
  );

  const claimRung = useCallback(
    async (name: string) => {
      setBusy(`rung-${name}`);
      try {
        const next = await rungM.mutateAsync({ name });
        applyState(next.state as unknown as GameState);
        sfx("level");
        toast(`${name} bonus claimed`, "ok");
        void summaryQ.refetch();
      } catch (e) {
        sfx("error");
        toast(e instanceof Error ? e.message : "Claim failed", "err");
      } finally {
        setBusy(null);
      }
    },
    [rungM, applyState, sfx, toast, summaryQ],
  );

  const applyCode = useCallback(async () => {
    if (!codeInput.trim()) return;
    setBusy("apply");
    try {
      const next = await applyM.mutateAsync({ code: codeInput.trim().toUpperCase() });
      applyState(next.state as unknown as GameState);
      sfx("claim");
      toast("Referral code applied", "ok");
      setCodeInput("");
    } catch (e) {
      sfx("error");
      toast(e instanceof Error ? e.message : "Could not apply that code", "err");
    } finally {
      setBusy(null);
    }
  }, [codeInput, applyM, applyState, sfx, toast]);

  if (!state) return null;
  const s = summaryQ.data;
  const o = offersQ.data;

  return (
    <section className={`screen referral ${active ? "active" : ""}`} aria-hidden={!active}>
      <div className="sec-title" style={{ marginTop: 12 }}>
        <h2>
          <span className="dot" /> Invite friends
        </h2>
        <span className="hint">+{fmtInt(state.cfg.referralRewardCoin)} COIN per friend</span>
      </div>

      {s ? (
        <>
          <div className="card">
            <div className="ref-code">
              <span className="c">{s.code}</span>
              <button className="btn btn-cyan xs" onClick={() => copy(s.code, "Code")}>
                Copy
              </button>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn btn-gold sm" onClick={() => copy(s.appLink, "Invite link")}>
                🔗 Copy invite link
              </button>
              <a
                className="btn btn-ghost sm"
                href={s.link}
                target="_blank"
                rel="noreferrer noopener"
                style={{ textDecoration: "none" }}
              >
                📤 Share
              </a>
            </div>

            <div
              className="streak-grid"
              style={{ gridTemplateColumns: "repeat(3, 1fr)", marginTop: 14 }}
            >
              <div className="sg">
                <div className="d">INVITED</div>
                <div className="r">{s.total}</div>
              </div>
              <div className="sg">
                <div className="d">ACTIVE</div>
                <div className="r">{s.activeCount}</div>
              </div>
              <div className="sg now">
                <div className="d">COIN EARNED</div>
                <div className="r">{fmtInt(s.coinsEarned)}</div>
              </div>
            </div>

            <div className="charge-note">
              Premium referrals pay {fmtInt(s.rewardPerPremium)} COIN —{" "}
              {Math.round(s.rewardPerPremium / Math.max(1, s.rewardPerInvite))}× the standard rate.
              You also earn {s.revenueSharePercent}% of what your friends spend for 30 days.
            </div>
          </div>

          <div className="sec-title">
            <h2>
              <span className="dot" /> Bonus ladder
            </h2>
            <span className="hint">{s.currentRung ? s.currentRung.name : "Bronze"} tier</span>
          </div>

          <div className="card">
            {s.ladder.map((r) => (
              <div className="rung" key={r.friends}>
                <div className="md">{RUNG_EMOJI[r.name] ?? "🎯"}</div>
                <div className="mid">
                  <div className="n">
                    {r.name} · {r.friends} friends
                  </div>
                  <div className="s">
                    +{fmtTon(r.bonusTon * 1_000_000_000, 2)} TON ·{" "}
                    {r.reached ? "unlocked" : `${r.progress}% there`}
                  </div>
                  <div className="bar" style={{ marginTop: 6, height: 6 }}>
                    <i className="cyan" style={{ width: `${r.progress}%` }} />
                  </div>
                </div>
                <button
                  className="btn btn-ghost xs"
                  disabled={!r.reached || busy !== null}
                  onClick={() => claimRung(r.name)}
                >
                  {r.reached ? (busy === `rung-${r.name}` ? "…" : "Claim") : "🔒"}
                </button>
              </div>
            ))}
          </div>

          {s.referrals.length > 0 && (
            <>
              <div className="sec-title">
                <h2>
                  <span className="dot" /> Your friends
                </h2>
                <span className="hint">{s.referrals.length}</span>
              </div>
              <div className="card">
                {s.referrals.map((r) => (
                  <div className="list-row" key={r.id}>
                    <div className="em">{r.avatar}</div>
                    <div className="mid">
                      <div className="t">{r.handle}</div>
                      <div className="s">
                        joined {relativeTime(r.createdAt)} · {r.status}
                      </div>
                    </div>
                    <div className="amt gain">+{fmtInt(r.coinsAwarded)}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      ) : (
        <div className="card">
          <div className="empty">
            <div className="em">👥</div>
            <div className="t">Loading your invite stats…</div>
          </div>
        </div>
      )}

      {/* ── offers & tasks ── */}
      <div className="sec-title">
        <h2>
          <span className="dot" /> Offers &amp; tasks
        </h2>
        <span className="hint">{o ? `${o.claimedCount}/${o.totalCount} claimed` : ""}</span>
      </div>

      {o?.offers.map((offer) => {
        const isChannel = offer.kind === "channel";
        return (
          <div className={`offer ${offer.claimed ? "done" : ""}`} key={offer.slug}>
            <div className="ic">{offer.icon}</div>
            <div className="inf">
              <div className="t">{offer.title}</div>
              <div className="d">{offer.description}</div>
              <div className="rw">
                +{fmtInt(offer.rewardCoin)} COIN
                {offer.bonusNanoTon > 0 ? ` · +${fmtTon(offer.bonusNanoTon, 2)} TON` : ""}
              </div>
            </div>
            {offer.claimed ? (
              <span className="chip ok">✓ Done</span>
            ) : (
              <button
                className={`btn ${isChannel ? "btn-cyan" : "btn-ghost"} xs`}
                disabled={!offer.eligible || busy !== null}
                onClick={() =>
                  isChannel && offer.url
                    ? openAndClaim(offer.url, offer.slug, offer.title)
                    : claimInline(offer.slug, offer.title)
                }
                title={offer.eligible ? "" : offer.hint}
              >
                {busy === offer.slug ? "…" : offer.ctaLabel}
              </button>
            )}
          </div>
        );
      })}

      {o && o.offers.some((x) => !x.claimed && !x.eligible) && (
        <div className="warn-box warn" style={{ marginTop: 4 }}>
          <b>Some tasks are locked</b>
          Eligibility is checked on the server against real state — connect a wallet, spend in the
          shop, watch an ad or invite friends, and the matching claim unlocks.
        </div>
      )}

      <div className="sec-title">
        <h2>
          <span className="dot" /> Have an invite code?
        </h2>
      </div>

      <div className="card">
        <div className="field" style={{ marginBottom: 10 }}>
          <label htmlFor="rc">Friend's referral code</label>
          <input
            id="rc"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
            placeholder="e.g. 7F3K9QX2"
            maxLength={32}
          />
        </div>
        <button
          className="btn btn-ghost"
          onClick={applyCode}
          disabled={!codeInput.trim() || busy !== null}
        >
          {busy === "apply" ? "Applying…" : "Apply code"}
        </button>
        <div className="charge-note">
          Codes can only be applied before you have earned your own referral bonus, and only within
          24 hours of signing up.
        </div>
      </div>

      <div className="foot-note">
        Referral bonuses are credited from the {state.cfg.referralRevenueSharePercent}% revenue-share
        pool. Total earned so far: {s ? fmtInt(s.coinsEarned) : 0} COIN
        {s?.code ? ` · code ${truncAddress(s.code, 4, 4)}` : ""}
      </div>
    </section>
  );
}
