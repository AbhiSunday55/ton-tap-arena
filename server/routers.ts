// ── AGENT-OWNED: tRPC API surface ────────────────────────────────────────────
// Compose the app's procedures here. Keep them thin: validate input with zod,
// call server/db.ts for data and server/services/* for external integrations.
// Auth is provided by _core — do NOT reimplement sessions. Access levels:
// publicProcedure (anyone) / protectedProcedure (ctx.user set) / adminProcedure.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "./_core/trpc";
import { authProvider, registerLocalUser, AuthError, EmailTakenError } from "./_core/auth";
import { storageCommit, storageDeleteOwned, storageListByOwner, storagePutUrl, StorageError } from "./_core/storage";
import * as q from "./db";

// Auth: login/logout are provider-agnostic (go through the AuthProvider).
// signup is LOCAL-only (SSO signup happens at the IdP) — guard if you switch.
const authRouter = router({
  me: publicProcedure.query(({ ctx }) => ctx.user),

  signup: publicProcedure
    .input(z.object({ email: z.email(), password: z.string().min(8), name: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const user = await registerLocalUser(input.email, input.password, input.name);
        await authProvider().login(ctx.c, input.email, input.password); // set session cookie
        return user;
      } catch (e: unknown) {
        // CONFLICT, not a 500: the request was well-formed, the address is just
        // taken. registerLocalUser has already turned the driver's SQLSTATE
        // 23505 into this type — never pattern-match a DB error message here,
        // Drizzle hides it behind a "Failed query: <sql>" wrapper.
        if (e instanceof EmailTakenError) throw new TRPCError({ code: "CONFLICT", message: e.message });
        throw e;
      }
    }),

  login: publicProcedure
    .input(z.object({ email: z.email(), password: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await authProvider().login(ctx.c, input.email, input.password);
      } catch (e) {
        if (e instanceof AuthError) throw new TRPCError({ code: "UNAUTHORIZED", message: e.message });
        throw e;
      }
    }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    await authProvider().logout(ctx.c);
    return { ok: true };
  }),
});

// Example business router (items). Every procedure is owner-scoped via ctx.user.
const itemsRouter = router({
  list: protectedProcedure.query(({ ctx }) => q.listItemsByOwner(ctx.user.id)),

  create: protectedProcedure
    .input(z.object({ title: z.string().min(1), notes: z.string().optional(), coverUrl: z.string().optional() }))
    .mutation(({ ctx, input }) => q.createItem({ ownerId: ctx.user.id, ...input })),

  remove: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => q.deleteItem(input.id, ctx.user.id)),
});

// Sanitize a caller-supplied filename down to a safe key BASENAME: take the
// last path segment (so "/../shared/report.pdf" can't steer the rest of the
// key), keep only [A-Za-z0-9._-], strip leading dots (so a survivor of "." or
// ".." can't slip through as a bare segment), and fall back to a fixed constant
// when nothing survives. Exported so it can be unit-tested directly.
//
// The stem and the extension are sanitized SEPARATELY, and that split is the
// whole point. Sanitizing the basename as one string used to destroy the
// extension of any file whose stem was entirely non-ASCII: the allowlist below
// deleted every CJK character in "风景.png", leaving ".png", and the leading-dot
// strip — there to kill "." / ".." / dotfiles — then ate the extension
// separator, because by that point it was the only dot left. The object landed
// in storage as "<uuid>-png". Splitting first means the leading-dot rule only
// ever sees the stem, where a leading dot really is a dotfile prefix.
export function sanitizeBasename(name: string): string {
  // Split on "\\" too: it cannot steer a path segment (the key joins on "/"),
  // but a Windows path would otherwise fold its directories into the stem.
  const last = name.split(/[/\\]/).pop() ?? "";
  // `> 0`, not `>= 0`: in ".gitignore" the dot is a dotfile prefix, not an
  // extension separator, so the whole name is the stem.
  const dot = last.lastIndexOf(".");
  const rawStem = dot > 0 ? last.slice(0, dot) : last;
  const rawExt = dot > 0 ? last.slice(dot + 1) : "";
  const stem =
    rawStem.replace(/[^A-Za-z0-9._-]/g, "").replace(/^\.+/, "") || "upload";
  // No dots or separators in an extension, and capped — the key is
  // `${uuid}-${basename}`, so a long tail buys nothing.
  const ext = rawExt.replace(/[^A-Za-z0-9]/g, "").slice(0, 10);
  return ext ? `${stem}.${ext}` : stem;
}

// Example file-upload router. The three-step protocol matters: the browser PUTs
// straight to object storage, so the server only learns the upload succeeded when
// the client calls `commit`. Skipping commit leaves an unindexed orphan object —
// never a row pointing at nothing.
//
//   1. uploadUrl  → signed PUT URL + the key to commit later
//   2. browser    → PUT the bytes to uploadUrl
//   3. commit     → index it (size/type are read back from storage)
const filesRouter = router({
  uploadUrl: protectedProcedure
    .input(z.object({ name: z.string().min(1), contentType: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      // The uuid prefix makes the key unguessable ONLY if the rest of the key
      // isn't attacker-controlled — sanitizeBasename strips the client-supplied
      // `name` down to a safe basename first, so it can't steer path segments
      // (e.g. "/../report.pdf") into someone else's key.
      const key = `${crypto.randomUUID()}-${sanitizeBasename(input.name)}`;
      try {
        const { uploadUrl, publicPath } = await storagePutUrl(key, input.contentType, {
          ownerId: ctx.user.id,
        });
        return { key, uploadUrl, publicPath };
      } catch (e) {
        if (e instanceof StorageError && e.code === "failed") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "upload rejected by storage — check contentType is on the platform's whitelist " +
              "(see AGENT.md: png/jpeg/gif/webp/avif, pdf, text/plain, csv, json, mpeg/wav audio, mp4/webm video)",
          });
        }
        throw e;
      }
    }),

  commit: protectedProcedure
    .input(z.object({ key: z.string().min(1), name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await storageCommit(input.key, { ownerId: ctx.user.id, name: input.name });
      } catch (e) {
        if (e instanceof StorageError && e.code === "not_found") {
          throw new TRPCError({ code: "NOT_FOUND", message: "upload not found — did the PUT succeed?" });
        }
        if (e instanceof StorageError && e.code === "forbidden") {
          throw new TRPCError({ code: "FORBIDDEN", message: "that key belongs to another user" });
        }
        throw e;
      }
    }),

  list: protectedProcedure.query(({ ctx }) => storageListByOwner(ctx.user.id)),

  remove: protectedProcedure
    .input(z.object({ key: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await storageDeleteOwned(ctx.user.id, input.key);
      } catch (e) {
        if (e instanceof StorageError && e.code === "forbidden") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "malformed key" });
        }
        throw e;
      }
    }),
});

export const appRouter = router({
  auth: authRouter,
  items: itemsRouter,
  files: filesRouter,
});

export type AppRouter = typeof appRouter;
