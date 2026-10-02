import { describe, expect, it } from "vitest";
import {
  combineEffects,
  effectLines,
  effectiveEnergyCap,
  effectiveRegenSeconds,
  effectsAreEmpty,
  normalizeEffects,
  tierEffects,
  ZERO_EFFECTS,
} from "./item-effects";
import { DEFAULT_CONFIG } from "./game-config";

// The user-visible promise is "higher tiers give strictly stronger effects".
// That is a property, not a number, so it is checked as one — a future tweak to
// a curve that accidentally creates a sidegrade fails here instead of shipping.
describe("tier effect curves", () => {
  for (const category of ["skin", "button"] as const) {
    it(`${category}: every stat is strictly increasing across all 5 tiers`, () => {
      for (let t = 1; t < 5; t++) {
        const prev = tierEffects(category, t - 1);
        const cur = tierEffects(category, t);
        for (const key of Object.keys(prev) as (keyof typeof prev)[]) {
          // A stat that is zero at every tier (e.g. tapPercent on a button) is
          // fine; a stat that MOVES must only ever move up.
          const movedAtAll = prev[key] !== 0 || cur[key] !== 0;
          if (!movedAtAll) continue;
          expect(
            cur[key],
            `${category} tier ${t} ${key}: ${prev[key]} → ${cur[key]} is not an increase`,
          ).toBeGreaterThan(prev[key]);
        }
      }
    });

    it(`${category}: every tier actually does something`, () => {
      for (let t = 0; t < 5; t++) {
        expect(effectsAreEmpty(tierEffects(category, t)), `tier ${t} is inert`).toBe(false);
      }
    });
  }

  it("the two slots are complementary, not duplicates", () => {
    // Skins own tap power; buttons own energy. If both carried the same stat the
    // equip choice would be trivial and the shop would be selling one item twice.
    expect(tierEffects("skin", 4).tapPercent).toBeGreaterThan(0);
    expect(tierEffects("button", 4).tapPercent).toBe(0);
    expect(tierEffects("button", 4).energyCapBonus).toBeGreaterThan(0);
    expect(tierEffects("skin", 4).energyCapBonus).toBe(0);
  });

  it("clamps out-of-range tiers instead of returning undefined", () => {
    expect(tierEffects("skin", -3)).toEqual(tierEffects("skin", 0));
    expect(tierEffects("skin", 99)).toEqual(tierEffects("skin", 4));
    expect(tierEffects("unknown-category", 2)).toEqual(tierEffects("skin", 2));
  });
});

describe("normalizeEffects", () => {
  it("turns garbage into zeroes rather than NaN", () => {
    // A NaN reaching a tap reward would corrupt a real coin balance, so every
    // path out of the jsonb column has to land on a finite number.
    for (const bad of [null, undefined, 42, "nope", [], { tapPercent: "x" }]) {
      const e = normalizeEffects(bad);
      for (const v of Object.values(e)) expect(Number.isFinite(v)).toBe(true);
    }
    expect(normalizeEffects({ tapPercent: 12 })).toEqual({ ...ZERO_EFFECTS, tapPercent: 12 });
    expect(normalizeEffects({ tapPercent: "12", passivePerHour: 5 })).toEqual({
      ...ZERO_EFFECTS,
      tapPercent: 12,
      passivePerHour: 5,
    });
  });
});

describe("combineEffects", () => {
  it("adds a skin and a button together", () => {
    const combined = combineEffects(tierEffects("skin", 4), tierEffects("button", 4));
    expect(combined.tapPercent).toBe(45);
    expect(combined.energyCapBonus).toBe(800);
    expect(combined.passivePerHour).toBe(320);
  });

  it("an empty pair is still empty", () => {
    expect(effectsAreEmpty(combineEffects(ZERO_EFFECTS, ZERO_EFFECTS))).toBe(true);
  });
});

describe("derived economy values", () => {
  it("raises the energy ceiling by the button bonus", () => {
    expect(effectiveEnergyCap(DEFAULT_CONFIG, ZERO_EFFECTS)).toBe(DEFAULT_CONFIG.energyCap);
    expect(effectiveEnergyCap(DEFAULT_CONFIG, tierEffects("button", 4))).toBe(
      DEFAULT_CONFIG.energyCap + 800,
    );
  });

  it("shortens regen time and never divides by zero", () => {
    expect(effectiveRegenSeconds(DEFAULT_CONFIG, ZERO_EFFECTS)).toBeCloseTo(
      DEFAULT_CONFIG.energyRegenSeconds,
    );
    const fast = effectiveRegenSeconds(DEFAULT_CONFIG, tierEffects("button", 4));
    expect(fast).toBeLessThan(DEFAULT_CONFIG.energyRegenSeconds);
    expect(fast).toBeGreaterThan(0);
  });
});

describe("effectLines", () => {
  it("describes exactly the non-zero stats", () => {
    expect(effectLines(ZERO_EFFECTS)).toEqual([]);
    const lines = effectLines(tierEffects("button", 2));
    expect(lines.map((l) => l.key).sort()).toEqual(
      ["comboBonusPercent", "energyCapBonus", "energyRegenPercent"].sort(),
    );
    // Every line must be human-readable, since it renders straight onto a card.
    for (const l of lines) {
      expect(l.label.length).toBeGreaterThan(3);
      expect(l.label).not.toContain("undefined");
    }
  });
});
