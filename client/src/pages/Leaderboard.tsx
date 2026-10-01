import { trpc } from "../_core/trpc";
import { fmtShort } from "../lib/format";

const MEDALS = ["🥇", "🥈", "🥉"];

/**
 * Weekly leaderboard. Real players come from `playerProfiles` ranked by
 * `weekCoinMined`; the seeded rivals are merged in so a brand-new app is not an
 * empty board. They are labelled as rivals in the UI rather than passed off as
 * real accounts, and an admin can clear them from the panel in one click.
 * The viewer's own row is highlighted wherever they sit.
 */
export default function Leaderboard({ active }: { active: boolean }) {
  const q = trpc.leaderboard.weekly.useQuery(undefined, { enabled: active });

  if (!q.data) {
    return (
      <section className={`screen board ${active ? "active" : ""}`} aria-hidden={!active}>
        <div className="empty">
          <div className="em">🏆</div>
          <div className="t">Loading the board…</div>
        </div>
      </section>
    );
  }

  const { rows, yourRank, totalPlayers, leagueNames, leagueEmojis } = q.data;
  const top = rows.slice(0, 3);
  const rest = rows.slice(3);
  const youInList = rows.some((r) => r.isYou);

  return (
    <section className={`screen board ${active ? "active" : ""}`} aria-hidden={!active}>
      <div className="sec-title" style={{ marginTop: 12 }}>
        <h2>
          <span className="dot" /> Weekly leaderboard
        </h2>
        <span className="hint">resets every Monday</span>
      </div>

      <div className="card tight" style={{ marginBottom: 12 }}>
        <div className="list-row" style={{ borderBottom: "none" }}>
          <div className="em">🏅</div>
          <div className="mid">
            <div className="t">
              Your rank: {yourRank ? `#${yourRank}` : "unranked"}
            </div>
            <div className="s">
              {totalPlayers} player{totalPlayers === 1 ? "" : "s"} this week
            </div>
          </div>
        </div>
      </div>

      {top.length > 0 && (
        <div className="podium">
          {[1, 0, 2].map((idx) => {
            const r = top[idx];
            if (!r) return <div key={idx} />;
            return (
              <div className={`pod ${r.rank === 1 ? "p1" : ""}`} key={r.rank}>
                <div className="md">{MEDALS[r.rank - 1] ?? "🏅"}</div>
                <div className="av">{r.avatar}</div>
                <div className="h">{r.isYou ? "You" : r.handle}</div>
                <div className="c">{fmtShort(r.weekCoinMined)}</div>
              </div>
            );
          })}
        </div>
      )}

      {rest.length === 0 && top.length === 0 && (
        <div className="card">
          <div className="empty">
            <div className="em">🌱</div>
            <div className="t">Nobody has mined this week yet</div>
            <div className="s">
              The board ranks players by coins mined in the last 7 days. Tap the coin on the
              Mine tab and you will be the first name here.
            </div>
          </div>
        </div>
      )}

      {rest.map((r) => (
        <div className={`lb-row ${r.isYou ? "you" : ""}`} key={`${r.rank}-${r.handle}`}>
          <div className={`rk ${r.rank <= 3 ? `top${r.rank}` : ""}`}>{r.rank}</div>
          <div className="av">{r.avatar}</div>
          <div className="nm">
            <div className="h">
              {r.isYou ? `${r.handle} (you)` : r.handle}
              {r.isSeed && <span className="chip mute" style={{ marginLeft: 6 }}>rival</span>}
            </div>
            <div className="l">
              {leagueEmojis[r.leagueIndex] ?? "🥉"} {leagueNames[r.leagueIndex] ?? "Bronze"}
            </div>
          </div>
          <div className="co">
            <div className="c">{fmtShort(r.weekCoinMined)}</div>
            <div className="u">COIN</div>
          </div>
        </div>
      ))}

      {!youInList && yourRank !== null && (
        <>
          <div className="sec-title">
            <h2>
              <span className="dot" /> You
            </h2>
          </div>
          <div className="lb-row you">
            <div className="rk">{yourRank}</div>
            <div className="av">⛏️</div>
            <div className="nm">
              <div className="h">Your position</div>
              <div className="l">Keep mining to climb the board</div>
            </div>
            <div className="co">
              <div className="c">#{yourRank}</div>
              <div className="u">RANK</div>
            </div>
          </div>
        </>
      )}

      <div className="sec-title">
        <h2>
          <span className="dot" /> How the board works
        </h2>
      </div>
      <div className="card">
        <div className="list-row">
          <div className="em">📅</div>
          <div className="mid">
            <div className="t">Rolling 7-day window</div>
            <div className="s">Coins mined, task rewards and streak payouts all count</div>
          </div>
        </div>
        <div className="list-row">
          <div className="em">🏆</div>
          <div className="mid">
            <div className="t">{totalPlayers} ranked this week</div>
            <div className="s">
              League standing updates as you mine
            </div>
          </div>
        </div>
      </div>

      <div className="foot-note">
        Rivals are house players who keep the arena busy while the league fills up. Beat them to
        climb the board — an admin can retire them from the panel at any time.
      </div>
    </section>
  );
}
