// ── AGENT-OWNED: every shop asset's REAL gameplay effect ──────────────────────
//
// A cosmetic that changes nothing is a dead purchase. Every catalogue row
// carries an `ItemEffects` record, and the equipped skin + equipped button
// together are the SINGLE source of gameplay bonuses. The server recomputes the
// combined record from the player's OWNED rows on every equip, so a client can
// never assert a bonus it did not buy — and buying an item you do not equip
// changes nothing, exactly as the shop promises.
//
// Tier curves are STRICTLY increasing in every stat they carry, so a higher tier
// is always a stronger item and never a sidegrade. That is the property the
// `item-effects.test.ts` guard pins down.
import type { GameConfig } from "./game-config";

export interface ItemEffects {
  /** % added to the per-tap reward — the headline "tap power" bonus. */
  tapPercent: number;
  /** Flat increase to the energy ceiling (more taps per refill). */
  energyCapBonus: number;
  /** % faster passive energy regeneration. */
  energyRegenPercent: number;
  /** % added to the combo ramp — combos build faster and cap higher. */
  comboBonusPercent: number;
  /** Flat passive COIN per hour, stacking on top of mining rigs. */
  passivePerHour: number;
}

export const ZERO_EFFECTS: ItemEffects = {
  tapPercent: 0,
  energyCapBonus: 0,
  energyRegenPercent: 0,
  comboBonusPercent: 0,
  passivePerHour: 0,
};

export interface EffectLine {
  key: keyof ItemEffects;
  icon: string;
  label: string;
  short: string;
}

/**
 * Skin curve — the coin. Skins are the OFFENSIVE slot: they multiply what a tap
 * is worth and trickle passive income, but they never touch energy.
 *   Common 0.50 · Rare 1.00 · Epic 2.00 · Legendary 4.00 · Mythic 8.00
 */
const SKIN_CURVE: readonly ItemEffects[] = [
  { tapPercent: 3, energyCapBonus: 0, energyRegenPercent: 0, comboBonusPercent: 0, passivePerHour: 10 },
  { tapPercent: 8, energyCapBonus: 0, energyRegenPercent: 0, comboBonusPercent: 0, passivePerHour: 30 },
  { tapPercent: 16, energyCapBonus: 0, energyRegenPercent: 0, comboBonusPercent: 0, passivePerHour: 70 },
  { tapPercent: 28, energyCapBonus: 0, energyRegenPercent: 0, comboBonusPercent: 0, passivePerHour: 150 },
  { tapPercent: 45, energyCapBonus: 0, energyRegenPercent: 0, comboBonusPercent: 0, passivePerHour: 320 },
];

/**
 * Button curve — the tap surface. Buttons are the ENDURANCE slot: they raise the
 * energy ceiling, speed regeneration and fatten the combo, so they increase how
 * MANY taps you get rather than what each one is worth. Splitting the two slots
 * this way is what makes equipping a real choice instead of always taking the
 * highest tier.
 */
const BUTTON_CURVE: readonly ItemEffects[] = [
  { tapPercent: 0, energyCapBonus: 50, energyRegenPercent: 5, comboBonusPercent: 2, passivePerHour: 0 },
  { tapPercent: 0, energyCapBonus: 120, energyRegenPercent: 10, comboBonusPercent: 5, passivePerHour: 0 },
  { tapPercent: 0, energyCapBonus: 250, energyRegenPercent: 18, comboBonusPercent: 9, passivePerHour: 0 },
  { tapPercent: 0, energyCapBonus: 450, energyRegenPercent: 28, comboBonusPercent: 14, passivePerHour: 0 },
  { tapPercent: 0, energyCapBonus: 800, energyRegenPercent: 40, comboBonusPercent: 22, passivePerHour: 0 },
];

export const TIER_NAMES = ["Common", "Rare", "Epic", "Legendary", "Mythic"] as const;

/** The effect record for a catalogue item, derived from its category + tier. */
export function tierEffects(category: string, tierIndex: number): ItemEffects {
  const curve = category === "button" ? BUTTON_CURVE : SKIN_CURVE;
  const idx = Math.max(0, Math.min(curve.length - 1, Math.floor(tierIndex)));
  return { ...(curve[idx] ?? ZERO_EFFECTS) };
}

