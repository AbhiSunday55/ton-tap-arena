import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { compare, hash as bcryptHash } from "bcryptjs";
import { eq } from "drizzle-orm";
import {
  telegramHandle,
  telegramPlaceholderEmail,
  type TelegramUser,
} from "./telegram";
import { db } from "./db";
import { isUniqueViolation } from "./db-errors";
import { users, telegramAccounts } from "../../drizzle/schema";
import { env } from "./env";
import { sessionCookieName, type UserRole } from "../../shared/constants";
import type { SessionUser } from "../../shared/types";
import {
  requestIsSecure,
  sessionCookieClearOptions,
  sessionCookieOptions,
} from "./session-cookie";

// ─────────────────────────────────────────────────────────────────────────────
// AuthProvider abstraction (DESIGN §5.1). Business code depends only on the
// SessionUser it yields, NEVER on how the user authenticated. M1 wires only
// LocalAuthProvider; SsoAuthProvider is a reserved stub. Swapping/adding a
// provider later touches only this file + config — zero business-code churn.
// ─────────────────────────────────────────────────────────────────────────────
export interface AuthProvider {
  /** Resolve the current user from the request, or null if unauthenticated. */
  getSession(c: Context): Promise<SessionUser | null>;
  /** Begin a session (sets the auth cookie). Throws on bad credentials. */
  login(c: Context, email: string, password: string): Promise<SessionUser>;
  /** End the current session (clears the auth cookie). */
  logout(c: Context): Promise<void>;
}

const COOKIE = sessionCookieName(env.appSlug);
const secretKey = new TextEncoder().encode(env.jwtSecret);

function toSessionUser(
  row: typeof users.$inferSelect,
  tg?: typeof telegramAccounts.$inferSelect | null,
): SessionUser {
  // password_hash is intentionally dropped here — never leaves the auth layer.
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as UserRole,
    authMethod: (row.authMethod as SessionUser["authMethod"]) ?? "password",
    telegramId: tg?.telegramId ?? null,
    telegramUsername: tg?.username ?? null,
    telegramPhotoUrl: tg?.photoUrl ?? null,
  };
}

class LocalAuthProvider implements AuthProvider {
  async getSession(c: Context): Promise<SessionUser | null> {
    const token = getCookie(c, COOKIE);
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, secretKey);
      const userId = payload.sub;
      if (!userId) return null;
      // One query: the credential row plus its Telegram identity, if linked.
      const [row] = await db
        .select({ user: users, tg: telegramAccounts })
        .from(users)
        .leftJoin(telegramAccounts, eq(telegramAccounts.userId, users.id))
        .where(eq(users.id, userId))
        .limit(1);
      return row ? toSessionUser(row.user, row.tg) : null;
    } catch {
      return null; // expired / tampered / wrong key → treat as anonymous
    }
  }

  async login(c: Context, email: string, password: string): Promise<SessionUser> {
    const [row] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    // Constant-ish: still run a compare when the user is missing to blunt timing.
    const hash = row?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
    const ok = await compare(password, hash);
    if (!row || !row.passwordHash || !ok) throw new AuthError("Invalid email or password");
    await this.#setSession(c, row.id);
    return toSessionUser(row);
  }

  async logout(c: Context): Promise<void> {
    for (const opt of sessionCookieClearOptions()) {
      deleteCookie(c, COOKIE, opt);
    }
  }

  async #setSession(c: Context, userId: string): Promise<void> {
    await issueSessionCookie(c, userId);
  }
}

/**
 * Mint the session JWT and set the auth cookie.
 *
 * Extracted so EVERY way of establishing a session lands on the same cookie —
 * email + password today, a validated Telegram initData payload next. Without
 * this, a second sign-in path would have to re-implement the JWT and could
 * drift (different key, missing expiry) in a way that only shows up as players
 * being silently logged out.
 */
export async function issueSessionCookie(c: Context, userId: string): Promise<void> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secretKey);
  setCookie(c, COOKIE, token, sessionCookieOptions(env.isProd || requestIsSecure(c)));
}

// Reserved for post-M1 SSO (OIDC / Teamily IdP). NOT implemented — its presence
// only proves the seam holds; it is never wired in M1 (DESIGN §5.1).
class SsoAuthProvider implements AuthProvider {
  async getSession(): Promise<SessionUser | null> {
    throw new Error("SsoAuthProvider not implemented (reserved seam — DESIGN §5.1).");
  }
  async login(): Promise<SessionUser> {
    throw new Error("SsoAuthProvider not implemented (reserved seam — DESIGN §5.1).");
  }
  async logout(): Promise<void> {
    throw new Error("SsoAuthProvider not implemented (reserved seam — DESIGN §5.1).");
  }
}

