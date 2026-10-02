import { useState, type FormEvent } from "react";
import { useAuth } from "../_core/useAuth";

/**
 * The front door.
 *
 * Two very different visitors arrive here:
 *
 *  • Inside Telegram — a Mini App must never show a sign-up form. The player is
 *    authenticated automatically from the signed `initData` payload, so this
 *    screen is only ever a brief "signing you in" state. If that fails, the
 *    email/guest fallback is still offered rather than dead-ending.
 *
 *  • Outside Telegram (GitHub Pages, a desktop browser) — email + password, or
 *    a one-tap guest account.
 *
 * The screen renders on the FIRST frame: nothing here waits on the network.
 */
export default function AuthPage() {
  const { login, signup, loginWithTelegram, loginAsGuest, inTelegram, telegramError } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await run(() =>
      mode === "signup" ? signup(email, password, name.trim() || undefined) : login(email, password),
    );
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

          {inTelegram ? (
            <div className="card">
              <div className="empty" style={{ padding: "10px 0 4px" }}>
                <div className="em">✈️</div>
                <div className="t">Signing you in with Telegram…</div>
                <div className="s">
                  Your Telegram account is being verified. No sign-up needed.
                </div>
              </div>
              {telegramError && (
                <div className="warn-box bad" style={{ marginBottom: 12 }}>
                  {telegramError}
                </div>
              )}
              <button
                className="btn btn-gold"
                onClick={() => run(loginWithTelegram)}
                disabled={busy}
              >
                {busy ? "Verifying…" : "↻ Retry Telegram sign-in"}
              </button>
              <div className="charge-note">
                Trouble signing in? You can still use an email account or continue as a guest
                below.
              </div>
            </div>
          ) : (
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

                {error && (
                  <div className="warn-box bad" style={{ marginBottom: 12 }}>
                    {error}
                  </div>
                )}

                <button className="btn btn-gold" type="submit" disabled={busy}>
                  {busy ? "Working…" : mode === "signup" ? "⛏️ Start mining" : "Enter the arena"}
                </button>
              </form>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  margin: "14px 0 12px",
                  color: "var(--muted-ink)",
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                <span style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.12)" }} />
                or
                <span style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.12)" }} />
              </div>

              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => run(loginAsGuest)}
                disabled={busy}
              >
                👤 Continue as guest
              </button>

              <div className="charge-note">
                New players start with <b>1,000 COIN</b> and a <b>0.10 TON</b> welcome credit.
                <br />
                Your progress is saved to a real database, so it follows you across devices.
              </div>
            </div>
          )}

          <div className="foot-note">
            {inTelegram
              ? "You are playing inside Telegram — your account is linked automatically."
              : "Open this game inside Telegram to sign in with your Telegram account instantly."}
          </div>
        </div>
      </div>
    </div>
  );
}
