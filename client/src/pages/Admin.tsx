import { useMemo, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { trpc } from "../_core/trpc";
import { fmtInt, fmtTon, fmtUsd, nanoToTon, relativeTime, truncAddress } from "../lib/format";

/**
 * Field descriptors for the config editor. Each entry maps ONE dotted config
 * path to a labelled input. Adding a tunable to `game-config.ts` and a row here
 * is all it takes for it to appear in the panel — the set of editable values is
 * data, not a hand-built form.
 */
interface FieldDef {
  path: string;
  label: string;
  kind?: "number" | "text" | "textarea" | "toggle" | "usd" | "ton";
  help?: string;
}

interface GroupDef {
  title: string;
  fields: FieldDef[];
}

const GROUPS: GroupDef[] = [
  {
    title: "Treasury",
    fields: [
      {
        path: "treasureEvmAddress",
        label: "Canonical treasury (EVM, audit reference)",
        kind: "text",
        help: "20-byte EVM address. Kept as the canonical identifier for USDT settlement and audit.",
      },
      {
        path: "treasureTonAddress",
        label: "TON treasury address (payout rail)",
        kind: "text",
        help: "32-byte TON address (EQ…/UQ…/0:hex). Until this is valid the payout rail stays DISARMED and payouts queue off-chain instead of broadcasting.",
      },
    ],
  },
  {
    title: "Starting reward",
    fields: [
      { path: "startCoin", label: "Starting COIN", kind: "number" },
      { path: "startNanoTon", label: "Starting TON credit", kind: "ton", help: "Deliberately below the withdrawal gate." },
    ],
  },
  {
    title: "Tap & energy",
    fields: [
      { path: "tapBaseReward", label: "COIN per tap", kind: "number" },
      { path: "tapPowerUpgradeStep", label: "Tap power per upgrade", kind: "number" },
      { path: "tapPowerUpgradeCost", label: "Upgrade cost (COIN)", kind: "number" },
      { path: "tapPowerUpgradeMax", label: "Max tap power level", kind: "number" },
      { path: "energyCap", label: "Energy cap", kind: "number" },
      { path: "energyRegenSeconds", label: "Seconds per 1 energy", kind: "number" },
      { path: "maxTapsPerRequest", label: "Max taps per request (anti-cheat)", kind: "number" },
      { path: "comboWindowMs", label: "Combo window (ms)", kind: "number" },
      { path: "comboStep", label: "Combo increment", kind: "number" },
      { path: "comboMaxMultiplier", label: "Combo max multiplier", kind: "number" },
    ],
  },
  {
    title: "Boosters",
    fields: [
      { path: "turboMultiplier", label: "Turbo multiplier", kind: "number" },
      { path: "turboDurationSeconds", label: "Turbo duration (s)", kind: "number" },
      { path: "turboFreePerDay", label: "Free turbos / day", kind: "number" },
      { path: "turboCostCoin", label: "Turbo cost (COIN)", kind: "number" },
      { path: "energyRefillFreePerDay", label: "Free refills / day", kind: "number" },
      { path: "energyRefillCostCoin", label: "Refill cost (COIN)", kind: "number" },
      { path: "rechargeFreePerDay", label: "Free recharges / day", kind: "number" },
      { path: "rechargeAmount", label: "Recharge energy", kind: "number" },
      { path: "rechargeCooldownSeconds", label: "Recharge cooldown (s)", kind: "number" },
      { path: "rechargeCostCoin", label: "Recharge cost (COIN)", kind: "number" },
    ],
  },
  {
    title: "Withdrawal gate & fees",
    fields: [
      { path: "withdrawThresholdTon", label: "Minimum withdrawal (TON)", kind: "number" },
      { path: "withdrawFeePercent", label: "Platform fee (%)", kind: "number" },
      { path: "withdrawNetworkFeeTon", label: "Network fee (TON)", kind: "number" },
      { path: "vestedPercent", label: "Vested (%)", kind: "number" },
      { path: "withdrawDailyLimitTon", label: "Daily cap (TON)", kind: "number" },
      { path: "withdrawMinTon", label: "Hard floor (TON)", kind: "number" },
    ],
  },
  {
    title: "Referrals",
    fields: [
      { path: "referralRewardCoin", label: "COIN per invite", kind: "number" },
      { path: "referralPremiumMultiplier", label: "Premium multiplier", kind: "number" },
      { path: "referralRevenueSharePercent", label: "Revenue share (%)", kind: "number" },
      { path: "referralBonusTon", label: "Qualification bonus (TON)", kind: "number" },
    ],
  },
  {
    title: "Shop pricing",
    fields: [
      { path: "shopPriceBaseUsdt", label: "Base price (USD)", kind: "usd", help: "Tier N costs base × multiplier^N — $0.50, $1.00, $2.00, $4.00, $8.00." },
      { path: "shopTierMultiplier", label: "Tier multiplier", kind: "number" },
      { path: "shopCoinMultiplier", label: "COIN price multiplier", kind: "number" },
    ],
  },
  {
    title: "Currency rates",
    fields: [
      { path: "coinPerTon", label: "COIN per 1 TON", kind: "number" },
      { path: "tonUsdRate", label: "TON → USD", kind: "number" },
      { path: "usdtTonRate", label: "USDT → TON", kind: "number" },
    ],
  },
  {
    title: "Watch ads",
    fields: [
      { path: "adEnabled", label: "Ads enabled", kind: "toggle" },
      { path: "adUnitId", label: "Ad unit ID", kind: "text", help: "Paste the network's unit ID once it is available." },
      { path: "adLink", label: "Ad destination link", kind: "text" },
      { path: "adRewardCoin", label: "Reward per view (COIN)", kind: "number" },
      { path: "adWatchSeconds", label: "Required watch time (s)", kind: "number" },
      { path: "adDailyLimit", label: "Daily view limit", kind: "number" },
    ],
  },
  {
    title: "Announcement",
    fields: [
      { path: "announcementBanner", label: "Banner text", kind: "textarea", help: "Leave empty to hide the banner." },
    ],
  },
];

function readPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((a, k) => {
    if (a === null || a === undefined) return undefined;
    return (a as Record<string, unknown>)[k];
  }, obj);
}

