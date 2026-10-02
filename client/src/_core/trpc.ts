import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import superjson from "superjson";
import type { AppRouter } from "../../../server/routers";
import { handleDemoCall } from "../demo/demo-backend";

// Typed tRPC client. `AppRouter` is a TYPE-ONLY import from the server, so the
// whole API is end-to-end typed without shipping server code to the browser.
export const trpc = createTRPCReact<AppRouter>();

/**
 * True when this build has no API to talk to.
 *
 * GitHub Pages serves static files only — there is no Node process behind the
 * site, so `/trpc` would 404 and every screen would sit on an error. The Pages
 * workflow sets `VITE_DEMO=1` at build time; the platform build leaves it unset
 * and talks to the real server exactly as before.
 */
export const IS_DEMO = import.meta.env.VITE_DEMO === "1";

/**
 * A tRPC link that answers from the in-browser demo backend instead of the
 * network. It implements the same observable contract as `httpBatchLink`, so
 * every hook, cache and optimistic update behaves identically — the app cannot
 * tell the difference, which is what keeps the demo honest.
 */
function demoLink(): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        try {
          const data = handleDemoCall(op.path, op.input);
          observer.next({ result: { data } });
          observer.complete();
        } catch (cause) {
          // tRPC's observer expects a TRPCClientError; the demo only ever needs
          // the message to reach the UI, so a plain Error is cast at the seam.
          observer.error(
            new Error(cause instanceof Error ? cause.message : "Demo call failed") as never,
          );
        }
        return () => undefined;
      });
}

export function makeTrpcClient() {
  return trpc.createClient({
    links: [
      IS_DEMO
        ? demoLink()
        : httpBatchLink({ url: "/trpc", transformer: superjson }),
    ],
  });
}