/**
 * Coerce anything that came out of a jsonb column (or an older row written
 * before this column existed) into a complete, finite `ItemEffects`. A missing
 * or malformed field must degrade to "no bonus", never to NaN — a NaN tap
 * reward would corrupt a real balance.
 */
export function normalizeEffects(raw: unknown): ItemEffects {
  if (!raw || typeof raw !== "object") return { ...ZERO_EFFECTS };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
  };
  return {
    tapPercent: num(r.tapPercent),
    energyCapBonus: num(r.energyCapBonus),
    energyRegenPercent: num(r.energyRegenPercent),
    comboBonusPercent: num(r.comboBonusPercent),
    passivePerHour: num(r.passivePerHour),
  };
}

/** Additive combination — a skin effect plus a button effect. */
export function combineEffects(a: ItemEffects, b: ItemEffects): ItemEffects {
  return {
    tapPercent: a.tapPercent + b.tapPercent,
    energyCapBonus: a.energyCapBonus + b.energyCapBonus,
    energyRegenPercent: a.energyRegenPercent + b.energyRegenPercent,
    comboBonusPercent: a.comboBonusPercent + b.comboBonusPercent,
    passivePerHour: a.passivePerHour + b.passivePerHour,
  };
}

export function effectsAreEmpty(e: ItemEffects): boolean {
  return (
    e.tapPercent === 0 &&
    e.energyCapBonus === 0 &&
    e.energyRegenPercent === 0 &&
    e.comboBonusPercent === 0 &&
    e.passivePerHour === 0
  );
}

/** Only the non-zero effects, as display lines. Drives the shop cards and the
 *  "active bonuses" panel on the Mine screen from one source of truth. */
export function effectLines(e: ItemEffects): EffectLine[] {
  const out: EffectLine[] = [];
  if (e.tapPercent > 0) {
    out.push({
      key: "tapPercent",
      icon: "✊",
      label: `+${e.tapPercent}% tap power`,
      short: `+${e.tapPercent}% tap`,
    });
  }
  if (e.energyCapBonus > 0) {
    out.push({
      key: "energyCapBonus",
      icon: "🔋",
      label: `+${e.energyCapBonus.toLocaleString("en-US")} energy cap`,
      short: `+${e.energyCapBonus} energy`,
    });
  }
  if (e.energyRegenPercent > 0) {
    out.push({
      key: "energyRegenPercent",
      icon: "♻️",
      label: `+${e.energyRegenPercent}% energy regen`,
      short: `+${e.energyRegenPercent}% regen`,
    });
  }
  if (e.comboBonusPercent > 0) {
    out.push({
      key: "comboBonusPercent",
      icon: "🔥",
      label: `+${e.comboBonusPercent}% combo power`,
      short: `+${e.comboBonusPercent}% combo`,
    });
  }
  if (e.passivePerHour > 0) {
    out.push({
      key: "passivePerHour",
      icon: "⚙️",
      label: `+${e.passivePerHour.toLocaleString("en-US")} COIN / hour`,
      short: `+${e.passivePerHour}/hr`,
    });
  }
  return out;
}

export function effectChips(e: ItemEffects): string[] {
  return effectLines(e).map((l) => l.short);
}

// ── derived economy values ───────────────────────────────────────────────────
// These two are the ONLY places the equipped record changes a core number, and
// both server and client read them, so the displayed ceiling can never disagree
// with the enforced one.

/** The player's real energy ceiling, including the equipped button's bonus. */
export function effectiveEnergyCap(cfg: GameConfig, e: ItemEffects): number {
  return Math.max(1, Math.round(cfg.energyCap + e.energyCapBonus));
}

/** Seconds per 1 energy, shortened by the equipped button's regen bonus. */
export function effectiveRegenSeconds(cfg: GameConfig, e: ItemEffects): number {
  const mult = 1 + Math.max(0, e.energyRegenPercent) / 100;
  return Math.max(0.1, cfg.energyRegenSeconds / mult);
}
