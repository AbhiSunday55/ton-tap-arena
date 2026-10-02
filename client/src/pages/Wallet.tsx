import { useCallback, useEffect, useRef, useState } from "react";
import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { trpc } from "../_core/trpc";
import { useGame } from "../lib/store";
import { useAudio } from "../lib/audio";
import { fmtTon, fmtInt, nanoToTon, relativeTime } from "../lib/format";
import { truncAddress } from "../lib/format";

/** Decimal TON string → nanoTON string, without floating-point rounding. */
function tonToNanoString(amount: string): string {
  const [whole, frac = ""] = amount.split(".");
  const fracPadded = (frac + "000000000").slice(0, 9);
  return (BigInt(whole || "0") * 1_000_000_000n + BigInt(fracPadded || "0")).toString();
}

/**
 * Wallet screen.
 *
 * The connection is REAL TON Connect 2.0: the server issues a nonce, the SDK
 * embeds it in the connect request as a `tonProof` item, the wallet signs it,
 * and the server verifies the Ed25519 signature against the wallet's own public
 * key before binding the address. Nothing is trusted from the client.
 *
 * Payments are built server-side (the exact transfer, with the comment payload)
 * and only SIGNED here — the treasury address never comes from the browser.
 */
export default function Wallet({ active, tonBalance }: { active: boolean; tonBalance: number }) {
  const [tonConnectUI] = useTonConnectUI();
  const wallet = useTonWallet();
  const { state, applyState, toast, refetch } = useGame();
  const { sfx } = useAudio();

  const nonceM = trpc.wallet.nonce.useMutation();
  const verifyM = trpc.wallet.verify.useMutation();
  const disconnectM = trpc.wallet.disconnect.useMutation();
  const withdrawM = trpc.withdrawal.request.useMutation();

  const ledgerQ = trpc.wallet.ledger.useQuery({ limit: 40 }, { enabled: active });
  const withdrawListQ = trpc.withdrawal.list.useQuery(undefined, { enabled: active });
  const infoQ = trpc.withdrawal.info.useQuery(undefined, { enabled: active });

  const [awaitingProof, setAwaitingProof] = useState(false);
  const [busy, setBusy] = useState(false);
  const pendingNonce = useRef<string | null>(null);

  const verifyAndBind = useCallback(async () => {
    const proof = wallet?.connectItems?.tonProof;
    const account = wallet?.account;
    if (!proof || !account || !pendingNonce.current) return;

    setBusy(true);
    try {
      // The SDK only narrows `tonProof` to its success shape once the error
      // branch is ruled out — a wallet can answer the request with `{ error }`.
      if ("error" in proof) {
        throw new Error(`Wallet refused the signature request: ${proof.error.message}`);
      }
      const td = proof.proof;
      const next = await verifyM.mutateAsync({
        address: account.address,
        publicKey: account.publicKey,
        walletStateInit: account.walletStateInit,
        network: account.chain,
        provider: "tonconnect",
        proof: {
          timestamp: td.timestamp,
          domain: { lengthBytes: td.domain.lengthBytes, value: td.domain.value },
          payload: td.payload,
          signature: td.signature,
        },
      });
      applyState(next);
      sfx("claim");
      toast(`Wallet verified · ${truncAddress(next.profile.walletAddress)}`, "ok");
      void infoQ.refetch();
    } catch (e) {
      sfx("error");
      toast(e instanceof Error ? e.message : "Wallet verification failed", "err");
    } finally {
      pendingNonce.current = null;
      setAwaitingProof(false);
      setBusy(false);
    }
  }, [wallet, verifyM, applyState, sfx, toast, infoQ]);

  // The SDK surfaces the proof asynchronously once the wallet responds.
  useEffect(() => {
    if (!state) return;
    if (state.profile.proofVerified) return;
    if (wallet?.connectItems?.tonProof && pendingNonce.current) void verifyAndBind();
  }, [wallet, state, verifyAndBind]);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const { payload } = await nonceM.mutateAsync();
      pendingNonce.current = payload;
      setAwaitingProof(true);
      // The tonProof item is what makes this a signed challenge, not a bare
      // address hand-off. Without it the wallet returns no proof at all.
      tonConnectUI.setConnectRequestParameters({
        state: "ready",
        value: { tonProof: payload },
      });
      await tonConnectUI.openModal();
    } catch (e) {
      setAwaitingProof(false);
      sfx("error");
      toast(e instanceof Error ? e.message : "Could not start the wallet flow", "err");
    } finally {
      setBusy(false);
    }
  }, [nonceM, tonConnectUI, sfx, toast]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      await tonConnectUI.disconnect().catch(() => undefined);
      const next = await disconnectM.mutateAsync();
      applyState(next);
      pendingNonce.current = null;
      setAwaitingProof(false);
      toast("Wallet disconnected", "info");
      void infoQ.refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Disconnect failed", "err");
    } finally {
      setBusy(false);
    }
  }, [tonConnectUI, disconnectM, applyState, toast, infoQ]);

  const doWithdraw = useCallback(async () => {
    if (!infoQ.data?.canWithdraw) return;
    setBusy(true);
    try {
      const res = await withdrawM.mutateAsync({});
      applyState(res.state);
      sfx("withdraw");
      toast(res.message, res.railArmed ? "ok" : "info");

      // Rail armed: sign and broadcast the exact transfer the server built.
      if (res.transfer && res.railArmed) {
        try {
          const result = await tonConnectUI.sendTransaction({
            validUntil: Math.floor(Date.now() / 1000) + 300,
            messages: [
              {
                address: res.transfer.to,
                amount: tonToNanoString(res.transfer.amountTon),
                payload: res.transfer.payloadBase64,
              },
            ],
          });
          toast(`Transfer signed · ${truncAddress(result.boc?.slice(0, 19) ?? "sent", 8, 8)}`, "ok");
        } catch (e) {
          toast(
            `Queued, but the wallet did not sign: ${e instanceof Error ? e.message : "rejected"}`,
            "err",
          );
        }
      }
      void infoQ.refetch();
      void withdrawListQ.refetch();
      refetch();
    } catch (e) {
      sfx("error");
      toast(e instanceof Error ? e.message : "Withdrawal failed", "err");
    } finally {
      setBusy(false);
    }
  }, [infoQ, withdrawM, applyState, sfx, toast, tonConnectUI, withdrawListQ, refetch]);

  if (!state || !infoQ.data) return null;

  const { profile, cfg } = state;
  const info = infoQ.data;
  const lockedTon = nanoToTon(profile.lockedNanoTon);
  const vestedTon = nanoToTon(profile.vestedNanoTon);

  return (
    <section className={`screen wallet ${active ? "active" : ""}`} aria-hidden={!active}>
      <div className="hero-bal">
        <div className="lb">TOTAL BALANCE</div>
        <div className="amt">
          {fmtTon(profile.balanceNanoTon, 4)}
          <small>TON</small>
        </div>
        <div className="usd">
          ≈ ${(tonBalance * cfg.tonUsdRate).toFixed(2)} USD · {fmtInt(profile.balanceCoin)} COIN
        </div>
      </div>

      {/* ── wallet connection ── */}
      <div className="sec-title">
        <h2>
          <span className="dot" /> TON wallet
        </h2>
        <span className="hint">TON Connect 2.0</span>
      </div>

      <div className="wallet-connect">
        <div className="ic">{profile.proofVerified ? "✅" : "🔗"}</div>
        <div className="tx">
          <div className="a">
            {profile.walletAddress ? truncAddress(profile.walletAddress, 8, 8) : "No wallet linked"}
          </div>
          <div className="b">
            {profile.proofVerified
              ? `Verified ${profile.walletConnectedAt ? relativeTime(profile.walletConnectedAt) : ""} · ${profile.walletProvider ?? "tonconnect"}`
              : profile.walletAddress
                ? "Address linked but the signature was not verified"
                : "Connect to unlock withdrawals"}
          </div>
        </div>
        {profile.proofVerified ? (
          <button className="btn btn-ghost xs" onClick={disconnect} disabled={busy}>
            Unlink
          </button>
        ) : (
          <button className="btn btn-cyan xs" onClick={connect} disabled={busy}>
            {busy ? "…" : "Connect"}
          </button>
        )}
      </div>

      {awaitingProof && !profile.proofVerified && (
        <div className="warn-box warn" style={{ marginTop: 10 }}>
          <b>Approve the request in your wallet</b>
          Your wallet will ask you to confirm you own this address. Just approve it — you are not
          sending any money and you are not paying a fee.
        </div>
      )}

      {!profile.proofVerified && !awaitingProof && (
        <div className="warn-box ok" style={{ marginTop: 10 }}>
          <b>Why we ask you to sign</b>
          Signing proves the wallet is really yours, so nobody can claim your balance by typing in
          your address. It costs nothing and does not move any TON.
        </div>
      )}

      {/* ── withdrawal ── */}
      <div className="sec-title">
        <h2>
          <span className="dot" /> Withdrawal
        </h2>
        <span className="hint">{cfg.withdrawThresholdTon} TON minimum</span>
      </div>

      <div className="card">
        <div className="energy-head">
          <span>PROGRESS TO {cfg.withdrawThresholdTon} TON</span>
          <span className="v">
            {fmtTon(profile.balanceNanoTon, 3)} <span>/ {cfg.withdrawThresholdTon}</span>
          </span>
        </div>
        <div className="bar">
          <i className={info.eligible ? "" : "cyan"} style={{ width: `${info.progressPercent}%` }} />
        </div>

        {!info.eligible && (
          <div className="warn-box warn" style={{ marginTop: 12 }}>
            <b>{fmtTon(info.shortfallNanoTon, 4)} TON to go</b>
            You need {cfg.withdrawThresholdTon} TON to unlock a payout. Keep mining, or convert COIN
            below — {fmtInt(cfg.coinsPerTon)} COIN = 1 TON.
          </div>
        )}

        {info.eligible && (
          <div className="list-row" style={{ marginTop: 8 }}>
            <div className="em">📤</div>
            <div className="mid">
              <div className="t">Payout breakdown</div>
              <div className="s">
                Fee {cfg.withdrawFeePercent}% ({fmtTon(info.feeNanoTon, 4)} TON) · network{" "}
                {cfg.withdrawNetworkFeeTon} TON · {cfg.vestedPercent}% vested
              </div>
            </div>
          </div>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn btn-gold"
            onClick={doWithdraw}
            disabled={!info.canWithdraw || busy}
            aria-disabled={!info.canWithdraw}
          >
            {profile.withdrawalPending
              ? "⏳ Withdrawal in progress"
              : info.canWithdraw
                ? `Withdraw ${fmtTon(profile.balanceNanoTon, 3)} TON`
                : `Need ${cfg.withdrawThresholdTon} TON`}
          </button>
        </div>

        <div className="charge-note">
          {!info.walletConnected
            ? "Connect and verify a wallet — the gate stays locked until then."
            : !info.railArmed
              ? "⚠️ Payouts to your wallet are not switched on yet. Your balance is safe and any withdrawal you request is queued."
              : profile.withdrawalPending
                ? "Your payout is queued. The treasury signs and broadcasts the transfer."
                : "Immediate vs vested split: " +
                  `${cfg.vestedPercent}% is held for 7 days.`}
        </div>
      </div>

      <div className="sec-title">
        <h2>
          <span className="dot" /> Convert COIN → TON
        </h2>
        <span className="hint">
          {fmtInt(cfg.coinsPerTon)} COIN = 1 TON
        </span>
      </div>

      <div className="card tight">
        <div className="list-row" style={{ borderBottom: "none" }}>
          <div className="em">🔄</div>
          <div className="mid">
            <div className="t">
              {fmtInt(Math.floor(profile.balanceCoin / cfg.coinsPerTon * 100) / 100)} TON available
              to convert
            </div>
            <div className="s">
              {fmtInt(profile.balanceCoin)} COIN at {fmtInt(cfg.coinsPerTon)}:1
            </div>
          </div>
          <button className="btn btn-ghost xs" disabled title="Conversion settles the next time you tap">
            Locked
          </button>
        </div>
      </div>

      {/* ── holdings ── */}
      <div className="sec-title">
        <h2>
          <span className="dot" /> Holdings
        </h2>
      </div>

      <div className="card tight">
        <div className="list-row">
          <div className="em">💠</div>
          <div className="mid">
            <div className="t">Spendable TON</div>
            <div className="s">Balance that counts toward the gate</div>
          </div>
          <div className="amt">{fmtTon(profile.balanceNanoTon, 4)}</div>
        </div>
        <div className="list-row">
          <div className="em">🔒</div>
          <div className="mid">
            <div className="t">Locked in payout</div>
            <div className="s">Debited while a withdrawal is pending</div>
          </div>
          <div className="amt">{fmtTon(profile.lockedNanoTon, 4)}</div>
        </div>
        <div className="list-row">
          <div className="em">🕒</div>
          <div className="mid">
            <div className="t">Vested ({cfg.vestedPercent}%)</div>
            <div className="s">Released after the 7-day hold</div>
          </div>
          <div className="amt">{fmtTon(profile.vestedNanoTon, 4)}</div>
        </div>
        <div className="list-row">
          <div className="em">📅</div>
          <div className="mid">
            <div className="t">Daily cap remaining</div>
            <div className="s">Rolling 24-hour window</div>
          </div>
          <div className="amt">{fmtTon(info.dailyLimitRemainingNanoTon, 3)}</div>
        </div>
      </div>

      {/* ── history ── */}
      <div className="sec-title">
        <h2>
          <span className="dot" /> Withdrawal history
        </h2>
        <span className="hint">{withdrawListQ.data?.length ?? 0}</span>
      </div>

      <div className="card">
        {withdrawListQ.data?.length ? (
          withdrawListQ.data.map((w) => (
            <div className="list-row" key={w.id}>
              <div className="em">
                {w.status === "completed" ? "✅" : w.status === "failed" ? "❌" : "⏳"}
              </div>
              <div className="mid">
                <div className="t">
                  {fmtTon(w.amountNanoTon, 4)} TON → {truncAddress(w.payoutAddress, 6, 6)}
                </div>
                <div className="s">
                  {w.status} · {relativeTime(w.createdAt)}
                  {w.txHash ? ` · tx ${truncAddress(w.txHash, 6, 6)}` : ""}
                </div>
              </div>
              <div className="amt">{fmtTon(w.netNanoTon, 4)} net</div>
            </div>
          ))
        ) : (
          <div className="empty">
            <div className="em">📭</div>
            <div className="t">No withdrawals yet</div>
            <div className="s">
              Reach {cfg.withdrawThresholdTon} TON and the payout button unlocks. You currently hold{" "}
              {fmtTon(profile.balanceNanoTon, 4)} TON spendable
              {lockedTon > 0 ? ` and ${fmtTon(profile.lockedNanoTon, 4)} TON locked` : ""}.
            </div>
          </div>
        )}
      </div>

      <div className="sec-title">
        <h2>
          <span className="dot" /> Transaction ledger
        </h2>
        <span className="hint">append-only</span>
      </div>

      <div className="card">
        {ledgerQ.data?.length ? (
          ledgerQ.data.map((r) => (
            <div className="list-row" key={r.id}>
              <div className="em">
                {r.kind.includes("withdraw") ? "📤" : r.kind.includes("purchase") ? "🛒" : "🪙"}
              </div>
              <div className="mid">
                <div className="t">{r.note}</div>
                <div className="s">
                  {relativeTime(r.createdAt)}
                  {vestedTon > 0 && r.kind === "withdrawal_requested" ? "" : ""}
                </div>
              </div>
              <div className="amt">
                {r.deltaCoin !== 0 && (
                  <span className={r.deltaCoin > 0 ? "gain" : "loss"}>
                    {r.deltaCoin > 0 ? "+" : ""}
                    {fmtInt(r.deltaCoin)}
                  </span>
                )}
                {r.deltaNanoTon !== 0 && (
                  <div className={r.deltaNanoTon > 0 ? "gain" : "loss"} style={{ fontSize: 10 }}>
                    {r.deltaNanoTon > 0 ? "+" : ""}
                    {fmtTon(r.deltaNanoTon, 4)} TON
                  </div>
                )}
              </div>
            </div>
          ))
        ) : (
          <div className="empty">
            <div className="em">📒</div>
            <div className="t">Ledger is empty</div>
            <div className="s">
              Every tap batch, purchase, task reward and payout writes an entry here.
            </div>
          </div>
        )}
      </div>

      <div className="foot-note">
        Treasury (EVM reference): <span className="mono">{cfg.treasureEvmAddress}</span>
        <br />
        TON rail:{" "}
        {info.railArmed ? (
          <span className="mono">{info.treasuryTon}</span>
        ) : (
          <b>not switched on yet</b>
        )}
      </div>
    </section>
  );
}
