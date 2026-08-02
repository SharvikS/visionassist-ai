/**
 * Screen capture + canvas sampling + Smart Frame Eviction.
 *
 * Acquires a display MediaStream via getDisplayMedia, samples it at a fixed rate, and emits
 * only the frames whose grayscale signature differs enough from the previous one (see
 * frame-eviction.ts). Emitted frames are base64 JPEGs ready to ship to the backend / model.
 *
 * The hot path is deliberately ordered to do the least work possible:
 *
 *   1. Draw a 32x32 thumbnail and diff it — the only work every tick pays.
 *   2. Bail here if the frame is evicted (the common case on a static screen).
 *   3. Only for surviving frames: draw the full frame (downscaled) and encode it.
 *
 * Encoding uses the async `toBlob` rather than the synchronous `toDataURL`, so JPEG
 * compression doesn't block the main thread and stall the UI while sharing.
 */

import {
  DEFAULT_MSE_THRESHOLD,
  SIGNATURE_SIZE,
  grayscaleSignature,
  shouldDispatch,
} from "./frame-eviction";

/**
 * Longest-edge cap applied before encoding. Screen shares are commonly 1440p or 4K, but
 * vision models gain nothing from those extra pixels for UI content — and cost scales with
 * them. Capping here cuts both the token bill and the bytes on the wire.
 */
export const DEFAULT_MAX_DIMENSION = 1536;

/** Stats are pushed to React at most this often, rather than on every sampled frame. */
const STATS_INTERVAL_MS = 250;

export interface CaptureStats {
  sampled: number;
  dispatched: number;
  evicted: number;
  /** Frames skipped because the previous encode or send hadn't drained yet. */
  dropped: number;
  lastMse: number;
  width: number;
  height: number;
}

export interface ScreenCaptureOptions {
  fps?: number;
  jpegQuality?: number;
  mseThreshold?: number;
  /** Longest-edge cap for the encoded frame. Defaults to DEFAULT_MAX_DIMENSION. */
  maxDimension?: number;
  /** Called for every frame that survives eviction (base64 JPEG, no data: prefix). */
  onFrame: (jpegBase64: string, stats: CaptureStats) => void;
  onStats?: (stats: CaptureStats) => void;
  /** Called when the user stops sharing from the browser UI. */
  onEnded?: () => void;
  /**
   * Backpressure hook. Return false to skip encoding this frame — used to avoid piling
   * frames into a WebSocket send buffer that isn't draining.
   */
  canSend?: () => boolean;
}

export class ScreenCapture {
  private readonly fps: number;
  private readonly jpegQuality: number;
  private readonly mseThreshold: number;
  private readonly maxDimension: number;
  private readonly opts: ScreenCaptureOptions;

  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private sigCanvas: HTMLCanvasElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private prevSig: Uint8Array | null = null;

  /** True while an async JPEG encode is in flight; prevents overlapping encodes. */
  private encoding = false;
  private lastStatsAt = 0;

  private stats: CaptureStats = {
    sampled: 0,
    dispatched: 0,
    evicted: 0,
    dropped: 0,
    lastMse: 0,
    width: 0,
    height: 0,
  };

