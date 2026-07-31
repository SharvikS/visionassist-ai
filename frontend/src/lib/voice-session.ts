/**
 * VoiceSession — microphone capture, Voice Activity Detection, and per-utterance recording.
 *
 * Uses the Web Audio API (AnalyserNode RMS) for a lightweight, dependency-free energy VAD and
 * segments speech with a MediaRecorder. The VAD is intentionally isolated behind this class's
 * callbacks so a Silero-WASM detector can replace the energy heuristic later without changing
 * any callers.
 *
 *   onSpeechStart → fires on speech onset (used to interrupt the assistant mid-response)
 *   onUtterance   → fires with the recorded audio blob once the user stops speaking
 */

export interface VoiceSessionOptions {
  /** Normalized mic level 0..1 for a meter/waveform. */
  onLevel?: (rms: number) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onUtterance: (audio: Blob) => void;
  onError?: (err: Error) => void;
  /** Trailing silence (ms) that ends an utterance. */
  silenceMs?: number;
  /** Minimum speech duration (ms) to count as a real utterance (filters blips). */
  minSpeechMs?: number;
  /** RMS onset threshold, 0..1. */
  threshold?: number;
}

function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

export class VoiceSession {
  private readonly opts: VoiceSessionOptions;
  private readonly silenceMs: number;
  private readonly minSpeechMs: number;
  private readonly threshold: number;

  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buf: Uint8Array<ArrayBuffer> | null = null;

  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType = "";

  private speaking = false;
  private speechStartTs = 0;
  private lastVoiceTs = 0;
  private utteranceMs = 0;

  constructor(opts: VoiceSessionOptions) {
    this.opts = opts;
    this.silenceMs = opts.silenceMs ?? 800;
    this.minSpeechMs = opts.minSpeechMs ?? 250;
    this.threshold = opts.threshold ?? 0.025;
  }

  get isActive(): boolean {
    return this.timer !== null;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.audioCtx = new AudioContext();
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);
    this.buf = new Uint8Array(this.analyser.fftSize);
    this.mimeType = pickMimeType();

    this.timer = setInterval(() => this.tick(), 40);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        /* ignore */
      }
    }
    this.recorder = null;
    this.speaking = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.analyser = null;
  }

  private currentRms(): number {
    if (!this.analyser || !this.buf) return 0;
    this.analyser.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = (this.buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this.buf.length);
  }

  private tick(): void {
    const rms = this.currentRms();
    this.opts.onLevel?.(Math.min(1, rms * 4));
    const now = performance.now();

    if (rms > this.threshold) {
      this.lastVoiceTs = now;
      if (!this.speaking) {
        this.speaking = true;
        this.speechStartTs = now;
        this.startRecording();
        this.opts.onSpeechStart?.();
      }
    } else if (this.speaking && now - this.lastVoiceTs > this.silenceMs) {
      this.speaking = false;
      this.utteranceMs = this.lastVoiceTs - this.speechStartTs;
      this.stopRecording();
      this.opts.onSpeechEnd?.();
    }
  }

  private startRecording(): void {
    if (!this.stream) return;
    this.chunks = [];
    try {
      this.recorder = this.mimeType
        ? new MediaRecorder(this.stream, { mimeType: this.mimeType })
        : new MediaRecorder(this.stream);
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error("MediaRecorder failed."));
      return;
    }
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => {
      const type = this.mimeType || "audio/webm";
      const blob = new Blob(this.chunks, { type });
      // Drop sub-threshold blips (accidental noise) below the minimum speech duration.
      if (this.utteranceMs >= this.minSpeechMs && blob.size > 0) {
        this.opts.onUtterance(blob);
      }
    };
    this.recorder.start();
  }

  private stopRecording(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
    }
  }
}
