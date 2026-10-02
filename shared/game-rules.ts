// ── AGENT-OWNED: pure game rules ─────────────────────────────────────────────
// Every reward decision lives here as a plain function of its inputs, so the
// server can never be talked into a number by the client, and the rules are
// unit-testable without a database. Routers compose these; nothing here touches
// the DB or the clock (the caller passes `now` in).
import {
  DEFAULT_CONFIG,
  leagueFor,
  resolveConfig,
  type GameConfig,
} from "../shared/game-config";
import {
  effectiveEnergyCap,
  effectiveRegenSeconds,
  ZERO_EFFECTS,
  type ItemEffects,
} from "../shared/item-effects";

export { resolveConfig, leagueFor };
export type { GameConfig };

export interface RigsOwned {
  scrap_rig?: number;
  steel_rig?: number;
  plasma_rig?: number;
  quantum_rig?: number;
  [k: string]: number | undefined;
}

export interface BoosterUsage {
  turbo: number;
  energy: number;
  recharge: number;
}

const RIG_KEYS = ["scrap_rig", "steel_rig", "plasma_rig", "quantum_rig"];

/**
 * Energy regenerates lazily. `effects` raises the ceiling and shortens the tick;
 * both are passed through the helpers in item-effects.ts so the enforced numbers
 * are the same ones the UI displays.
 */
export function regenEnergy(
  cfg: GameConfig,
  energy: number,
  energyUpdatedAt: Date,
  now: Date,
  effects: ItemEffects = ZERO_EFFECTS,
): { energy: number; energyUpdatedAt: Date } {
  const cap = effectiveEnergyCap(cfg, effects);
  const regenSeconds = effectiveRegenSeconds(cfg, effects);
  if (energy >= cap) return { energy: cap, energyUpdatedAt: now };
  const seconds = Math.max(0, (now.getTime() - energyUpdatedAt.getTime()) / 1000);
  const gained = Math.floor(seconds / Math.max(0.1, regenSeconds));
  if (gained <= 0) return { energy, energyUpdatedAt };
  const next = Math.min(cap, energy + gained);
  if (next >= cap) return { energy: cap, energyUpdatedAt: now };
  // Keep the sub-unit remainder: advancing by the whole step only.
  const consumedMs = gained * regenSeconds * 1000;
  return { energy: next, energyUpdatedAt: new Date(energyUpdatedAt.getTime() + consumedMs) };
}

export function turboActive(
  _cfg: GameConfig,
  turboUntil: Date | null | undefined,
  now: Date,
): boolean {
  return !!turboUntil && turboUntil.getTime() > now.getTime();
}

/**
 * Returns BOTH the next combo count and the multiplier it earns.
 *
 * `effects.comboBonusPercent` scales the ramp AND the ceiling, so an engaged
 * button's combo bonus is worth real coins — a bare "+N% combo" that only nudged
 * the step would be invisible once the cap was reached.
 */
export function comboFor(
  cfg: GameConfig,
  comboCount: number,
  lastTapAt: Date | null | undefined,
  now: Date,
  effects: ItemEffects = ZERO_EFFECTS,
): { count: number; mult: number } {
  const fresh =
    !!lastTapAt && now.getTime() - lastTapAt.getTime() <= cfg.comboWindowMs;
  const count = fresh ? comboCount + 1 : 1;
  const bonus = 1 + Math.max(0, effects.comboBonusPercent) / 100;
  const step = cfg.comboStepPercent * bonus;
  const ceil = cfg.comboMaxMultiplier * bonus;
  const mult = Math.min(ceil, 1 + ((count - 1) * step) / 100);
  return { count, mult: Math.round(mult * 100) / 100 };
}

/**
 * Exact, UNROUNDED reward for a single tap.
 *
 * This exists because rounding per tap destroys every bonus below 100%: a base
 * reward of 1 with a +45% skin is 1.45, which `Math.round` sends straight back
 * to 1 — the player pays for the item and their tap is worth exactly what it was
 * before. The integer the player is paid therefore comes from
 * `settleTapBatch`, which carries the leftover fraction forward so the bonus
 * accumulates into whole coins instead of evaporating on every tap.
 */
export function tapRewardPerTapExact(
  cfg: GameConfig,
  args: {
    leagueMult: number;
    tapPowerLevel: number;
    comboMult: number;
    itemBoostPercent: number;
    turbo: boolean;
  },
): number {
  const base =
    cfg.tapBaseReward * args.tapPowerLevel * args.leagueMult * args.comboMult;
  const withItems = base * (1 + args.itemBoostPercent / 100);
  const withTurbo = args.turbo ? withItems * cfg.turboMultiplier : withItems;
  return Math.max(0, withTurbo);
}

/** The one place a tap reward is computed, for display. */
export function tapRewardPerTap(
  cfg: GameConfig,
  args: {
    leagueMult: number;
    tapPowerLevel: number;
    comboMult: number;
    itemBoostPercent: number;
    turbo: boolean;
  },
): number {
  return Math.max(0, Math.round(tapRewardPerTapExact(cfg, args)));
}

