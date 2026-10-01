import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TonConnectUIProvider } from "@tonconnect/ui-react";
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
 * provider, so both have to be above it. Everything sits inside
 * TonConnectUIProvider so any screen can drive the wallet.
 *
 * The manifest is served from /tonconnect-manifest.json and its absolute URL is
 * derived at runtime — a wallet reads the manifest to show the user which app is
 * asking for a signature, so it must be the real origin, never a hardcoded one.
 */
function Root() {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() => makeTrpcClient());

  const manifestUrl =
    typeof window === "undefined"
      ? "/tonconnect-manifest.json"
      : new URL("/tonconnect-manifest.json", window.location.origin).toString();

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <TonConnectUIProvider manifestUrl={manifestUrl}>
          <AuthProvider>
            <AudioProvider>
              <GameProvider>
                <App />
              </GameProvider>
            </AudioProvider>
          </AuthProvider>
        </TonConnectUIProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
