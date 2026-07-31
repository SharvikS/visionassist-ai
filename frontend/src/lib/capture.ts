/**
 * Screen capture + 10 FPS canvas sampling + Smart Frame Eviction.
 *
 * Acquires a display MediaStream via getDisplayMedia, draws it to an offscreen canvas at a
 * fixed sample rate, and emits only the frames whose grayscale signature differs enough from
 * the previous one (see frame-eviction.ts). Emitted frames are base64 JPEGs ready to ship to
 * the backend / model.
 */

import {
  DEFAULT_MSE_THRESHOLD,
  SIGNATURE_SIZE,
  grayscaleSignature,
  shouldDispatch,
} from "./frame-eviction";

export interface CaptureStats {
  sampled: number;
  dispatched: number;
  evicted: number;
  lastMse: number;
  width: number;
  height: number;
}

export interface ScreenCaptureOptions {
  fps?: number;
  jpegQuality?: number;
  mseThreshold?: number;
  /** Called for every frame that survives eviction (base64 JPEG, no data: prefix). */
  onFrame: (jpegBase64: string, stats: CaptureStats) => void;
  onStats?: (stats: CaptureStats) => void;
  /** Called when the user stops sharing from the browser UI. */
  onEnded?: () => void;
}

export class ScreenCapture {
  private readonly fps: number;
  private readonly jpegQuality: number;
  private readonly mseThreshold: number;
  private readonly opts: ScreenCaptureOptions;

  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private sigCanvas: HTMLCanvasElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private prevSig: Uint8Array | null = null;

  private stats: CaptureStats = {
    sampled: 0,
    dispatched: 0,
    evicted: 0,
    lastMse: 0,
    width: 0,
    height: 0,
  };

  constructor(opts: ScreenCaptureOptions) {
    this.opts = opts;
    this.fps = opts.fps ?? 10;
    this.jpegQuality = opts.jpegQuality ?? 0.7;
    this.mseThreshold = opts.mseThreshold ?? DEFAULT_MSE_THRESHOLD;
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
  }

  resetStats(): void {
    this.stats = { ...this.stats, sampled: 0, dispatched: 0, evicted: 0, lastMse: 0 };
  }

  private handleEnded(): void {
    this.stop();
    this.opts.onEnded?.();
  }

  /** Force-dispatch the current frame on the next tick regardless of visual change. */
  requestKeyframe(): void {
    this.prevSig = null;
  }

  private tick(): void {
    const video = this.video;
    const canvas = this.canvas;
    const sigCanvas = this.sigCanvas;
    if (!video || !canvas || !sigCanvas || video.videoWidth === 0) return;

    const w = video.videoWidth;
    const h = video.videoHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    this.stats.width = w;
    this.stats.height = h;

    const ctx = canvas.getContext("2d");
    const sigCtx = sigCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx || !sigCtx) return;

    ctx.drawImage(video, 0, 0, w, h);
    // Downscale into the tiny signature canvas for a cheap perceptual comparison.
    sigCtx.drawImage(video, 0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE);
    const sigData = sigCtx.getImageData(0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE).data;
    const sig = grayscaleSignature(sigData);

    this.stats.sampled += 1;
    const { dispatch, mse } = shouldDispatch(sig, this.prevSig, this.mseThreshold);
    this.stats.lastMse = Number.isFinite(mse) ? Math.round(mse * 10) / 10 : 0;

    if (dispatch) {
      this.prevSig = sig;
      this.stats.dispatched += 1;
      const jpeg = canvas.toDataURL("image/jpeg", this.jpegQuality).split(",")[1];
      this.opts.onFrame(jpeg, { ...this.stats });
    } else {
      this.stats.evicted += 1;
    }
    this.opts.onStats?.({ ...this.stats });
  }
}
