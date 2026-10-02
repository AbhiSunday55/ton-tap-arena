import type { ReactNode } from "react";
import { TonConnectUIProvider } from "@tonconnect/ui-react";

/**
 * Lazy boundary around the TON Connect SDK.
 *
 * Split into its own module so the SDK lands in a separate chunk that the login
 * screen never downloads. `App` mounts this only after a player is signed in.
 *
 * The manifest URL is derived at runtime from the real origin — a wallet reads
 * it to show the user which app is asking for a signature, so it must never be
 * a hardcoded host (the same build runs on the platform preview, on GitHub
 * Pages, and inside Telegram).
 */
export default function TonConnectBoundary({ children }: { children: ReactNode }) {
  const manifestUrl =
    typeof window === "undefined"
      ? "/tonconnect-manifest.json"
      : new URL(
          "tonconnect-manifest.json",
          `${window.location.origin}${basePath()}`,
        ).toString();

  return <TonConnectUIProvider manifestUrl={manifestUrl}>{children}</TonConnectUIProvider>;
}

/**
 * The app's base path. Vite injects `BASE_URL` ("\/" on the platform, a repo
 * subpath on GitHub Pages). Read defensively so a build without the Vite client
 * types still resolves to the root rather than throwing.
 */
function basePath(): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  const base = env?.BASE_URL ?? "/";
  return base.endsWith("/") ? base : `${base}/`;
}