export interface TapBatchResult {
  taps: number;
  coins: number;
  perTap: number;
  /**
   * Sub-coin fraction carried into the next batch. Persisted, so a bonus that
   * pays less than 1 COIN per tap still adds up instead of rounding to nothing.
   */
  coinCarry: number;
  energy: number;
  energyUpdatedAt: Date;
  comboCount: number;
  lastTapAt: Date | null;
  leagueMult: number;
  comboMult: number;
  turbo: boolean;
  /** True when energy ran out before every requested tap could be paid. */
  truncated: boolean;
}

/** Settle a batch of taps. Pure: given state + now, it returns the next state. */
export function settleTapBatch(
  cfg: GameConfig,
  state: {
    energy: number;
    energyUpdatedAt: Date;
    tapPowerLevel: number;
    itemBoostPercent: number;
    turboUntil: Date | null;
    comboCount: number;
    lastTapAt: Date | null;
    leagueCoinMined: number;
    /** Sub-coin fraction carried in from the previous batch. */
    coinCarry?: number;
    /** The equipped skin + button effects. Defaults to none. */
    effects?: ItemEffects;
  },
  requestedTaps: number,
  now: Date,
): TapBatchResult {
  const effects = state.effects ?? ZERO_EFFECTS;
  const cap = effectiveEnergyCap(cfg, effects);
  const taps = Math.max(0, Math.min(cfg.tapBatchMax, Math.floor(requestedTaps)));
  const regen = regenEnergy(cfg, state.energy, state.energyUpdatedAt, now, effects);
  const payable = Math.min(taps, regen.energy);

  const combo = comboFor(cfg, state.comboCount, state.lastTapAt, now, effects);
  const comboMult = combo.mult;
  const league = leagueFor(cfg, state.leagueCoinMined);
  const turbo = turboActive(cfg, state.turboUntil, now);
  const perTap = tapRewardPerTap(cfg, {
    leagueMult: league.mult,
    tapPowerLevel: state.tapPowerLevel,
    comboMult,
    itemBoostPercent: effects.tapPercent,
    turbo,
  });
  const perTapExact = tapRewardPerTapExact(cfg, {
    leagueMult: league.mult,
    tapPowerLevel: state.tapPowerLevel,
    comboMult,
    itemBoostPercent: effects.tapPercent,
    turbo,
  });

  // Pay the whole coins now and keep the fraction for the next batch. Without
  // this, every bonus under +100% would round away on each tap.
  const exact = perTapExact * payable + Math.max(0, state.coinCarry ?? 0);
  const coins = Math.floor(exact);
  const coinCarry = exact - coins;

  const energy = regen.energy - payable;
  // Spending energy restarts the regen clock from empty only when we actually
  // drained it; otherwise keep the accumulated remainder.
  const energyUpdatedAt =
    regen.energy >= cap && payable > 0 ? now : regen.energyUpdatedAt;

  return {
    taps: payable,
    coins,
    perTap,
    coinCarry,
    energy,
    energyUpdatedAt,
    comboCount: payable > 0 ? combo.count : state.comboCount,
    lastTapAt: payable > 0 ? now : state.lastTapAt,
    leagueMult: league.mult,
    comboMult,
    turbo,
    truncated: payable < taps,
  };
}

/**
 * Passive income from owned rigs since the last accrual, plus whatever the
 * equipped skin adds per hour. The item trickle is deliberately included here so
 * a cosmetic's passive stat is real income rather than a label.
 */
export function settleRigs(
  cfg: GameConfig,
  rigsOwned: RigsOwned,
  since: Date,
  now: Date,
  effects: ItemEffects = ZERO_EFFECTS,
): { coins: number; at: Date } {
  const seconds = Math.max(0, (now.getTime() - since.getTime()) / 1000);
  let perHour = Math.max(0, effects.passivePerHour);
  for (const key of RIG_KEYS) {
    const lvl = Number(rigsOwned?.[key] ?? 0);
    if (!lvl) continue;
    const def = cfg.rigs[RIG_KEYS.indexOf(key)];
    if (def) perHour += def.perHour * lvl;
  }
  const coins = Math.floor((perHour * seconds) / 3600);
  return { coins, at: now };
}

export function rigCost(cfg: GameConfig, key: string): number {
  const def = cfg.rigs[RIG_KEYS.indexOf(key)];
  return def?.costCoin ?? 0;
}

export function rigPerHour(cfg: GameConfig, key: string): number {
  const def = cfg.rigs[RIG_KEYS.indexOf(key)];
  return def?.perHour ?? 0;
}

export const RIG_KEYS_EXPORT = RIG_KEYS;

