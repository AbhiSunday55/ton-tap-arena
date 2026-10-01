import { useState, type FormEvent } from "react";
import { useAuth } from "../_core/useAuth";

/**
 * Combined sign-in / sign-up on one screen, styled as the arena rather than as
 * a generic scaffold form. The app is dark-only and the hero art is the game's
 * own tap button, so this reads as the game's front door.
 */
export default function AuthPage() {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") await signup(email, password, name.trim() || undefined);
      else await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="phone">
      <div className="screen active mine" style={{ paddingBottom: 28 }}>
        <div className="auth-box" style={{ margin: "28px auto 0" }}>
          <div className="brand">
            <img className="mk" src="/assets/coin.png" alt="" />
            <h1>TON Tap Arena</h1>
            <p>Tap to mine. Stack COIN. Cash out in TON.</p>
          </div>

          <div className="card">
            <div className="tabs-inline" style={{ marginTop: 0 }}>
              <button
                type="button"
                className={mode === "signup" ? "on" : ""}
                onClick={() => setMode("signup")}
              >
                Create account
              </button>
              <button
                type="button"
                className={mode === "login" ? "on" : ""}
                onClick={() => setMode("login")}
              >
                Sign in
              </button>
            </div>

            <form onSubmit={onSubmit}>
              {mode === "signup" && (
                <div className="field">
                  <label htmlFor="nm">Player name</label>
                  <input
                    id="nm"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="CoinTycoon"
                    maxLength={32}
                  />
                  <div className="help">Shown on the leaderboard. You can leave this blank.</div>
                </div>
              )}

              <div className="field">
                <label htmlFor="em">Email</label>
                <input
                  id="em"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </div>

              <div className="field">
                <label htmlFor="pw">Password</label>
                <input
                  id="pw"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  placeholder="At least 8 characters"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                />
              </div>

              {error && <div className="warn-box bad" style={{ marginBottom: 12 }}>{error}</div>}

              <button className="btn btn-gold" type="submit" disabled={busy}>
                {busy ? "Working…" : mode === "signup" ? "⛏️ Start mining" : "Enter the arena"}
              </button>
            </form>

            <div className="charge-note">
              New players start with <b>1,000 COIN</b> and a <b>0.10 TON</b> welcome credit.
              <br />
              Your progress is saved to a real database, so it follows you across devices.
            </div>
          </div>

          <div className="foot-note">
            <b>Demo build.</b> Crypto amounts are illustrative. Payouts require a
            TON-format treasury address, set in the admin panel.
          </div>
        </div>
      </div>
    </div>
  );
}
