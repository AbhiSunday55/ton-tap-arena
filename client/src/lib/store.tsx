import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { trpc } from "../_core/trpc";
import { useAuth } from "../_core/useAuth";
import { useAudio } from "./audio";
import type { GameState } from "./api-types";

export type ToastKind = "ok" | "err" | "info";
interface Toast {
  id: number;
  msg: string;
  kind: ToastKind;
}

interface StoreApi {
  state: GameState | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
  /** Write a fresh state returned by any mutating endpoint. */
  applyState: (s: GameState) => void;
  /** Server balance plus the client's not-yet-settled taps. */
  coin: number;
  energy: number;
  pendingTaps: number;
  canTap: boolean;
  tap: (count: number) => number;
  perTap: number;
  syncPending: boolean;
  toast: (msg: string, kind?: ToastKind) => void;
  toasts: Toast[];
}

const Ctx = createContext<StoreApi | null>(null);

/**
 * The tap loop is the hot path: a player hits the coin far faster than a round
 * trip. Taps are accumulated locally and flushed in batches (~600ms), while the
 * UI renders `server value + pending delta` so the counter never lags the
 * finger.
 *
 * The server clamps a request to 200 taps, so the queue is capped at two
 * batches and any surplus is dropped — a player mashing the coin with no
 * connection must not build an unbounded backlog that dumps minutes of taps
 * into one request the moment the network returns.
 */
const FLUSH_MS = 600;
const MAX_BATCH = 200;
const QUEUE_CAP = MAX_BATCH * 2;

