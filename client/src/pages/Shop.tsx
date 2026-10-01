import { useCallback, useState } from "react";
import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { trpc } from "../_core/trpc";
import { useGame } from "../lib/store";
import { useAudio } from "../lib/audio";
import { fmtInt, fmtUsd, relativeTime } from "../lib/format";

type Rail = "TON" | "STARS" | "COIN";

/** Decimal TON string → nanoTON string, without floating-point rounding. */
function tonToNanoString(amount: string): string {
  const [whole, frac = ""] = amount.split(".");
  const fracPadded = (frac + "000000000").slice(0, 9);
  return (BigInt(whole || "0") * 1_000_000_000n + BigInt(fracPadded || "0")).toString();
}

/**
 * Shop. Prices follow the spec's `$0.50 × 2^tier` curve. Three payment rails:
 *
 *  - TON    — REAL money. `purchase` returns the exact transfer the treasury
 *             expects (recipient + amount + comment payload, built server-side
 *             with the real address parser); the wallet only signs it, and
 *             `confirm` delivers the item once a tx hash comes back.
 *  - STARS  — the platform-compliant digital-goods rail; creates a pending order.
 *  - COIN   — settles instantly against the in-game balance, off-chain.
 *
 * Buying an item does NOT equip it — equipping is a separate call, because a
 * cosmetic you own but are not wearing must not silently change your tap power.
 */
