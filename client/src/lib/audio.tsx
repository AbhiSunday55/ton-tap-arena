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
import { asset } from "./assets";

export type SfxName =
  | "tap"
  | "turbo"
  | "coin"
  | "buy"
  | "withdraw"
  | "error"
  | "claim"
  | "level";

export interface AudioApi {
  ready: boolean;
  unlock: () => Promise<void>;
  muted: boolean;
  setMuted: (v: boolean) => void;
  toggleMute: () => void;
  sfx: (n: SfxName) => void;
  musicPlaying: boolean;
  startMusic: () => void;
  pauseMusic: () => void;
}

const Ctx = createContext<AudioApi | null>(null);
const STORAGE_KEY = "tta.muted";

const BGM_SRC = asset("assets/tap_arena_theme.mp3");

/**
 * All sound effects are SYNTHESISED with the Web Audio API rather than shipped
 * as files: a tap fires on every finger press, and eight short samples would
 * each be a separate request on a mobile connection. The looping background
 * music is the one real asset (generated for this game).
 *
 * The AudioContext is created lazily on the first gesture — mobile browsers
 * refuse to start one before a user interaction, so creating it at import time
 * would leave it permanently suspended.
 */
export function AudioProvider({ children }: { children: ReactNode }) {
  const [muted, setMutedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [musicPlaying, setMusicPlaying] = useState(false);
  const [ready, setReady] = useState(false);

  const ctxRef = useRef<AudioContext | null>(null);
  const bgmRef = useRef<HTMLAudioElement | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const audioCtx = useCallback((): AudioContext | null => {
    if (typeof window === "undefined") return null;
    if (!ctxRef.current) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      try {
        ctxRef.current = new AC();
      } catch {
        return null;
      }
    }
    if (ctxRef.current.state === "suspended") void ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  /** One short enveloped tone. */
  const tone = useCallback(
    (
      freq: number,
      dur: number,
      type: OscillatorType,
      gain: number,
      delay = 0,
      endFreq?: number,
    ) => {
      const ac = audioCtx();
      if (!ac) return;
      const t0 = ac.currentTime + delay;
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(ac.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    },
    [audioCtx],
  );

  const noise = useCallback(
    (dur: number, gain: number, delay = 0) => {
      const ac = audioCtx();
      if (!ac) return;
      const frames = Math.max(1, Math.floor(ac.sampleRate * dur));
      const buf = ac.createBuffer(1, frames, ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
      const src = ac.createBufferSource();
      src.buffer = buf;
      const g = ac.createGain();
      g.gain.value = gain;
      const filt = ac.createBiquadFilter();
      filt.type = "highpass";
      filt.frequency.value = 1200;
      src.connect(filt);
      filt.connect(g);
      g.connect(ac.destination);
      src.start(ac.currentTime + delay);
    },
    [audioCtx],
  );

  const sfx = useCallback(
    (n: SfxName) => {
      if (mutedRef.current) return;
      switch (n) {
        case "tap": {
          // slight random detune so a rapid tap run does not sound robotic
          const j = 1 + (Math.random() - 0.5) * 0.16;
          tone(680 * j, 0.07, "triangle", 0.16);
          noise(0.035, 0.05);
          break;
        }
        case "turbo":
          tone(320, 0.1, "sawtooth", 0.14);
          tone(640, 0.14, "sawtooth", 0.12, 0.07);
          tone(980, 0.2, "sawtooth", 0.1, 0.14);
          break;
        case "coin":
          tone(1180, 0.07, "square", 0.1);
          tone(1580, 0.11, "square", 0.08, 0.05);
          break;
        case "buy":
          [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.15, "triangle", 0.13, i * 0.06));
          break;
        case "withdraw":
          [784, 988, 1319].forEach((f, i) => tone(f, 0.28, "sine", 0.16, i * 0.1));
          tone(392, 0.5, "sine", 0.09, 0.1);
          break;
        case "claim":
          tone(660, 0.1, "sine", 0.14);
          tone(990, 0.18, "sine", 0.12, 0.08);
          break;
        case "level":
          [659, 784, 988, 1319, 1568].forEach((f, i) => tone(f, 0.2, "triangle", 0.12, i * 0.07));
          break;
        case "error":
          tone(200, 0.16, "sawtooth", 0.14);
          tone(150, 0.24, "sawtooth", 0.12, 0.1);
          break;
      }
    },
    [noise, tone],
  );

  const startMusic = useCallback(() => {
    if (mutedRef.current) return;
    if (!bgmRef.current) {
      const el = new Audio(BGM_SRC);
      el.loop = true;
      el.volume = 0;
      el.preload = "auto";
      bgmRef.current = el;
    }
    const el = bgmRef.current;
    void el
      .play()
      .then(() => {
        setMusicPlaying(true);
        // gentle fade-in so a page load does not blast audio
        let v = 0;
        const id = setInterval(() => {
          v = Math.min(0.3, v + 0.03);
          el.volume = v;
          if (v >= 0.3) clearInterval(id);
        }, 60);
      })
      .catch(() => {
        /* autoplay blocked until the user interacts — retried on next gesture */
      });
  }, []);

  const pauseMusic = useCallback(() => {
    bgmRef.current?.pause();
    setMusicPlaying(false);
  }, []);

  const setMuted = useCallback(
    (v: boolean) => {
      setMutedState(v);
      try {
        localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
      } catch {
        /* private mode — the in-memory flag still works for this session */
      }
      if (v) {
        bgmRef.current?.pause();
        setMusicPlaying(false);
      } else if (bgmRef.current) {
        void bgmRef.current.play().then(() => setMusicPlaying(true)).catch(() => undefined);
      }
    },
    [],
  );

  const toggleMute = useCallback(() => setMuted(!mutedRef.current), [setMuted]);

  // Browsers block audio before a gesture; the first pointer/key event arms it.
  useEffect(() => {
    const arm = () => {
      audioCtx();
      if (!mutedRef.current) startMusic();
    };
    window.addEventListener("pointerdown", arm, { once: true });
    window.addEventListener("keydown", arm, { once: true });
    return () => {
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, [audioCtx, startMusic]);

  // Duplicate-tab / background safety: pause when the tab is hidden.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) bgmRef.current?.pause();
      else if (!mutedRef.current && bgmRef.current) {
        void bgmRef.current.play().then(() => setMusicPlaying(true)).catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  /**
   * First user gesture: arm the AudioContext and, unless muted, start the loop.
   * Browsers refuse to start an AudioContext before an interaction, so this is
   * driven by App's first-gesture listener rather than on mount.
   */
  const unlock = useCallback(async () => {
    audioCtx();
    if (!mutedRef.current) startMusic();
    setReady(true);
  }, [audioCtx, startMusic]);

  const api = useMemo<AudioApi>(
    () => ({ ready, unlock, muted, setMuted, toggleMute, sfx, musicPlaying, startMusic, pauseMusic }),
    [ready, unlock, muted, setMuted, toggleMute, sfx, musicPlaying, startMusic, pauseMusic],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useAudio(): AudioApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAudio must be used inside <AudioProvider>");
  return v;
}
