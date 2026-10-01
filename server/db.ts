// ── AGENT-OWNED: business data-access ────────────────────────────────────────
// Write the app's queries here using the shared `db` handle + Drizzle. Keep raw
// SQL/ORM here (not in routers) so procedures stay thin. Example (items) shows
// the expected owner-scoping pattern — every query is filtered by the current
// user so one user can't touch another's rows.
import { and, desc, eq } from "drizzle-orm";
import { db } from "./_core/db";
import { items } from "../drizzle/schema";

export async function listItemsByOwner(ownerId: string) {
  return db.select().from(items).where(eq(items.ownerId, ownerId)).orderBy(desc(items.createdAt));
}

export async function createItem(input: { ownerId: string; title: string; notes?: string; coverUrl?: string }) {
  const [row] = await db
    .insert(items)
    .values({
      ownerId: input.ownerId,
      title: input.title,
      notes: input.notes ?? null,
      coverUrl: input.coverUrl ?? null,
    })
    .returning();
  return row;
}

export async function deleteItem(id: string, ownerId: string) {
  // Owner-scoped delete: the WHERE guarantees a user can only delete own rows.
  await db.delete(items).where(and(eq(items.id, id), eq(items.ownerId, ownerId)));
  return { ok: true };
}
