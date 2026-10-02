import { useCallback, useState } from "react";
import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { trpc } from "../_core/trpc";
import { useGame } from "../lib/store";
import { useAudio } from "../lib/audio";
import { fmtCoin, fmtInt, fmtUsd, relativeTime } from "../lib/format";
import {
  combineEffects,
  effectiveEnergyCap,
  effectLines,
  normalizeEffects,
  ZERO_EFFECTS,
  type ItemEffects,
} from "../../../shared/item-effects";
import { tapRewardPerTapExact } from "../../../shared/game-rules";

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
 * Buying an item equips it immediately (a purchase that changed nothing is the
 * complaint this shop exists to fix), and the Equip / Unequip controls let the
 * player switch back. Every bonus shown here is recomputed by the server from
 * what the account actually owns, so the card and the tap reward agree.
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
  const equipM = trpc.game.equipItem.useMutation();

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

  /**
   * Equip, or clear the slot by passing an empty slug. The server re-derives the
   * whole effect record and returns the new state, so the Mine screen's tap
   * power updates from the same source of truth the calculator uses.
   */
  const equip = useCallback(
    async (slug: string | null, category: "skin" | "button") => {
      setBusy(slug ?? `clear:${category}`);
      try {
        const next = await equipM.mutateAsync({ category, slug });
        applyState(next);
        sfx(slug ? "claim" : "tap");
        toast(slug ? "Equipped — bonus is live" : "Unequipped — bonus removed", "ok");
        void listQ.refetch();
      } catch (e) {
        sfx("error");
        toast(e instanceof Error ? e.message : "Could not equip", "err");
      } finally {
        setBusy(null);
      }
    },
    [equipM, applyState, sfx, toast, listQ],
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
  const all = listQ.data.items;
  const items = all.filter((i) => i.category === tab);
  const ownedCount = all.filter((i) => i.owned).length;

  // The currently equipped pair, so a candidate's before/after preview can be
  // computed exactly: swap the one slot under evaluation, keep the other.
  const curSkin = all.find((i) => i.category === "skin" && i.equipped);
  const curBtn = all.find((i) => i.category === "button" && i.equipped);
  const skinEffects = curSkin ? normalizeEffects(curSkin.effects) : ZERO_EFFECTS;
  const btnEffects = curBtn ? normalizeEffects(curBtn.effects) : ZERO_EFFECTS;

  /** What the loadout would be if `item` were equipped instead. */
  const loadoutAfter = (item: (typeof all)[number]): ItemEffects =>
    combineEffects(
      item.category === "skin" ? normalizeEffects(item.effects) : skinEffects,
      item.category === "button" ? normalizeEffects(item.effects) : btnEffects,
    );

  /** Concrete COIN per tap at combo ×1, so both sides compare like for like.
   *  Unexpanded, because a +16% skin on a base of 1 COIN only shows up in the
   *  decimals — rounded, the preview would claim the item changed nothing. */
  const tapAt = (effects: ItemEffects): number =>
    tapRewardPerTapExact(cfg, {
      leagueMult: state.league.mult,
      tapPowerLevel: state.profile.tapPowerLevel,
      comboMult: 1,
      itemBoostPercent: effects.tapPercent,
      turbo: false,
    });

  const beforeTap = state.profile.tapPowerPerTapExact;

  const beforeCap = state.profile.energyCap;

  const afterTapFor = (item: (typeof all)[number]): number => tapAt(loadoutAfter(item));
  const afterCapFor = (item: (typeof all)[number]): number =>
    effectiveEnergyCap(cfg, loadoutAfter(item));

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

      {/* The active loadout, so the player can always see what is working. */}
      <div className="card tight" style={{ marginTop: 10 }}>
        <div className="list-row" style={{ borderBottom: "none" }}>
          <div className="em">✊</div>
          <div className="mid">
            <div className="t">
              {fmtCoin(beforeTap)} COIN per tap · {fmtInt(beforeCap)} energy
            </div>
            <div className="s">
              {curSkin || curBtn
                ? `Equipped: ${[curSkin?.name, curBtn?.name].filter(Boolean).join(" + ")}`
                : "No asset equipped — buy one below or equip something you already own"}
            </div>
          </div>
        </div>
      </div>

      <div className="warn-box warn" style={{ marginTop: 10 }}>
        <b>Every asset changes your game</b>
        Skins raise your tap power and add passive income; tap buttons raise your energy cap,
        speed up regen and boost combos. Buying one equips it right away, and you can switch or
        remove it any time.
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
              <div className="row" style={{ gap: 5 }}>
                <button className="btn btn-ghost xs" style={{ flex: 1 }} disabled>
                  ✓ Equipped
                </button>
                <button
                  className="btn btn-ghost xs"
                  style={{ flex: 1 }}
                  onClick={() => equip(null, item.category as "skin" | "button")}
                  disabled={busy !== null}
                  title="Remove this item's bonus"
                >
                  {busy === `clear:${item.category}` ? "…" : "Unequip"}
                </button>
              </div>
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

            {/* What this item actually does, straight from its server-side record. */}
            <div className="fx-chips">
              {effectLines(normalizeEffects(item.effects)).map((l) => (
                <span className="fx-chip" key={l.key}>
                  <b>{l.icon}</b> {l.label}
                </span>
              ))}
            </div>

            {/* Before → after, computed with the identical tap formula the
                server enforces, so the preview cannot promise what it will not do. */}
            <div className={`fx-preview ${item.equipped ? "on" : ""}`}>
              {item.equipped ? (
                <span>
                  Active now · {fmtCoin(beforeTap)} COIN/tap · {fmtInt(beforeCap)} energy
                </span>
              ) : (
                (() => {
                  // A lower tier REPLACES a higher one, so this preview can
                  // legitimately go down. Showing only "1.45 → 1.03" reads as a
                  // bug on a card advertising "+3% tap power", so the delta is
                  // always stated in words.
                  const next = afterTapFor(item);
                  const delta = next - beforeTap;
                  const pct = beforeTap > 0 ? (delta / beforeTap) * 100 : 0;
                  return (
                    <>
                      <span className="was">{fmtCoin(beforeTap)}/tap</span>
                      <span className="arw">→</span>
                      <span className={delta >= 0 ? "now" : "now down"}>
                        {fmtCoin(next)}/tap
                      </span>
                      <span className={delta >= 0 ? "delta" : "delta down"}>
                        {delta >= 0 ? "▲ +" : "▼ "}
                        {fmtCoin(Math.abs(delta))} ({pct >= 0 ? "+" : ""}
                        {Math.round(pct)}%)
                      </span>
                      {afterCapFor(item) !== beforeCap && (
                        <span className="cap">
                          · {fmtInt(afterCapFor(item))} energy
                        </span>
                      )}
                      {/* Says WHY the number can fall: a different tier in the
                          same slot swaps the equipped item out. Without this,
                          "1.45 → 1.03" on a "+3% tap power" card looks broken. */}
                      {(() => {
                        const cur = all.find((i) => i.equipped && i.category === item.category);
                        return cur ? <span className="rep">· replaces {cur.name}</span> : null;
                      })()}
                    </>
                  );
                })()
              )}
            </div>
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