export default function Shop({ active }: { active: boolean }) {
  const [tonConnectUI] = useTonConnectUI();
  const wallet = useTonWallet();
  const { state, applyState, toast } = useGame();
  const { sfx } = useAudio();

  const listQ = trpc.shop.list.useQuery(undefined, { enabled: active });
  const mineQ = trpc.shop.mine.useQuery(undefined, { enabled: active });
  const purchaseM = trpc.shop.purchase.useMutation();
  const confirmM = trpc.shop.confirm.useMutation();
  const prefsM = trpc.game.prefs.useMutation();

  const [tab, setTab] = useState<"skin" | "button">("skin");
  const [busy, setBusy] = useState<string | null>(null);

  const buy = useCallback(
    async (slug: string, name: string, rail: Rail) => {
      setBusy(slug);
      try {
        const res = await purchaseM.mutateAsync({ slug, rail });
        applyState(res.state);

        if (res.mode === "settled") {
          sfx("buy");
          toast(`${name} unlocked · paid in COIN`, "ok");
        } else if (res.mode === "stars") {
          sfx("buy");
          toast(`${name} order created · ${res.amountStars} Stars invoice pending`, "info");
        } else {
          // mode === "onchain": hand the exact transfer to the wallet
          if (!wallet) {
            sfx("error");
            toast("Connect a TON wallet first — the payment must be signed.", "err");
          } else {
            try {
              const result = await tonConnectUI.sendTransaction({
                validUntil: Math.floor(Date.now() / 1000) + 300,
                messages: [
                  {
                    address: res.treasury,
                    amount: tonToNanoString(res.amountTon),
                    payload: res.commentPayload,
                  },
                ],
              });
              const txHash = result.boc ?? "broadcast";
              const next = await confirmM.mutateAsync({ slug, txHash });
              applyState(next);
              sfx("buy");
              toast(`${name} unlocked · paid on-chain`, "ok");
            } catch (e) {
              sfx("error");
              toast(
                `Order saved, but the payment was not signed: ${e instanceof Error ? e.message : "rejected"}`,
                "err",
              );
            }
          }
        }
        void listQ.refetch();
        void mineQ.refetch();
      } catch (e) {
        sfx("error");
        toast(e instanceof Error ? e.message : "Purchase failed", "err");
      } finally {
        setBusy(null);
      }
    },
    [purchaseM, confirmM, applyState, sfx, toast, wallet, tonConnectUI, listQ, mineQ],
  );

  const equip = useCallback(
    async (slug: string, category: "skin" | "button") => {
      setBusy(slug);
      try {
        const next = await prefsM.mutateAsync(
          category === "skin" ? { equippedSkin: slug } : { equippedButton: slug },
        );
        applyState(next);
        sfx("claim");
        toast("Equipped", "ok");
        void listQ.refetch();
      } catch (e) {
        sfx("error");
        toast(e instanceof Error ? e.message : "Could not equip", "err");
      } finally {
        setBusy(null);
      }
    },
    [prefsM, applyState, sfx, toast, listQ],
  );

  if (!state || !listQ.data) {
    return (
      <section className={`screen shop ${active ? "active" : ""}`} aria-hidden={!active}>
        <div className="empty">
          <div className="em">🛒</div>
          <div className="t">Opening the shop…</div>
        </div>
      </section>
    );
  }

  const { cfg } = state;
  const items = listQ.data.items.filter((i) => i.category === tab);
  const ownedCount = listQ.data.items.filter((i) => i.owned).length;

  return (
    <section className={`screen shop ${active ? "active" : ""}`} aria-hidden={!active}>
      <div className="sec-title" style={{ marginTop: 12 }}>
        <h2>
          <span className="dot" /> Asset shop
        </h2>
        <span className="hint">
          {ownedCount}/{listQ.data.items.length} owned
        </span>
      </div>

      <div className="warn-box ok">
        <b>Prices by tier</b>
        Common {fmtUsd(cfg.shopPriceBaseUsdt * 100)} · Rare {fmtUsd(cfg.shopPriceBaseUsdt * 200)} ·
        Epic {fmtUsd(cfg.shopPriceBaseUsdt * 400)} · Legendary {fmtUsd(cfg.shopPriceBaseUsdt * 800)} ·
        Mythic {fmtUsd(cfg.shopPriceBaseUsdt * 1600)}
      </div>

      <div className="warn-box warn" style={{ marginTop: 10 }}>
        <b>Payments open soon</b>
        Wallet top-ups are not switched on yet. Everything you mine still counts, and anything you
        buy with COIN works today.
      </div>

      <div className="tabs-inline">
        <button className={tab === "skin" ? "on" : ""} onClick={() => setTab("skin")}>
          🪙 Coin skins
        </button>
        <button className={tab === "button" ? "on" : ""} onClick={() => setTab("button")}>
          🔘 Tap buttons
        </button>
      </div>

      <div className="shop-grid">
        {items.map((item) => (
          <div
            className={`shop-card ${item.owned ? "owned" : ""} ${item.equipped ? "equipped" : ""}`}
            key={item.slug}
          >
            <span className={`tier tier-${item.tier}`}>{item.tier}</span>
            <img src={item.imageUrl} alt={item.name} loading="lazy" />
            <div className="n">{item.name}</div>
            <div className="d">{item.description}</div>
            <div className="p">
              {fmtUsd(item.priceUsdtCents)}
              <small> / {fmtInt(item.coinPrice)} COIN</small>
            </div>

            {item.equipped ? (
              <button className="btn btn-ghost xs" style={{ width: "100%" }} disabled>
                ✓ Equipped
              </button>
            ) : item.owned ? (
              <button
                className="btn btn-cyan xs"
                style={{ width: "100%" }}
                onClick={() => equip(item.slug, item.category as "skin" | "button")}
                disabled={busy !== null}
              >
                {busy === item.slug ? "…" : "Equip"}
              </button>
            ) : (
              <div className="row" style={{ gap: 5 }}>
                <button
                  className="btn btn-gold xs"
                  style={{ flex: 1 }}
                  onClick={() => buy(item.slug, item.name, "TON")}
                  disabled={busy !== null}
                  title={`${item.priceTon} TON to the treasury`}
                >
                  {busy === item.slug ? "…" : "TON"}
                </button>
                <button
                  className="btn btn-ghost xs"
                  style={{ flex: 1 }}
                  onClick={() => buy(item.slug, item.name, "COIN")}
                  disabled={busy !== null || state.profile.balanceCoin < item.coinPrice}
                  title="Pay with mined coins"
                >
                  COIN
                </button>
              </div>
            )}

            {!item.owned && (
              <button
                className="btn btn-ghost xs"
                style={{ width: "100%", marginTop: 5 }}
                onClick={() => buy(item.slug, item.name, "STARS")}
                disabled={busy !== null}
              >
                ⭐ Telegram Stars
              </button>
            )}

            {item.boostPercent > 0 && (
              <div className="charge-note" style={{ marginTop: 6 }}>
                +{item.boostPercent}% tap power while equipped
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="sec-title">
        <h2>
          <span className="dot" /> Your purchases
        </h2>
        <span className="hint">{mineQ.data?.length ?? 0}</span>
      </div>

      <div className="card">
        {mineQ.data?.length ? (
          mineQ.data.map((p) => (
            <div className="list-row" key={p.id}>
              <div className="em">
                {p.status === "paid" || p.status === "offchain" ? "✅" : p.status === "failed" ? "❌" : "⏳"}
              </div>
              <div className="mid">
                <div className="t">
                  {p.itemName} <span className={`tier tier-${p.tier}`}>{p.tier}</span>
                </div>
                <div className="s">
                  {fmtUsd(p.priceUsdtCents)} · {p.payCurrency} · {p.status} ·{" "}
                  {relativeTime(p.createdAt)}
                </div>
              </div>
            </div>
          ))
        ) : (
          <div className="empty">
            <div className="em">🧾</div>
            <div className="t">No purchases yet</div>
            <div className="s">
              Skins and buttons bought here stay on your account and can be equipped on any device.
              Cheapest tier is {fmtUsd(cfg.shopPriceBaseUsdt * 100)}.
            </div>
          </div>
        )}
      </div>

      <div className="foot-note">
        Cosmetics are saved to your account, so they follow you to any device you sign in on.
      </div>
    </section>
  );
}
