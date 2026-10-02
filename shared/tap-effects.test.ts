import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./game-config";
import type { GameConfig } from "./game-config";
import { combineEffects, tierEffects, ZERO_EFFECTS } from "./item-effects";
import { settleTapBatch, tapRewardPerTap, tapRewardPerTapExact } from "./game-rules";

// The whole point of item effects is that a tap is worth MORE after buying and
// equipping something. These tests pin that down at the reward level, because a
// bug here is invisible in the UI: the card shows "+45%" while the player is
// paid exactly what they were paid before.
const cfg: GameConfig = DEFAULT_CONFIG;

const freshState = (over: Partial<Parameters<typeof settleTapBatch>[1]> = {}) => ({
  energy: cfg.energyCap,
  energyUpdatedAt: new Date(0),
  tapPowerLevel: 1,
  itemBoostPercent: 0,
  turboUntil: null,
  comboCount: 0,
  lastTapAt: null,
  leagueCoinMined: 0,
  effects: ZERO_EFFECTS,
  ...over,
});

describe("tap reward scales with the equipped item", () => {
  it("raises the exact per-tap figure by the item's tap bonus", () => {
    const base = tapRewardPerTapExact(cfg, {
      leagueMult: 1, tapPowerLevel: 1, comboMult: 1, itemBoostPercent: 0, turbo: false,
    });
    const mythic = tapRewardPerTapExact(cfg, {
      leagueMult: 1, tapPowerLevel: 1, comboMult: 1,
      itemBoostPercent: tierEffects("skin", 4).tapPercent, turbo: false,
    });
    // +45% on a base of 1 COIN.
    expect(base).toBe(1);
    expect(mythic).toBeCloseTo(1.45, 5);
    expect(mythic).toBeGreaterThan(base);
  });

  it("does NOT round a sub-100% bonus away in the display figure", () => {
    // The regression this guards: a +16% skin rounds 1.16 → 1, so the shop's
    // preview showed "1 → 1" and the item looked like it did nothing.
    const rare = tapRewardPerTapExact(cfg, {
      leagueMult: 1, tapPowerLevel: 1, comboMult: 1, itemBoostPercent: 8, turbo: false,
    });
    expect(tapRewardPerTap(cfg, {
      leagueMult: 1, tapPowerLevel: 1, comboMult: 1, itemBoostPercent: 8, turbo: false,
    })).toBe(1);
    expect(rare).toBeCloseTo(1.08, 5);
  });
});

describe("settleTapBatch carries the sub-coin fraction forward", () => {
  const effects = combineEffects(tierEffects("skin", 4), ZERO_EFFECTS); // +45%

  it("pays the bonus out over a run of taps instead of losing it", () => {
    // 1.45 COIN/tap: 20 taps is 29 exactly, 10 taps is 14.5 → 14 paid, 0.5 kept.
    const twenty = settleTapBatch(cfg, freshState({ effects }), 20, new Date(0));
    expect(twenty.coins).toBe(29);

    const ten = settleTapBatch(cfg, freshState({ effects }), 10, new Date(0));
    expect(ten.coins).toBe(14);
    expect(ten.coinCarry).toBeCloseTo(0.5, 5);
  });

  it("the carried remainder reaches the player on the next batch", () => {
    // This is the property that makes a small bonus real: without the carry, a
    // bonus under 1 COIN/tap would round to nothing on EVERY batch forever.
    const first = settleTapBatch(cfg, freshState({ effects }), 10, new Date(0));
    const second = settleTapBatch(
      cfg,
      freshState({ effects, coinCarry: first.coinCarry }),
      10,
      new Date(60_000),
    );
    expect(first.coins + second.coins).toBe(29); // 14 + 15, not 14 + 14
  });

  it("a no-bonus player still gets whole coins and no remainder", () => {
    const r = settleTapBatch(cfg, freshState(), 10, new Date(0));
    expect(r.coins).toBe(10);
    expect(r.coinCarry).toBe(0);
  });

  it("never pays for more taps than the energy allows", () => {
    const r = settleTapBatch(cfg, freshState({ energy: 3, effects }), 10, new Date(0));
    expect(r.taps).toBe(3);
    expect(r.truncated).toBe(true);
  });
});

describe("energy effects reach the settled state", () => {
  it("an equipped button raises the enforced ceiling", () => {
    const button = tierEffects("button", 4); // +800 cap
    const r = settleTapBatch(cfg, freshState({ energy: 10, effects: button }), 5, new Date(0));
    // Regen fills to the EFFECTIVE cap, so the bonus is reachable in play.
    expect(r.energy).toBeLessThanOrEqual(cfg.energyCap + 800);
  });
});