export class AuthError extends Error {}

/** Signup hit the `users.email` UNIQUE index — that address already has an
 *  account. A distinct type (not a string match on some driver's wording) so a
 *  router can answer 409 "log in instead" instead of leaking a 500. */
export class EmailTakenError extends AuthError {}

let _provider: AuthProvider | undefined;
export function authProvider(): AuthProvider {
  if (!_provider) _provider = env.authProvider === "sso" ? new SsoAuthProvider() : new LocalAuthProvider();
  return _provider;
}

// Local-only helper for the signup flow (registration is inherently
// provider-specific; SSO signup happens at the IdP). Kept out of the interface.
export async function registerLocalUser(email: string, password: string, name?: string): Promise<SessionUser> {
  const passwordHash = await bcryptHash(password, 10);
  try {
    const [row] = await db
      .insert(users)
      .values({ email: email.toLowerCase(), passwordHash, name: name ?? null })
      .returning();
    return { id: row.id, email: row.email, name: row.name, role: row.role as UserRole };
  } catch (e) {
    // `users` carries exactly one UNIQUE index (email) — `id` is generated — so
    // a 23505 on this INSERT can only mean the address is taken. Translating it
    // HERE, rather than in each app's routers.ts, is what keeps a second signup
    // from surfacing as a 500 that quotes the INSERT and its bound params
    // (password hash included) back to the browser.
    if (isUniqueViolation(e)) {
      throw new EmailTakenError("That email is already registered — try logging in instead.");
    }
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram Mini App identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a VALIDATED Telegram user to a local account, creating it on first
 * sight. The caller must have already verified `initData` — this function
 * trusts its input completely, so it is never reachable from a raw request.
 *
 * Upsert is keyed on `telegramId` (unique index), so a returning player always
 * lands on the same row no matter which device or session they arrive from.
 * The placeholder email keeps the scaffold's NOT NULL `users.email` intact
 * without inventing a real address for someone who never gave one.
 */
export async function upsertTelegramUser(tg: TelegramUser): Promise<SessionUser> {
  const email = telegramPlaceholderEmail(tg.id);
  const name = telegramHandle(tg);

  // Already linked? Refresh the identity Telegram may have changed and return.
  const [linked] = await db
    .select({ user: users, tg: telegramAccounts })
    .from(telegramAccounts)
    .innerJoin(users, eq(users.id, telegramAccounts.userId))
    .where(eq(telegramAccounts.telegramId, tg.id))
    .limit(1);

  if (linked) {
    const [updatedTg] = await db
      .update(telegramAccounts)
      .set({
        username: tg.username ?? null,
        firstName: tg.firstName || null,
        lastName: tg.lastName ?? null,
        languageCode: tg.languageCode ?? null,
        isPremium: tg.isPremium ?? false,
        photoUrl: tg.photoUrl ?? null,
        lastSeenAt: new Date(),
      })
      .where(eq(telegramAccounts.telegramId, tg.id))
      .returning();
    const [updatedUser] = await db
      .update(users)
      .set({ name })
      .where(eq(users.id, linked.user.id))
      .returning();
    return toSessionUser(updatedUser ?? linked.user, updatedTg ?? linked.tg);
  }

  // First sight: create the credential row, then link the Telegram identity.
  // `users.email` is NOT NULL, so a Telegram player gets a deterministic
  // placeholder — stable, unique, and never a real address they did not give.
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: null, name, authMethod: "telegram" })
    .returning();

  const [account] = await db
    .insert(telegramAccounts)
    .values({
      userId: user.id,
      telegramId: tg.id,
      username: tg.username ?? null,
      firstName: tg.firstName || null,
      lastName: tg.lastName ?? null,
      languageCode: tg.languageCode ?? null,
      isPremium: tg.isPremium ?? false,
      photoUrl: tg.photoUrl ?? null,
      authDate: new Date(),
      lastSeenAt: new Date(),
    })
    .returning();

  return toSessionUser(user, account);
}

/**
 * Create a throwaway guest account for a browser visitor outside Telegram.
 * No password is set, so the account is only reachable through the session
 * cookie issued here — there is nothing to guess or brute-force.
 */
export async function registerGuestUser(): Promise<SessionUser> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const [row] = await db
    .insert(users)
    .values({
      email: `guest_${suffix}@guest.local`,
      passwordHash: null,
      name: `Guest ${suffix.slice(0, 4).toUpperCase()}`,
      authMethod: "guest",
    })
    .returning();
  return toSessionUser(row);
}