/** Admin panel: password gate, live stats, config editor, users, ledger. */
export default function AdminPage() {
  const meQ = trpc.admin.me.useQuery();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const utils = trpc.useUtils();
  const loginM = trpc.admin.login.useMutation();

  const signedIn = meQ.data?.signedIn === true;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loginM.mutateAsync({ password });
      setPassword("");
      await utils.admin.me.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  if (meQ.isLoading) {
    return (
      <div className="center-fill">
        <div className="spinner" />
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="center-fill">
        <div className="auth-box">
          <div className="brand">
            <div className="mk" style={{ fontSize: 44, textAlign: "center" }}>⚙️</div>
            <h1>Admin panel</h1>
            <p>Operator access to the arena configuration.</p>
          </div>
          <div className="card">
            <form onSubmit={submit}>
              <div className="field">
                <label htmlFor="ap">Panel password</label>
                <input
                  id="ap"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  autoComplete="current-password"
                />
              </div>
              {error && <div className="warn-box bad" style={{ marginBottom: 12 }}>{error}</div>}
              <button className="btn btn-gold" type="submit" disabled={busy || !password}>
                {busy ? "Checking…" : "Unlock panel"}
              </button>
            </form>
            <div className="charge-note">
              First run? Use <b>taparena</b>, then change it under Access.
            </div>
          </div>
          <div className="foot-note">
            <Link href="/">← Back to the arena</Link>
          </div>
        </div>
      </div>
    );
  }

  return <AdminBody />;
}

