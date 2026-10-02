import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc, makeTrpcClient } from "./_core/trpc";
import { AuthProvider } from "./_core/useAuth";
import { AudioProvider } from "./lib/audio";
import { GameProvider } from "./lib/store";
import App from "./App";
import "./index.css";

/**
 * Provider order matters:
 *   tRPC → query → auth → audio → game
 * The game store reads the session (auth) and plays sounds through the audio
 * provider, so both have to be above it.
 *
 * ── Why TON Connect is NOT here ────────────────────────────────────────────
 * `TonConnectUIProvider` pulls in the whole TON Connect SDK (~200 KB). It used
 * to wrap the entire app, which meant the LOGIN SCREEN paid for a wallet SDK it
 * never touches. It now lives in `_core/TonConnectBoundary`, which `App` mounts
 * lazily and only once a player is signed in — so the front door ships without
 * it and the wallet chunk arrives in parallel with the first game state.
 */
function Root() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The session check is the one query that must not be retried into a
            // long spinner; everything else can retry quietly.
            retry: 1,
            staleTime: 30_000,
          },
        },
      }),
  );
  const [trpcClient] = useState(() => makeTrpcClient());

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AudioProvider>
            <GameProvider>
              <App />
            </GameProvider>
          </AudioProvider>
        </AuthProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
