// Client-side view types, DERIVED FROM THE ROUTER rather than hand-written.
//
// Hand-maintained mirrors of the server payloads drift the moment a router field
// is renamed, and the drift only surfaces as a typecheck error much later.
// `inferRouterOutputs` pins every component to the real response shape with
// zero maintenance — the compiler catches a mismatch at the call site instead.
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";

type Out = inferRouterOutputs<AppRouter>;

export type GameState = Out["game"]["state"];
export type TapResult = Out["game"]["tap"];
export type GameConfig = GameState["cfg"];
export type ProfileView = GameState["profile"];
export type LeagueView = GameState["league"];
export type WithdrawQuote = GameState["withdraw"];

export type ShopItem = Out["shop"]["list"]["items"][number];
export type ShopList = Out["shop"]["list"];
export type PurchaseStart = Out["shop"]["purchase"];

export type OfferView = Out["offers"]["list"]["offers"][number];
export type OffersList = Out["offers"]["list"];

export type ReferralSummary = Out["referral"]["summary"];
export type LeaderboardView = Out["leaderboard"]["weekly"];
export type LeaderboardEntry = LeaderboardView["rows"][number];

export type AdsStatus = Out["ads"]["status"];
export type AdWatchResult = Out["ads"]["watch"];

/** Shape handed to `tonConnectUI.sendTransaction`. */
export interface TonTxRequest {
  validUntil: number;
  network?: string;
  messages: { address: string; amount: string; payload?: string }[];
}

export type WithdrawalRequestResult = Out["withdrawal"]["request"];
export type WithdrawalRow = Out["withdrawal"]["list"][number];
export type LedgerRow = Out["wallet"]["ledger"][number];

export type { Out as RouterOutputs };