export function totalRigPerHour(
  cfg: GameConfig,
  rigsOwned: RigsOwned,
  effects: ItemEffects = ZERO_EFFECTS,
): number {
  return (
    RIG_KEYS.reduce((sum, k, i) => sum + (Number(rigsOwned?.[k] ?? 0) * (cfg.rigs[i]?.perHour ?? 0)), 0) +
    Math.max(0, effects.passivePerHour)
  );
}

/** Booster bookkeeping — counters reset on a new UTC day. */
export function freshBoosterUsage(
  _cfg: GameConfig,
  stored: BoosterUsage | null | undefined,
  storedDayKey: string | null | undefined,
  todayKey: string,
): { usage: BoosterUsage; dayKey: string } {
  if (storedDayKey === todayKey && stored) return { usage: stored, dayKey: todayKey };
  return { usage: { turbo: 0, energy: 0, recharge: 0 }, dayKey: todayKey };
}

export function boosterAvailable(
  cfg: GameConfig,
  usage: BoosterUsage,
  kind: "turbo" | "energy" | "recharge",
  balanceCoin: number,
): { free: boolean; cost: number; allowed: boolean } {
  const freeLimit = { turbo: cfg.turboFreePerDay, energy: cfg.energyRefillFreePerDay, recharge: cfg.rechargeFreePerDay }[kind];
  const cost = { turbo: cfg.turboCostCoin, energy: cfg.energyRefillCostCoin, recharge: cfg.rechargeCostCoin }[kind];
  const used = usage[kind] ?? 0;
  if (used < freeLimit) return { free: true, cost: 0, allowed: true };
  return { free: false, cost, allowed: balanceCoin >= cost };
}

/** Withdrawal maths — the single source of truth for the 5 TON gate. */
export interface WithdrawQuote {
  balanceNanoTon: number;
  thresholdNanoTon: number;
  eligible: boolean;
  shortfallNanoTon: number;
  feeNanoTon: number;
  networkFeeNanoTon: number;
  grossNanoTon: number;
  netNanoTon: number;
  vestedNanoTon: number;
  immediateNanoTon: number;
  progressPercent: number;
}

export function quoteWithdrawal(
  cfg: GameConfig,
  balanceNanoTon: number,
  thresholdNanoTonInput?: number,
): WithdrawQuote {
  const NANO = 1_000_000_000;
  const thresholdNanoTon =
    thresholdNanoTonInput ?? Math.round(cfg.withdrawThresholdTon * NANO);
  const gross = Math.max(0, Math.floor(balanceNanoTon));
  const fee = Math.floor((gross * cfg.withdrawFeePercent) / 100);
  const net = Math.max(0, gross - fee);
  const networkFee = Math.round(cfg.withdrawNetworkFeeTon * NANO);
  const vested = Math.floor((net * cfg.vestedPercent) / 100);
  const eligible = gross >= thresholdNanoTon;
  return {
    balanceNanoTon: gross,
    thresholdNanoTon,
    eligible,
    shortfallNanoTon: eligible ? 0 : thresholdNanoTon - gross,
    feeNanoTon: fee,
    networkFeeNanoTon: networkFee,
    grossNanoTon: gross,
    netNanoTon: net,
    vestedNanoTon: vested,
    immediateNanoTon: net - vested,
    progressPercent:
      thresholdNanoTon <= 0 ? 100 : Math.min(100, Math.round((gross / thresholdNanoTon) * 100)),
  };
}

/** `priceUSDT = base × tierMultiplier^tierIndex` — the spec's shop formula. */
export function tierPriceUsdtCents(cfg: GameConfig, tierIndex: number): number {
  return Math.round(cfg.shopPriceBaseUsdt * 100 * Math.pow(cfg.shopTierMultiplier, tierIndex));
}

export function tierPriceCoin(cfg: GameConfig, tierIndex: number): number {
  return Math.round(
    cfg.shopPriceBaseUsdt * cfg.shopCoinMultiplier * Math.pow(cfg.shopTierMultiplier, tierIndex),
  );
}

export function usdtCentsToNanoTon(cfg: GameConfig, cents: number): number {
  const NANO = 1_000_000_000;
  const ton = (cents / 100) / Math.max(0.0001, cfg.usdtTonRate);
  return Math.round(ton * NANO);
}

export function coinsToNanoTon(cfg: GameConfig, coins: number): number {
  const NANO = 1_000_000_000;
  return Math.round((coins / Math.max(1, cfg.coinsPerTon)) * NANO);
}

export function referralRewardCoin(cfg: GameConfig, premium: boolean): number {
  return premium
    ? cfg.referralRewardCoin * cfg.referralPremiumMultiplier
    : cfg.referralRewardCoin;
}

export function ladderRung(cfg: GameConfig, friendCount: number) {
  let rung: { name: string; friends: number; bonusTon: number } | null = null;
  for (const r of cfg.referralLadder) if (friendCount >= r.friends) rung = r;
  return rung;
}

export const CONFIG_DEFAULTS = DEFAULT_CONFIG;
