import type { GameConfig } from "./api-types";

export const NANO = 1_000_000_000;

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** 1_234 → "1.23K", 5_400_000 → "5.40M" */
export function fmtShort(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return fmtInt(n);
}

export function nanoToTon(nano: number): number {
  return nano / NANO;
}

/** Trim trailing zeros: 5.250 → "5.25", 2.0000 → "2". */
export function fmtTon(nano: number, dp = 4): string {
  const s = nanoToTon(nano).toFixed(dp);
  return s.replace(/\.?0+$/, "") || "0";
}

export function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function truncAddress(addr: string | null | undefined, head = 6, tail = 6): string {
  if (!addr) return "—";
  if (addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** "3h 20m" / "45s" until a future ISO timestamp. */
export function untilLabel(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "ready";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** `priceUSDT = base × 2^tierIndex` — the spec's shop formula. */
export function tierUsd(cfg: GameConfig, tierIndex: number): number {
  return cfg.shopPriceBaseUsdt * Math.pow(cfg.shopTierMultiplier, tierIndex);
}

export function tierUsdLabel(cfg: GameConfig, tierIndex: number): string {
  return `$${tierUsd(cfg, tierIndex).toFixed(2)}`;
}

export function tierCoinPrice(cfg: GameConfig, tierIndex: number): number {
  return Math.round(cfg.shopPriceBaseUsdt * cfg.shopCoinMultiplier * Math.pow(cfg.shopTierMultiplier, tierIndex));
}

/** Strips the tier name down to a CSS class suffix (Common/Rare/Epic/…). */
export function tierClass(tier: string): string {
  return `tier-${tier.replace(/[^A-Za-z]/g, "")}`;
}

export function leagueFor(cfg: GameConfig, totalCoinMined: number): number {
  let idx = 0;
  cfg.leagueThresholds.forEach((t, i) => {
    if (totalCoinMined >= t) idx = i;
  });
  return idx;
}

export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
