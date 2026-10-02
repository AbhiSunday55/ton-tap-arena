import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "../_core/trpc";
import { useGame } from "./store";
import { useAudio } from "./audio";
import { fmtInt } from "./format";
import { showRewardedAd } from "./adsgram";

/**
 * The single ad-reward flow, shared by the Ads screen and the Mine chest so the
 * two entry points can never drift apart.
 *
 * Two providers, one contract:
 *  - `adsgram`     — the real rewarded SDK. The reward is granted ONLY when
 *                    `show()` resolves, which Adsgram does when the ad was
 *                    watched to the end. A skip, close or error rejects and
 *                    grants nothing.
 *  - `placeholder` — the built-in simulated slot, kept for the standalone demo
 *                    build where no ad network can run.
 *
 * Every failure surfaces as a visible message. The old flow failed silently,
 * which is exactly what made "no ad appears" impossible to diagnose.
 */
export interface AdRewardApi {
  status: ReturnType<typeof useAdStatus>["data"];
  loading: boolean;
  /** An ad is being requested or is on screen. */
  playing: boolean;
  /** Remaining seconds of the simulated slot (placeholder provider only). */
  countdown: number | null;
  /** Player-facing failure text, or null. */
  error: string | null;
  play: () => void;
  clearError: () => void;
}

function useAdStatus(active: boolean) {
  return trpc.ads.status.useQuery(undefined, { enabled: active });
}

export function useAdReward(active: boolean): AdRewardApi {
  const { applyState, toast } = useGame();
  const { sfx } = useAudio();
  const statusQ = useAdStatus(active);
  const watchM = trpc.ads.watch.useMutation();

  const [playing, setPlaying] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guards a double tap: the second press is ignored while an ad is in flight
  // rather than opening a second ad or double-granting.
  const busyRef = useRef(false);
  const elapsedRef = useRef(0);

  const status = statusQ.data;

  const grant = useCallback(
    async (completed: boolean, watchedSeconds: number) => {
      const res = await watchM.mutateAsync({ completed, watchedSeconds });
      applyState(res.state);
      sfx("coin");
      toast(`Ad reward: +${fmtInt(res.rewardCoin)} COIN`, "ok");
      void statusQ.refetch();
    },
    [watchM, applyState, sfx, toast, statusQ],
  );

  const fail = useCallback(
    (message: string) => {
      setError(message);
      sfx("error");
      toast(message, "err");
    },
    [sfx, toast],
  );

  const play = useCallback(() => {
    if (busyRef.current) return;
    if (!status) return;

    setError(null);

    if (!status.enabled) {
      fail("Ads are currently disabled.");
      return;
    }
    if (status.remaining <= 0) {
      fail(`That is all ${status.dailyLimit} ad views for today. Come back tomorrow.`);
      return;
    }

    // ── Real Adsgram rewarded ad ──
    if (status.provider === "adsgram") {
      busyRef.current = true;
      setPlaying(true);
      void (async () => {
        try {
          const outcome = await showRewardedAd(status.blockId);
          if (!outcome.ok) {
            fail(outcome.message);
            return;
          }
          await grant(true, status.watchSeconds);
        } catch (e) {
          fail(e instanceof Error ? e.message : "The ad could not be played.");
        } finally {
          busyRef.current = false;
          setPlaying(false);
        }
      })();
      return;
    }

    // ── Simulated slot (standalone demo build) ──
    elapsedRef.current = 0;
    setCountdown(status.watchSeconds);
    sfx("turbo");
  }, [status, grant, fail, sfx]);

  // The simulated countdown earns the reward only when it reaches zero.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      busyRef.current = true;
      setPlaying(true);
      void (async () => {
        try {
          await grant(false, elapsedRef.current);
        } catch (e) {
          fail(e instanceof Error ? e.message : "Ad reward failed.");
        } finally {
          busyRef.current = false;
          setPlaying(false);
          setCountdown(null);
          elapsedRef.current = 0;
        }
      })();
      return;
    }
    const id = window.setTimeout(() => {
      elapsedRef.current += 1;
      setCountdown((c) => (c === null ? null : c - 1));
    }, 1000);
    return () => window.clearTimeout(id);
  }, [countdown, grant, fail]);

  const clearError = useCallback(() => setError(null), []);

  return {
    status,
    loading: statusQ.isLoading,
    playing,
    countdown,
    error,
    play,
    clearError,
  };
}
