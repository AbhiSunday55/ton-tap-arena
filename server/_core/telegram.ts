// ── Telegram Mini App initData validation ────────────────────────────────────
// The ONLY trustworthy way to learn who a Telegram player is. `initData` is a
// URL-encoded payload Telegram signs with a key derived from the bot token, so
// a client cannot forge one without the token — which never leaves the server.
//
// Algorithm (Telegram's documented scheme):
//   1. Parse initData as query params; pull out `hash` and `signature`.
//   2. Build `data_check_string` = every remaining `key=value`, sorted by key,
//      joined with "\n".
//   3. secret_key = HMAC_SHA256(key="WebAppData", message=bot_token)
//   4. computed   = HMAC_SHA256(key=secret_key,  message=data_check_string)
//   5. computed must equal `hash` (timing-safe compare).
//
// Step 3 is the one people get backwards: the literal string "WebAppData" is
// the HMAC *key* and the bot token is the *message*. Swapping them produces a
// hash that never matches, which looks exactly like "Telegram is broken".
import { createHmac, timingSafeEqual } from "node:crypto";

/** How long a signed payload stays usable. Telegram re-issues initData on every
 *  launch, so a day is generous while still bounding a captured payload. */
export const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

export interface TelegramUser {
  id: string;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
  isPremium?: boolean;
  photoUrl?: string;
}

export type InitDataResult =
  | { ok: true; user: TelegramUser; authDate: number }
  | { ok: false; reason: string };

/** HMAC-SHA256 helper — `key` is the HMAC key, `message` the data. */
function hmac(key: string | Buffer, message: string): Buffer {
  return createHmac("sha256", key).update(message).digest();
}

/**
 * Derive the per-bot secret key. Exported so a test can prove the derivation
 * against a known-good vector rather than re-implementing it.
 */
export function deriveSecretKey(botToken: string): Buffer {
  return hmac("WebAppData", botToken);
}

/** Constant-time hex comparison that never throws on a length mismatch. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Validate a raw `initData` string against the bot token.
 *
 * Returns a discriminated result rather than throwing: every failure mode
 * (missing hash, bad signature, stale payload, malformed user JSON) is a
 * distinct `reason`, which is what makes the rejection path testable and
 * diagnosable instead of a single opaque "invalid".
 */
export function validateInitData(
  initData: string,
  botToken: string,
  opts: { maxAgeSeconds?: number; now?: number } = {},
): InitDataResult {
  if (!botToken) return { ok: false, reason: "bot token not configured" };
  if (!initData || typeof initData !== "string") {
    return { ok: false, reason: "initData is empty" };
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "initData is not parseable" };
  }

  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "initData has no hash" };

  // `signature` (Ed25519, for third-party validation) is NOT part of the HMAC
  // data-check string — including it would break the hash for every payload
  // that carries one.
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash" || key === "signature") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = deriveSecretKey(botToken);
  const computed = hmac(secretKey, dataCheckString).toString("hex");

  if (!safeEqualHex(computed, hash)) {
    return { ok: false, reason: "signature mismatch" };
  }

  const authDateRaw = params.get("auth_date");
  const authDate = Number(authDateRaw);
  if (!authDateRaw || !Number.isFinite(authDate)) {
    return { ok: false, reason: "initData has no auth_date" };
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const maxAge = opts.maxAgeSeconds ?? INIT_DATA_MAX_AGE_SECONDS;
  if (now - authDate > maxAge) {
    return { ok: false, reason: "initData has expired" };
  }
  // A payload dated in the future is not something Telegram produces.
  if (authDate - now > 60) {
    return { ok: false, reason: "initData is dated in the future" };
  }

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, reason: "initData has no user" };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(userRaw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "user payload is not valid JSON" };
  }

  const id = parsed.id;
  if (typeof id !== "number" && typeof id !== "string") {
    return { ok: false, reason: "user payload has no id" };
  }

  const user: TelegramUser = {
    id: String(id),
    firstName: typeof parsed.first_name === "string" ? parsed.first_name : "",
    lastName: typeof parsed.last_name === "string" ? parsed.last_name : undefined,
    username: typeof parsed.username === "string" ? parsed.username : undefined,
    languageCode: typeof parsed.language_code === "string" ? parsed.language_code : undefined,
    isPremium: parsed.is_premium === true,
    photoUrl: typeof parsed.photo_url === "string" ? parsed.photo_url : undefined,
  };

  return { ok: true, user, authDate };
}

/** The placeholder address a Telegram account is keyed on. Deterministic, so a
 *  returning player always resolves to the same row. */
export function telegramPlaceholderEmail(telegramId: string): string {
  return `tg${telegramId}@telegram.local`;
}

/** Display handle for a Telegram user, falling back through the fields Telegram
 *  actually populates (username is optional; first_name is not). */
export function telegramHandle(user: TelegramUser): string {
  const full = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return full || user.username || `Player ${user.id}`;
}
