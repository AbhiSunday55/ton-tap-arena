import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  deriveSecretKey,
  telegramHandle,
  telegramPlaceholderEmail,
  validateInitData,
} from "./telegram";

// A throwaway token shaped exactly like a real BotFather token. The real token
// is never used in a test — it lives only in the server environment.
const BOT_TOKEN = "123456789:TESTTOKEN_TESTTOKEN_TESTTOKEN_TESTTOKEN";

/** Build a correctly-signed initData payload, the way Telegram does. */
function signInitData(
  fields: Record<string, string>,
  botToken = BOT_TOKEN,
): string {
  // `signature` is excluded from the data-check string, exactly as Telegram
  // does it — signing it would produce a hash the real validator never matches.
  const pairs = Object.entries(fields)
    .filter(([k]) => k !== "signature")
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const dataCheckString = pairs.join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}

const NOW = 1_800_000_000; // fixed clock so the age checks are deterministic

function validFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    auth_date: String(NOW - 60),
    query_id: "AAF_test_query",
    user: JSON.stringify({
      id: 954512685,
      first_name: "Abhijeet",
      last_name: "Borde",
      username: "bordeabhijeet139",
      language_code: "en",
      is_premium: true,
    }),
    ...overrides,
  };
}

describe("deriveSecretKey", () => {
  it("uses 'WebAppData' as the HMAC key and the bot token as the message", () => {
    // The single most common implementation mistake is swapping these two.
    const expected = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    expect(deriveSecretKey(BOT_TOKEN).toString("hex")).toBe(expected.toString("hex"));
  });
});

describe("validateInitData — valid payload", () => {
  it("accepts a correctly signed payload and returns the Telegram user", () => {
    const initData = signInitData(validFields());
    const result = validateInitData(initData, BOT_TOKEN, { now: NOW });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.id).toBe("954512685");
    expect(result.user.firstName).toBe("Abhijeet");
    expect(result.user.username).toBe("bordeabhijeet139");
    expect(result.user.isPremium).toBe(true);
    expect(result.authDate).toBe(NOW - 60);
  });

  it("ignores the `signature` field, which is not part of the HMAC string", () => {
    // Telegram includes an Ed25519 `signature` on newer payloads. Folding it
    // into the data-check string would break every real launch.
    const initData = signInitData(validFields({ signature: "some_ed25519_signature" }));
    const result = validateInitData(initData, BOT_TOKEN, { now: NOW });
    expect(result.ok).toBe(true);
  });
});

describe("validateInitData — tampered payload", () => {
  it("rejects a payload whose user id was swapped after signing", () => {
    const initData = signInitData(validFields());
    const tampered = initData.replace("954512685", "111111111");
    const result = validateInitData(tampered, BOT_TOKEN, { now: NOW });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("signature mismatch");
  });

  it("rejects a payload signed with a different bot token", () => {
    const initData = signInitData(validFields(), "999999999:OTHER_TOKEN_OTHER_TOKEN_OTHER");
    const result = validateInitData(initData, BOT_TOKEN, { now: NOW });
    expect(result.ok).toBe(false);
  });

  it("rejects a payload with the hash stripped", () => {
    const params = new URLSearchParams(validFields());
    const result = validateInitData(params.toString(), BOT_TOKEN, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("initData has no hash");
  });

  it("rejects a payload with a forged hash of the right length", () => {
    const params = new URLSearchParams(validFields());
    params.set("hash", "a".repeat(64));
    const result = validateInitData(params.toString(), BOT_TOKEN, { now: NOW });
    expect(result.ok).toBe(false);
  });
});

describe("validateInitData — freshness", () => {
  it("rejects a payload older than the max age", () => {
    const initData = signInitData(validFields({ auth_date: String(NOW - 60 * 60 * 48) }));
    const result = validateInitData(initData, BOT_TOKEN, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("initData has expired");
  });

  it("rejects a payload dated in the future", () => {
    const initData = signInitData(validFields({ auth_date: String(NOW + 600) }));
    const result = validateInitData(initData, BOT_TOKEN, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("initData is dated in the future");
  });
});

describe("validateInitData — malformed input", () => {
  it("rejects an empty payload", () => {
    expect(validateInitData("", BOT_TOKEN, { now: NOW }).ok).toBe(false);
  });

  it("rejects when no bot token is configured", () => {
    const initData = signInitData(validFields());
    const result = validateInitData(initData, "", { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bot token not configured");
  });

  it("rejects a payload whose user field is not JSON", () => {
    const initData = signInitData(validFields({ user: "not-json" }));
    const result = validateInitData(initData, BOT_TOKEN, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("user payload is not valid JSON");
  });
});

describe("identity helpers", () => {
  it("builds a deterministic placeholder email from the Telegram id", () => {
    expect(telegramPlaceholderEmail("954512685")).toBe("tg954512685@telegram.local");
  });

  it("prefers the full name, then the username, then a fallback", () => {
    expect(telegramHandle({ id: "1", firstName: "Abhijeet", lastName: "Borde" })).toBe(
      "Abhijeet Borde",
    );
    expect(telegramHandle({ id: "1", firstName: "", username: "duck" })).toBe("duck");
    expect(telegramHandle({ id: "1", firstName: "" })).toBe("Player 1");
  });
});