function AdminBody() {
  const [tab, setTab] = useState<"stats" | "config" | "users" | "ledger" | "ops">("stats");
  const utils = trpc.useUtils();
  const logoutM = trpc.admin.logout.useMutation();
  const [toast, setToast] = useState<string | null>(null);

  const statsQ = trpc.admin.stats.useQuery();
  const configQ = trpc.admin.getConfig.useQuery();
  const usersQ = trpc.admin.users.useQuery({ limit: 100, offset: 0 }, { enabled: tab === "users" });
  const ledgerQ = trpc.admin.ledger.useQuery({ limit: 100 }, { enabled: tab === "ledger" });
  const wdQ = trpc.admin.withdrawals.useQuery(undefined, { enabled: tab === "ops" });
  const shopQ = trpc.admin.shop.useQuery(undefined, { enabled: tab === "ops" });
  const offersQ = trpc.admin.offers.useQuery(undefined, { enabled: tab === "ops" });
  const boardQ = trpc.admin.board.useQuery(undefined, { enabled: tab === "ops" });

  const setConfigM = trpc.admin.setConfigBulk.useMutation();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);

  const cfg = configQ.data;

  const effective = useMemo(() => {
    if (!cfg) return null;
    return { ...(cfg.config as unknown as Record<string, unknown>), ...draft };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, draft]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  }

  async function save() {
    if (!Object.keys(draft).length) return;
    setSaving(true);
    try {
      await setConfigM.mutateAsync({ values: draft });
      setDraft({});
      await Promise.all([utils.admin.getConfig.invalidate(), utils.admin.stats.invalidate()]);
      flash("Configuration saved and live for every player.");
    } catch (e) {
      flash(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function resetAll() {
    if (!cfg) return;
    setSaving(true);
    try {
      const defaults = cfg.defaults as unknown as Record<string, unknown>;
      const flat: Record<string, unknown> = {};
      for (const g of GROUPS) for (const f of g.fields) flat[f.path] = readPath(defaults, f.path);
      await setConfigM.mutateAsync({ values: flat });
      setDraft({});
      await utils.admin.getConfig.invalidate();
      flash("Every value reset to its code default.");
    } finally {
      setSaving(false);
    }
  }

  async function signOut() {
    await logoutM.mutateAsync();
    await utils.admin.me.invalidate();
  }

  const s = statsQ.data;

  return (
    <div className="admin-wrap">
      {toast && (
        <div className="toasts">
          <div className="toast ok">{toast}</div>
        </div>
      )}

      <div className="admin-head">
        <div>
          <h1>⚙️ TON Tap Arena — Admin</h1>
          <div className="s">
            {s ? `${s.accounts} accounts · ${s.players} players · ${fmtInt(s.totalTaps)} taps` : "Loading…"}
          </div>
        </div>
        <div className="row">
          <Link href="/" className="btn btn-ghost sm" style={{ textDecoration: "none" }}>
            ← Arena
          </Link>
          <button className="btn btn-danger sm" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      <div className="admin-tabs">
        {(["stats", "config", "users", "ledger", "ops"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "stats"
              ? "📊 Overview"
              : t === "config"
                ? "🎛️ Configuration"
                : t === "users"
                  ? "👤 Players"
                  : t === "ledger"
                    ? "📒 Ledger"
                    : "⚡ Ops"}
          </button>
        ))}
      </div>

      {/* ───────────── OVERVIEW ───────────── */}
      {tab === "stats" && (
        <>
          <div className="stat-grid">
            <div className="stat">
              <div className="l">Accounts</div>
              <div className="v">{s?.accounts ?? 0}</div>
            </div>
            <div className="stat">
              <div className="l">Players</div>
              <div className="v">{s?.players ?? 0}</div>
            </div>
            <div className="stat">
              <div className="l">Total taps</div>
              <div className="v">{fmtInt(s?.totalTaps ?? 0)}</div>
            </div>
            <div className="stat">
              <div className="l">COIN in circulation</div>
              <div className="v">{fmtInt(s?.totalCoins ?? 0)}</div>
            </div>
            <div className="stat">
              <div className="l">TON outstanding</div>
              <div className="v">{fmtTon(s?.totalNanoTon ?? 0, 2)}</div>
            </div>
            <div className="stat">
              <div className="l">Paid purchases</div>
              <div className="v">{s?.purchases ?? 0}</div>
            </div>
            <div className="stat">
              <div className="l">Withdrawals</div>
              <div className="v">{s?.withdrawals ?? 0}</div>
            </div>
            <div className="stat">
              <div className="l">Sample board rows</div>
              <div className="v">{boardQ.data?.seedCount ?? 0}</div>
            </div>
          </div>

          <div className={`warn-box ${cfg?.hasTonTreasury ? "ok" : "bad"}`}>
            <b>{cfg?.hasTonTreasury ? "Payout rail ARMED" : "Payout rail DISARMED"}</b>
            {cfg?.hasTonTreasury
              ? `TON treasury: ${cfg.config.treasureTonAddress}`
              : "No valid 32-byte TON treasury address is configured, so the server refuses to broadcast payouts and queues them off-chain. Set one under Configuration → Treasury."}
          </div>

          <div className="group-title">
            <span className="dot" /> Maintenance
          </div>
          <div className="grid-2">
            <button className="btn btn-ghost" onClick={() => utils.admin.stats.invalidate()}>
              ↻ Refresh statistics
            </button>
            <button className="btn btn-ghost" onClick={() => utils.admin.getConfig.invalidate()}>
              ↻ Reload configuration
            </button>
          </div>
        </>
      )}

      {/* ───────────── CONFIG ───────────── */}
      {tab === "config" && (
        <>
          {Object.keys(draft).length > 0 && (
            <div className="warn-box warn" style={{ marginBottom: 14 }}>
              <b>{Object.keys(draft).length} unsaved change(s)</b>
              Nothing reaches players until you save.
            </div>
          )}

          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="group-title">
                <span className="dot" /> {g.title}
              </div>
              <div className="grid-2">
                {g.fields.map((f) => {
                  const value = effective ? readPath(effective, f.path) : undefined;
                  const changed = f.path in draft;

                  if (f.kind === "toggle") {
                    return (
                      <div className="field" key={f.path}>
                        <label htmlFor={f.path}>
                          {f.label} {changed && <span className="chip warn">edited</span>}
                        </label>
                        <button
                          id={f.path}
                          className={`btn ${value ? "btn-cyan" : "btn-ghost"}`}
                          style={{ padding: 11 }}
                          onClick={() => setDraft((d) => ({ ...d, [f.path]: !value }))}
                        >
                          {value ? "✓ Enabled" : "Disabled"}
                        </button>
                        {f.help && <div className="help">{f.help}</div>}
                      </div>
                    );
                  }

                  if (f.kind === "textarea") {
                    return (
                      <div className="field" key={f.path} style={{ gridColumn: "1 / -1" }}>
                        <label htmlFor={f.path}>
                          {f.label} {changed && <span className="chip warn">edited</span>}
                        </label>
                        <textarea
                          id={f.path}
                          value={String(value ?? "")}
                          onChange={(e) => setDraft((d) => ({ ...d, [f.path]: e.target.value }))}
                        />
                        {f.help && <div className="help">{f.help}</div>}
                      </div>
                    );
                  }

                  // TON amounts are stored in nanoTON; show them in TON.
                  const display =
                    f.kind === "ton" && typeof value === "number" ? nanoToTon(value) : value;
                  const step = f.kind === "ton" || f.kind === "usd" ? "0.01" : "1";

                  return (
                    <div className="field" key={f.path}>
                      <label htmlFor={f.path}>
                        {f.label}
                        {f.kind === "ton" ? " (TON)" : f.kind === "usd" ? " (USD)" : ""}{" "}
                        {changed && <span className="chip warn">edited</span>}
                      </label>
                      <input
                        id={f.path}
                        type={f.kind === "number" || f.kind === "ton" || f.kind === "usd" ? "number" : "text"}
                        step={step}
                        value={String(display ?? "")}
                        onChange={(e) => {
                          const raw = e.target.value;
                          if (f.kind === "number" || f.kind === "usd" || f.kind === "ton") {
                            const n = raw === "" ? 0 : Number(raw);
                            if (Number.isNaN(n)) return;
                            setDraft((d) => ({
                              ...d,
                              [f.path]: f.kind === "ton" ? Math.round(n * 1_000_000_000) : n,
                            }));
                          } else {
                            setDraft((d) => ({ ...d, [f.path]: raw }));
                          }
                        }}
                      />
                      {f.help && <div className="help">{f.help}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="row" style={{ marginTop: 22, position: "sticky", bottom: 12 }}>
            <button className="btn btn-gold" onClick={save} disabled={saving || !Object.keys(draft).length}>
              {saving ? "Saving…" : `💾 Save ${Object.keys(draft).length || ""} change(s)`}
            </button>
            <button className="btn btn-ghost" onClick={() => setDraft({})} disabled={!Object.keys(draft).length}>
              Discard
            </button>
            <button className="btn btn-danger" onClick={resetAll} disabled={saving}>
              Reset all
            </button>
          </div>
        </>
      )}

      {/* ───────────── USERS ───────────── */}
      {tab === "users" && (
        <>
          <div className="group-title">
            <span className="dot" /> Player database
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Email</th>
                  <th>COIN</th>
                  <th>TON</th>
                  <th>Mined</th>
                  <th>This week</th>
                  <th>Taps</th>
                  <th>Wallet</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {usersQ.data?.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.avatar} {u.handle}
                      {u.isAdmin && <span className="chip warn" style={{ marginLeft: 6 }}>admin</span>}
                    </td>
                    <td className="mono">{u.email ?? "—"}</td>
                    <td>{fmtInt(u.balanceCoin)}</td>
                    <td>{fmtTon(u.balanceNanoTon, 4)}</td>
                    <td>{fmtInt(u.totalTaps)}</td>
                    <td>{fmtInt(u.weekCoinMined)}</td>
                    <td>{fmtInt(u.totalTaps)}</td>
                    <td className="mono">{u.walletAddress ? truncAddress(u.walletAddress, 4, 4) : "—"}</td>
                    <td>{relativeTime(u.joinedAt.toISOString())}</td>
                  </tr>
                ))}
                {usersQ.data?.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ padding: 22, textAlign: "center" }}>
                      No players yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ───────────── LEDGER ───────────── */}
      {tab === "ledger" && (
        <>
          <div className="group-title">
            <span className="dot" /> Transaction ledger
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Player</th>
                  <th>Kind</th>
                  <th>COIN</th>
                  <th>TON</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {ledgerQ.data?.map((r) => (
                  <tr key={r.id}>
                    <td>{relativeTime(r.createdAt)}</td>
                    <td>{r.handle}</td>
                    <td className="mono">{r.kind}</td>
                    <td className={r.deltaCoin > 0 ? "gain" : r.deltaCoin < 0 ? "loss" : ""}>
                      {r.deltaCoin !== 0 ? `${r.deltaCoin > 0 ? "+" : ""}${fmtInt(r.deltaCoin)}` : "—"}
                    </td>
                    <td className={r.deltaNanoTon > 0 ? "gain" : r.deltaNanoTon < 0 ? "loss" : ""}>
                      {r.deltaNanoTon !== 0 ? `${r.deltaNanoTon > 0 ? "+" : ""}${fmtTon(r.deltaNanoTon, 4)}` : "—"}
                    </td>
                    <td>{r.note}</td>
                  </tr>
                ))}
                {ledgerQ.data?.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: 22, textAlign: "center" }}>
                      Nothing recorded yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ───────────── OPS ───────────── */}
      {tab === "ops" && (
        <>
          <div className="group-title">
            <span className="dot" /> Withdrawals
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Player</th>
                  <th>Amount</th>
                  <th>Net</th>
                  <th>Payout address</th>
                  <th>Status</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {wdQ.data?.map((w) => (
                  <tr key={w.id}>
                    <td>{relativeTime(w.createdAt)}</td>
                    <td>{w.handle}</td>
                    <td>{fmtTon(w.amountNanoTon, 4)}</td>
                    <td>{fmtTon(w.netNanoTon, 4)}</td>
                    <td className="mono">{truncAddress(w.payoutAddress, 6, 6)}</td>
                    <td>
                      <span className={`chip ${w.status === "completed" ? "ok" : w.status === "failed" ? "bad" : "warn"}`}>
                        {w.status}
                      </span>
                    </td>
                    <td className="mono">{w.txHash ? truncAddress(w.txHash, 6, 6) : "—"}</td>
                  </tr>
                ))}
                {wdQ.data?.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ padding: 22, textAlign: "center" }}>
                      No withdrawal requests.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="group-title">
            <span className="dot" /> Shop catalogue
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Slug</th>
                  <th>Name</th>
                  <th>Category</th>
                  <th>Tier</th>
                  <th>USD</th>
                  <th>COIN</th>
                  <th>Boost</th>
                  <th>Active</th>
                </tr>
              </thead>
              <tbody>
                {shopQ.data?.map((i) => (
                  <tr key={i.slug}>
                    <td className="mono">{i.slug}</td>
                    <td>{i.name}</td>
                    <td>{i.category}</td>
                    <td className={`tier-${i.tier}`}>{i.tier}</td>
                    <td>{fmtUsd(i.priceUsdtCents)}</td>
                    <td>{fmtInt(i.coinPrice)}</td>
                    <td>{i.boostPercent}%</td>
                    <td>{i.active ? "✓" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="group-title">
            <span className="dot" /> Offers &amp; task links
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Slug</th>
                  <th>Title</th>
                  <th>Kind</th>
                  <th>Rule</th>
                  <th>Reward</th>
                  <th>Link</th>
                  <th>Active</th>
                </tr>
              </thead>
              <tbody>
                {offersQ.data?.map((o) => (
                  <tr key={o.slug}>
                    <td className="mono">{o.slug}</td>
                    <td>{o.icon} {o.title}</td>
                    <td>{o.kind}</td>
                    <td className="mono">
                      {o.rule}
                      {o.ruleValue ? `:${o.ruleValue}` : ""}
                    </td>
                    <td>+{fmtInt(o.rewardCoin)}</td>
                    <td className="mono" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {o.url || "—"}
                    </td>
                    <td>{o.active ? "✓" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="warn-box warn" style={{ marginTop: 16 }}>
            <b>Editing catalogue items</b>
            Reward amounts, shop prices, task links and treasury addresses are all editable in the{" "}
            <b>Configuration</b> tab. Per-item catalogue edits (adding a skin, changing one task's
            link) are handled by the <span className="mono">admin.saveShopItem</span> /{" "}
            <span className="mono">admin.saveOffer</span> endpoints, which are wired and callable —
            this table is the read view of them.
          </div>
        </>
      )}
    </div>
  );
}
