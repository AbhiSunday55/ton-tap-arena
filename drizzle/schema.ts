import { pgTable, uuid, text, timestamp, index, bigint } from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM TABLE — managed by the scaffold. The Agent MUST NOT redefine or drop
// the auth columns here; it only ADDS business tables below (DESIGN §5.1).
//
// `password_hash` is LOCAL-auth-only. It is deliberately confined to this table
// and to server/_core/auth.ts — it never appears in SessionUser or any tRPC
// output. A future SsoAuthProvider would leave it null and link identities via
// an external-subject column; business tables keep FK'ing users.id regardless,
// so switching auth providers needs no business-schema change.
// ─────────────────────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"), // null for SSO-linked users (future)
  name: text("name"),
  role: text("role").notNull().default("user"), // 'user' | 'admin'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// SYSTEM TABLE — managed by the scaffold, written by server/_core/storage.ts.
// The Agent MUST NOT redefine, rename or drop it: `_core` inserts into it, so a
// rename breaks `_core`. Rows are created by storageCommit() AFTER the upload
// landed, with size/contentType read back from object storage — never from the
// client — so a row cannot point at an object that does not exist AT COMMIT TIME.
//
// That guarantee can still go stale: the platform's owner-facing storage panel
// can delete the underlying object directly. It has no access to this app's
// database, so it cannot (and does not) delete the matching row here. A row
// existing is therefore NOT a guarantee its object still exists — treat a 404
// from `/app-storage/<key>` as an expected, handle-able case in the UI, not a
// bug. `/app-storage/<key>` is also unauthenticated (no session check), so the
// URL itself is the read capability — never store something there that must
// not leak to anyone who obtains the link.
export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Path relative to this app's storage prefix; served at /app-storage/<key>.
    key: text("key").notNull().unique(),
    // Nullable on purpose: a public "contact form with attachment" has no
    // logged-in uploader. set null (not cascade) on user delete — this table is
    // the app's ONLY index of its objects, so deleting the row would
    // permanently lose the ability to find the file.
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),                        // original filename, for display
    size: bigint("size", { mode: "number" }).notNull(),  // bigint: integer caps at ~2.1GB
    contentType: text("content_type"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("files_owner_idx").on(t.ownerId), index("files_created_idx").on(t.createdAt)],
);

// ─────────────────────────────────────────────────────────────────────────────
// BUSINESS TABLES — the Agent writes these. Example below shows the expected
// pattern: FK to users.id, timestamps, an index on the owner column. Replace
// with the app's real domain, then `pnpm db:generate` to emit a migration.
// ─────────────────────────────────────────────────────────────────────────────
export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    notes: text("notes"),
    coverUrl: text("cover_url"), // e.g. an /app-storage/... key (DESIGN §5.6)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("items_owner_idx").on(t.ownerId)],
);
