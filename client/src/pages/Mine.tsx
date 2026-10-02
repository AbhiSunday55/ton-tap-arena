import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../_core/trpc";
import { useGame } from "../lib/store";
import { useAudio } from "../lib/audio";
import { fmtCoin, fmtInt, fmtShort, untilLabel } from "../lib/format";
import { skinImage, buttonImage, AD_CHEST_IMG } from "../lib/assets";
import { useAdReward } from "../lib/useAdReward";
import { effectLines } from "../../../shared/item-effects";

interface Fx {
  id: number;
  x: number;
  y: number;
  amount: number;
  sparks: { dx: string; dy: string }[];
}

/**
 * The mine screen is the game's front door: the tap target, the energy gate, the
 * three boosters, the league ladder, the daily streak and the passive rigs. All
 * reward maths is server-authoritative — this screen only mirrors it for the
 * floating "+N" label.
 */
export default function Mine({ active }: { active: boolean }) {
  const { state, coin, energy, tap, perTap, applyState, toast, refetch } = useGame();
  const { sfx } = useAudio();
  // The same ad flow the Ads screen uses, so the two entry points cannot drift.
  const ad = useAdReward(active);

  const stageRef = useRef<HTMLDivElement>(null);
  const [fx, setFx] = useState<Fx[]>([]);
  const fxId = useRef(0);

  // Local rapid-tap counter — purely cosmetic, and honest about being so: the
  // server owns the real combo multiplier.
  const [combo, setCombo] = useState(0);
  const comboRef = useRef<number[]>([]);
  useEffect(() => {
    const id = window.setInterval(() => {
      const cutoff = Date.now() - 1200;
      comboRef.current = comboRef.current.filter((t) => t > cutoff);
      setCombo(comboRef.current.length);
    }, 140);
    return () => window.clearInterval(id);
  }, []);

  const spawnFx = useCallback((clientX: number, clientY: number, amount: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const id = ++fxId.current;
    const item: Fx = {
      id,
      x: clientX - rect.left,
      y: clientY - rect.top,
      amount,
      sparks: Array.from({ length: 5 }, () => ({
        dx: `${(Math.random() - 0.5) * 120}px`,
        dy: `${-40 - Math.random() * 70}px`,
      })),
    };
    setFx((f) => [...f.slice(-12), item]);
    window.setTimeout(() => setFx((f) => f.filter((v) => v.id !== id)), 1000);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      const accepted = tap(1);
      if (accepted > 0) {
        comboRef.current.push(Date.now());
        spawnFx(e.clientX, e.clientY, perTap);
      }
    },
    [tap, perTap, spawnFx],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      const box = e.currentTarget.getBoundingClientRect();
      const accepted = tap(1);
      if (accepted > 0) {
        comboRef.current.push(Date.now());
        spawnFx(box.left + box.width / 2, box.top + box.height / 2, perTap);
      }
    },
    [tap, perTap, spawnFx],
  );

  const boosterM = trpc.game.booster.useMutation();
  const rigM = trpc.game.buyRig.useMutation();
  const upgradeM = trpc.game.upgradeTap.useMutation();
  const streakM = trpc.game.claimStreak.useMutation();
  const [pendingKind, setPendingKind] = useState<string | null>(null);

  if (!state) return null;
  const { cfg, profile, league, boosters, rigs, streakRewards, turboActive, rigPerHour } = state;

  const cap = profile.energyCap;
  const energyPct = Math.min(100, Math.round((energy / Math.max(1, cap)) * 100));
  // One decimal at most: the equipped regen bonus makes this a repeating
  // fraction (3s / 1.4), and the raw value rendered as "2.142857142857143s".
  const regenSecs = Math.round(profile.energyRegenSeconds * 10) / 10;

  async function runBooster(kind: "turbo" | "energy" | "recharge") {
    setPendingKind(kind);
    try {
      const next = await boosterM.mutateAsync({ kind });
      applyState(next);
      sfx(kind === "turbo" ? "turbo" : "claim");
      toast(
        kind === "turbo"
          ? `Turbo ×${cfg.turboMultiplier} active for ${cfg.turboDurationSec}s`
          : kind === "energy"
            ? "Energy fully restored"
            : `+${cfg.rechargeAmount} energy`,
        "ok",
      );
    } catch (e) {
      sfx("error");
      toast(e instanceof Error ? e.message : "Booster failed", "err");
    } finally {
      setPendingKind(null);
    }
  }

  async function buyRig(key: string, cost: number, name: string) {
    setPendingKind(`rig:${key}`);
    try {
      const next = await rigM.mutateAsync({ key });
      applyState(next);
      sfx("buy");
      toast(`${name} online — +${cfg.rigs.find((r) => r.name === name)?.perHour ?? 0}/hour`, "ok");
    } catch (e) {
      sfx("error");
      toast(e instanceof Error ? e.message : "Purchase failed", "err");
    } finally {
      setPendingKind(null);
    }
    void cost;
  }

  async function upgradeTap() {
    setPendingKind("upgrade");
    try {
      const next = await upgradeM.mutateAsync();
      applyState(next);
      sfx("level");
      toast(`Tap power is now level ${next.profile.tapPowerLevel}`, "ok");
    } catch (e) {
      sfx("error");
      toast(e instanceof Error ? e.message : "Upgrade failed", "err");
    } finally {
      setPendingKind(null);
    }
  }

  async function claimStreak() {
    setPendingKind("streak");
    try {
      const res = await streakM.mutateAsync();
      applyState(res);
      sfx("claim");
      toast(`Day ${res.streakClaimed.day} claimed — +${fmtInt(res.streakClaimed.reward)} COIN`, "ok");
    } catch (e) {
      sfx("error");
      toast(e instanceof Error ? e.message : "Claim failed", "err");
    } finally {
      setPendingKind(null);
    }
  }

  return (
    <section className={`screen mine ${active ? "active" : ""}`} aria-hidden={!active}>
      <div className="stage" ref={stageRef}>
        <div className="halo" />
        <div className="ring" />

        <span className={`combo ${combo >= 5 ? "on" : ""}`}>
          {turboActive ? `🚀 TURBO ×${cfg.turboMultiplier}` : `COMBO ×${Math.min(combo, 20)}`}
        </span>

        <button
          className="tap-btn"
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
          aria-label={`Mine coin — ${fmtCoin(profile.tapPowerPerTapExact)} per tap`}
          disabled={energy <= 0}
        >
          <img className="bg" src={buttonImage(profile.equippedButton)} alt="" draggable={false} />
          <img className="coin" src={skinImage(profile.equippedSkin)} alt="" draggable={false} />
          <span className="lbl">TAP TO MINE</span>
        </button>

        <div className="fx-layer">
          {fx.map((f) => (
            <span key={f.id}>
              <span className="fx" style={{ left: f.x, top: f.y }}>
                +{fmtInt(f.amount)}
              </span>
              {f.sparks.map((s, i) => (
                <span
                  key={i}
                  className="spark"
                  style={{ left: f.x, top: f.y, ["--dx" as string]: s.dx, ["--dy" as string]: s.dy }}
                />
              ))}
            </span>
          ))}
        </div>
      </div>

      <div className="energy-wrap">
        <div className="energy-head">
          <span>⚡ ENERGY</span>
          <span className="v">
            {fmtInt(Math.floor(energy))} <span>/ {fmtInt(cap)}</span>
          </span>
        </div>
        <div className="bar">
          <i style={{ width: `${energyPct}%` }} />
        </div>
        <div className="charge-note">
          {energy > 0
            ? `${fmtCoin(profile.tapPowerPerTapExact)} COIN per tap · recharges 1 energy every ${regenSecs}s`
            : `Out of energy — it refills 1 point every ${regenSecs}s, or use a booster.`}
        </div>
      </div>

      <div className="boost-row">
        <button
          className="boost"
          onClick={() => runBooster("turbo")}
          disabled={pendingKind !== null}
          aria-label="Activate turbo"
        >
          <span className={`free ${boosters.turbo.freeLeft > 0 ? "" : "paid"}`}>
            {boosters.turbo.freeLeft > 0 ? boosters.turbo.freeLeft : fmtShort(boosters.turbo.cost)}
          </span>
          <span className="em">🚀</span>
          <span className="nm">Turbo</span>
          <span className="sub">×{cfg.turboMultiplier} · {cfg.turboDurationSec}s</span>
        </button>

        <button
          className="boost"
          onClick={() => runBooster("energy")}
          disabled={pendingKind !== null}
          aria-label="Refill energy"
        >
          <span className={`free ${boosters.energy.freeLeft > 0 ? "" : "paid"}`}>
            {boosters.energy.freeLeft > 0 ? boosters.energy.freeLeft : fmtShort(boosters.energy.cost)}
          </span>
          <span className="em">⚡</span>
          <span className="nm">Full Energy</span>
          <span className="sub">Refill to max</span>
        </button>

        <button
          className="boost"
          onClick={() => runBooster("recharge")}
          disabled={pendingKind !== null}
          aria-label="Recharge energy"
        >
          <span className={`free ${boosters.recharge.freeLeft > 0 ? "" : "paid"}`}>
            {boosters.recharge.freeLeft > 0 ? boosters.recharge.freeLeft : fmtShort(boosters.recharge.cost)}
          </span>
          <span className="em">🔋</span>
          <span className="nm">Recharge</span>
          <span className="sub">
            +{cfg.rechargeAmount} ·{" "}
            {boosters.recharge.readyAt && new Date(boosters.recharge.readyAt) > new Date()
              ? untilLabel(boosters.recharge.readyAt)
              : `${cfg.rechargeCooldownSec / 60}m cd`}
          </span>
        </button>
      </div>

      {/* What the equipped assets are actually doing right now. */}
      {(() => {
        const lines = effectLines(profile.itemEffects);
        if (lines.length === 0) return null;
        return (
          <div className="card tight" style={{ marginTop: 10 }}>
            <div className="list-row" style={{ borderBottom: "none" }}>
              <div className="em">✨</div>
              <div className="mid">
                <div className="t">
                  Active bonuses · {fmtCoin(profile.tapPowerPerTapExact)} COIN/tap
                </div>
                <div className="s">
                  {lines.map((l) => `${l.icon} ${l.label}`).join("  ·  ")}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* The ad chest: a second, always-visible way into the rewarded slot. */}
      {ad.status && (
        <div className="card tight" style={{ marginTop: 10 }}>
          <div className="list-row" style={{ borderBottom: "none" }}>
            <img
              src={AD_CHEST_IMG}
              alt=""
              style={{ width: 46, height: 46, borderRadius: 12, objectFit: "cover", flex: "0 0 auto" }}
            />
            <div className="mid">
              <div className="t">
                {ad.status.remaining > 0
                  ? `Watch an ad \u00b7 +${fmtInt(ad.status.rewardCoin)} COIN`
                  : "No ad views left today"}
              </div>
              <div className="s">
                {ad.error
                  ? ad.error
                  : ad.status.remaining > 0
                    ? `${ad.status.remaining} of ${ad.status.dailyLimit} views left today`
                    : "The counter resets at midnight UTC"}
              </div>
            </div>
            <button
              className="btn btn-cyan xs"
              onClick={ad.play}
              disabled={ad.playing || ad.status.remaining <= 0 || !ad.status.enabled}
            >
              {ad.playing ? "\u2026" : ad.countdown !== null ? `${ad.countdown}s` : "Watch"}
            </button>
          </div>
        </div>
      )}

      <div className="sec-title">
        <h2>
          <span className="dot" /> League
        </h2>
        <span className="hint">{fmtShort(profile.totalCoinMined)} mined all-time</span>
      </div>

      <div className="card">
        <div className="league-row">
          <div className="league-badge">{league.emoji}</div>
          <div className="league-info">
            <div className="n">
              {league.name} <em>×{league.mult} tap power</em>
            </div>
            <div className="bar">
              <i className="violet" style={{ width: `${league.progressPercent}%` }} />
            </div>
            <div className="nx">
              {league.next === null
                ? "Top league reached — you are a legend."
                : `${fmtInt(league.progressPercent)}% to ${cfg.leagueNames[league.index + 1]} (${fmtShort(league.next)} COIN)`}
            </div>
          </div>
        </div>
      </div>

      <div className="sec-title">
        <h2>
          <span className="dot" /> Daily streak
        </h2>
        <span className="hint">Day {profile.streakDay || 1} of {streakRewards.length}</span>
      </div>

      <div className="card">
        <div className="streak-grid">
          {streakRewards.map((r, i) => {
            const day = i + 1;
            const done = profile.streakDay > day || (profile.streakDay === day && profile.streakClaimedToday);
            const now = profile.streakDay === day && !profile.streakClaimedToday;
            return (
              <div key={day} className={`sg ${done ? "done" : ""} ${now ? "now" : ""}`}>
                <div className="d">D{day}</div>
                <div className="r">{fmtShort(r)}</div>
              </div>
            );
          })}
        </div>
        <button
          className={`btn ${profile.streakClaimedToday ? "btn-ghost" : "btn-cyan"}`}
          style={{ marginTop: 12 }}
          onClick={claimStreak}
          disabled={profile.streakClaimedToday || pendingKind !== null}
        >
          {profile.streakClaimedToday
            ? "✓ Claimed today — come back tomorrow"
            : `Claim day ${profile.streakDay || 1} · ${fmtInt(streakRewards[Math.max(0, (profile.streakDay || 1) - 1)] ?? 0)} COIN`}
        </button>
        <div className="charge-note">
          Miss a day and the ladder resets to day 1. The full run pays{" "}
          {fmtShort(streakRewards.reduce((a, b) => a + b, 0))} COIN.
        </div>
      </div>

      <div className="sec-title">
        <h2>
          <span className="dot" /> Mining rigs
        </h2>
        <span className="hint">
          {rigPerHour > 0 ? `+${fmtInt(rigPerHour)} COIN / hour` : "Passive income"}
        </span>
      </div>

      {rigs.map((r) => (
        <div className="rig" key={r.key}>
          <div className="ic">⚙️</div>
          <div className="inf">
            <div className="n">
              {r.name}
              {r.owned > 0 && <span className="own" style={{ marginLeft: 8 }}>×{r.owned}</span>}
            </div>
            <div className="s">
              <b>+{fmtInt(r.perHour)}</b> COIN / hour · {fmtInt(r.costCoin)} COIN
            </div>
          </div>
          <button
            className="btn btn-ghost xs"
            onClick={() => buyRig(r.key, r.costCoin, r.name)}
            disabled={pendingKind !== null || coin < r.costCoin}
          >
            {coin < r.costCoin ? "🔒" : "Buy"}
          </button>
        </div>
      ))}

      <div className="card tight">
        <div className="list-row" style={{ borderBottom: "none" }}>
          <div className="em">✋</div>
          <div className="mid">
            <div className="t">Tap power — level {profile.tapPowerLevel}</div>
            <div className="s">
              {profile.tapPowerLevel >= cfg.tapPowerUpgradeMax
                ? "Maximum level reached"
                : `+${cfg.tapPowerUpgradeStep} per upgrade · ${fmtInt(cfg.tapPowerUpgradeCost)} COIN`}
            </div>
          </div>
          <button
            className="btn btn-gold xs"
            onClick={upgradeTap}
            disabled={pendingKind !== null || profile.tapPowerLevel >= cfg.tapPowerUpgradeMax || coin < cfg.tapPowerUpgradeCost}
          >
            {profile.tapPowerLevel >= cfg.tapPowerUpgradeMax ? "MAX" : "Upgrade"}
          </button>
        </div>
      </div>

      <div className="foot-note">
        Tap power rises with your league, your upgrades and the skin you have equipped.{" "}
        <button
          className="btn btn-ghost xs"
          style={{ display: "inline-flex", marginTop: 8 }}
          onClick={refetch}
        >
          ↻ Resync
        </button>
      </div>
    </section>
  );
}