  constructor(opts: ScreenCaptureOptions) {
    this.opts = opts;
    this.fps = opts.fps ?? 10;
    this.jpegQuality = opts.jpegQuality ?? 0.7;
    this.mseThreshold = opts.mseThreshold ?? DEFAULT_MSE_THRESHOLD;
    this.maxDimension = opts.maxDimension ?? DEFAULT_MAX_DIMENSION;
  }

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: this.fps },
      audio: false,
    });

    // User can stop sharing from the browser chrome — react to that.
    const [track] = this.stream.getVideoTracks();
    track.addEventListener("ended", () => this.handleEnded());

    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = this.stream;
    await this.video.play();

    this.canvas = document.createElement("canvas");
    this.sigCanvas = document.createElement("canvas");
    this.sigCanvas.width = SIGNATURE_SIZE;
    this.sigCanvas.height = SIGNATURE_SIZE;

    this.prevSig = null;
    this.encoding = false;
    this.timer = setInterval(() => this.tick(), 1000 / this.fps);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.canvas = null;
    this.sigCanvas = null;
    this.prevSig = null;
    this.encoding = false;
  }

  resetStats(): void {
    this.stats = { ...this.stats, sampled: 0, dispatched: 0, evicted: 0, dropped: 0, lastMse: 0 };
  }

  private handleEnded(): void {
    this.stop();
    this.opts.onEnded?.();
  }

  /** Force-dispatch the current frame on the next tick regardless of visual change. */
  requestKeyframe(): void {
    this.prevSig = null;
  }

  /** Target encode size for a source frame, preserving aspect ratio. */
  private scaledSize(w: number, h: number): { width: number; height: number } {
    const longest = Math.max(w, h);
    if (longest <= this.maxDimension) return { width: w, height: h };
    const scale = this.maxDimension / longest;
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
  }

  private emitStats(force = false): void {
    if (!this.opts.onStats) return;
    const now = performance.now();
    // Throttled: at 10 FPS an unthrottled callback re-renders the panel 10x a second.
    if (!force && now - this.lastStatsAt < STATS_INTERVAL_MS) return;
    this.lastStatsAt = now;
    this.opts.onStats({ ...this.stats });
  }

  private tick(): void {
    const video = this.video;
    const canvas = this.canvas;
    const sigCanvas = this.sigCanvas;
    if (!video || !canvas || !sigCanvas || video.videoWidth === 0) return;

    const sigCtx = sigCanvas.getContext("2d", { willReadFrequently: true });
    if (!sigCtx) return;

    this.stats.width = video.videoWidth;
    this.stats.height = video.videoHeight;

    // Step 1: the cheap comparison. Downscale straight from the video element into the
    // 32x32 signature canvas — no full-resolution draw needed to decide eviction.
    sigCtx.drawImage(video, 0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE);
    const sigData = sigCtx.getImageData(0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE).data;
    const sig = grayscaleSignature(sigData);

    this.stats.sampled += 1;
    const { dispatch, mse } = shouldDispatch(sig, this.prevSig, this.mseThreshold);
    this.stats.lastMse = Number.isFinite(mse) ? Math.round(mse * 10) / 10 : 0;

    // Step 2: bail before any expensive work if the frame isn't going anywhere.
    if (!dispatch) {
      this.stats.evicted += 1;
      this.emitStats();
      return;
    }

    // Step 3: drop rather than queue when the previous frame is still encoding or the
    // transport is backed up. A stale frame is worthless; a growing backlog is harmful.
    if (this.encoding || this.opts.canSend?.() === false) {
      this.stats.dropped += 1;
      this.emitStats();
      return;
    }

    this.prevSig = sig;
    this.encoding = true;

    const { width, height } = this.scaledSize(video.videoWidth, video.videoHeight);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      this.encoding = false;
      return;
    }
    ctx.drawImage(video, 0, 0, width, height);

    // Async encode — unlike toDataURL, this doesn't block the main thread.
    canvas.toBlob(
      (blob) => {
        if (!blob || !this.timer) {
          this.encoding = false;
          return;
        }
        const reader = new FileReader();
        reader.onloadend = () => {
          this.encoding = false;
          if (!this.timer) return; // capture stopped mid-encode
          const result = typeof reader.result === "string" ? reader.result : "";
          const base64 = result.split(",")[1];
          if (!base64) return;
          this.stats.dispatched += 1;
          this.opts.onFrame(base64, { ...this.stats });
          this.emitStats(true);
        };
        reader.onerror = () => {
          this.encoding = false;
        };
        reader.readAsDataURL(blob);
      },
      "image/jpeg",
      this.jpegQuality,
    );
  }
}