export function GameProvider({ children }: { children: ReactNode }) {
  const { sfx } = useAudio();
  const { user } = useAuth();

  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((msg: string, kind: ToastKind = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
  }, []);

  // Gated on the session: firing this while signed out would 401 on every load
  // and, worse, make the login screen wait on a request that cannot succeed.
  const query = trpc.game.state.useQuery(undefined, {
    retry: 1,
    refetchOnWindowFocus: true,
    enabled: Boolean(user),
  });
  const bootstrapM = trpc.game.bootstrap.useMutation();

  const [state, setState] = useState<GameState | null>(null);
  const bootedRef = useRef(false);

  // Populate the catalogue and the sample leaderboard once per session. The
  // server memoises it, so this is cheap on every later page load.
  useEffect(() => {
    if (!user) return;
    if (bootedRef.current) return;
    bootedRef.current = true;
    bootstrapM.mutateAsync().catch(() => {
      // A failed bootstrap must not block the app — the state query below still
      // renders the arena, and the next load retries the seed.
      bootedRef.current = false;
    });
  }, [bootstrapM, user]);

  useEffect(() => {
    if (query.data) setState(query.data);
  }, [query.data]);

  // ── optimistic tap state ────────────────────────────────────────────────
  // Refs hold the authoritative queue (read inside event handlers without
  // re-rendering); the mirrored state is only for display.
  const pendingCoinRef = useRef(0); // coins the server has not confirmed yet
  const pendingTapsRef = useRef(0);
  const serverEnergyRef = useRef(0);
  const [pendingCoin, setPendingCoin] = useState(0);
  const [pendingTaps, setPendingTaps] = useState(0);

  const perTapRef = useRef(1);

  useEffect(() => {
    if (!query.data) return;
    serverEnergyRef.current = query.data.profile.energy;
  }, [query.data]);

  const tapMutation = trpc.game.tap.useMutation();
  const inFlightRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const [syncPending, setSyncPending] = useState(false);

  const flush = useCallback(async () => {
    if (inFlightRef.current) return;
    const batch = Math.min(pendingTapsRef.current, MAX_BATCH);
    if (batch <= 0) return;

    inFlightRef.current = true;
    setSyncPending(true);
    // Reserve the batch NOW so taps landing during the round trip queue for the
    // next flush instead of being sent twice.
    const reservedCoin = Math.round((pendingCoinRef.current / Math.max(1, pendingTapsRef.current)) * batch);
    pendingTapsRef.current -= batch;
    pendingCoinRef.current = Math.max(0, pendingCoinRef.current - reservedCoin);
    setPendingTaps(pendingTapsRef.current);
    setPendingCoin(pendingCoinRef.current);

    try {
      const data = await tapMutation.mutateAsync({ taps: batch });
      setState((prev) => ({ ...(prev ?? data), ...data, lastTap: data.lastTap }));
    } catch (e) {
      // Give the taps back rather than silently losing the player's work.
      pendingTapsRef.current = Math.min(QUEUE_CAP, pendingTapsRef.current + batch);
      pendingCoinRef.current += reservedCoin;
      setPendingTaps(pendingTapsRef.current);
      setPendingCoin(pendingCoinRef.current);
      toast(e instanceof Error ? e.message : "Tap sync failed", "err");
    } finally {
      inFlightRef.current = false;
      setSyncPending(false);
      if (pendingTapsRef.current > 0) scheduleFlush();
    }
    // scheduleFlush is stable (defined below via ref)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tapMutation, toast]);

  const flushRef = useRef(flush);
  flushRef.current = flush;

  const scheduleFlush = useCallback(() => {
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void flushRef.current();
    }, FLUSH_MS);
  }, []);

  /** Returns how many taps were actually accepted (0 when out of energy). */
  const tap = useCallback(
    (count: number): number => {
      const room = Math.max(0, serverEnergyRef.current - pendingTapsRef.current);
      const accepted = Math.min(count, Math.floor(room), QUEUE_CAP - pendingTapsRef.current);
      if (accepted <= 0) {
        sfx("error");
        return 0;
      }
      pendingTapsRef.current += accepted;
      pendingCoinRef.current += accepted * perTapRef.current;
      setPendingTaps(pendingTapsRef.current);
      setPendingCoin(pendingCoinRef.current);
      scheduleFlush();
      return accepted;
    },
    [scheduleFlush, sfx],
  );

  // Retry loop so a stalled flush still drains eventually.
  useEffect(() => {
    if (pendingTaps <= 0) return;
    const id = window.setInterval(() => {
      if (pendingTapsRef.current > 0 && !inFlightRef.current) void flushRef.current();
    }, FLUSH_MS * 3);
    return () => window.clearInterval(id);
  }, [pendingTaps]);

  // Drain on hide/close so taps are not lost when the Mini App backgrounds.
  useEffect(() => {
    const onHide = () => {
      if (pendingTapsRef.current > 0) void flushRef.current();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
  }, []);

  const applyState = useCallback((s: GameState) => {
    setState(s);
    // A booster refill or a streak claim changes energy server-side, so the
    // tap guard's ceiling has to move with it.
    serverEnergyRef.current = s.profile.energy;
  }, []);

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  const coin = (state?.profile.balanceCoin ?? 0) + pendingCoin;
  const energy = Math.max(0, (state?.profile.energy ?? 0) - pendingTaps);

  /**
   * Client-side mirror of the server's reward stack, used only for the floating
   * "+N" label and the optimistic counter — the server remains authoritative.
   */
  const perTap = useMemo(() => {
    if (!state) return 1;
    const { cfg, profile, league, turboActive } = state;
    const base = cfg.tapBaseReward * Math.max(1, profile.tapPowerLevel / cfg.tapPowerUpgradeStep);
    const withItem = base * (1 + profile.itemBoostPercent / 100);
    const withLeague = withItem * league.mult;
    const withTurbo = withLeague * (turboActive ? cfg.turboMultiplier : 1);
    return Math.max(1, Math.round(withTurbo));
  }, [state]);

  useEffect(() => {
    perTapRef.current = perTap;
  }, [perTap]);

  const api = useMemo<StoreApi>(
    () => ({
      state,
      loading: query.isLoading,
      error: query.error ? query.error.message : null,
      refetch,
      applyState,
      coin,
      energy,
      pendingTaps,
      canTap: energy > 0,
      tap,
      perTap,
      syncPending,
      toast,
      toasts,
    }),
    [
      state,
      query.isLoading,
      query.error,
      refetch,
      applyState,
      coin,
      energy,
      pendingTaps,
      tap,
      perTap,
      syncPending,
      toast,
      toasts,
    ],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useGame(): StoreApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useGame must be used inside <GameProvider>");
  return v;
}
