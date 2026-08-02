/**
 * SpeechQueue — sentence-pipelined text-to-speech playback.
 *
 * Waiting for a full answer before synthesizing it means time-to-first-audio is
 * (whole LLM generation) + (whole TTS request) — several seconds on a long reply, which
 * is the dominant latency in a spoken conversation.
 *
 * This queue instead accepts text as it streams in, cuts it at sentence boundaries, and
 * synthesizes each sentence while the previous one is still playing. The user starts
 * hearing the answer roughly one sentence into generation, and playback stays gapless
 * because the next clip is fetched during the current one.
 *
 * `stop()` is the barge-in path: it drops queued text, halts playback, and releases every
 * outstanding object URL.
 */

/** Sentence-ish boundary: terminator followed by whitespace, or a newline. */
const BOUNDARY = /([.!?]+["')\]]*\s+|\n+)/;

/** Don't cut this short — one- or two-word fragments make playback choppy. */
const MIN_CHUNK_CHARS = 12;

/**
 * Pull complete sentences off a growing buffer.
 * Returns the sentences ready to speak plus whatever remains unterminated.
 */
export function takeSentences(buffer: string): { chunks: string[]; rest: string } {
  const chunks: string[] = [];
  let rest = buffer;

  for (;;) {
    const match = BOUNDARY.exec(rest);
    if (!match || match.index === undefined) break;
    const end = match.index + match[0].length;
    const candidate = rest.slice(0, end).trim();
    rest = rest.slice(end);
    if (!candidate) continue;
    // Merge runts into the next chunk rather than speaking them alone.
    if (candidate.length < MIN_CHUNK_CHARS && chunks.length === 0 && rest.length === 0) {
      rest = candidate + " " + rest;
      break;
    }
    chunks.push(candidate);
  }

  return { chunks, rest };
}

export interface SpeechQueueOptions {
  synthesize: (text: string) => Promise<Blob>;
  /** Fired when playback begins (first clip of a run). */
  onStart?: () => void;
  /** Fired when the queue drains and nothing is left to play. */
  onIdle?: () => void;
  onError?: (err: Error) => void;
}

export class SpeechQueue {
  private readonly opts: SpeechQueueOptions;

  private buffer = "";
  private pending: string[] = [];
  private audio: HTMLAudioElement | null = null;
  private urls = new Set<string>();

  /** Bumped on every stop() so in-flight synthesis from a prior run is discarded. */
  private generation = 0;
  private running = false;
  private flushed = false;
  private started = false;

  constructor(opts: SpeechQueueOptions) {
    this.opts = opts;
  }

  get isSpeaking(): boolean {
    return this.running;
  }

  /** Feed streamed text. Complete sentences are queued for synthesis immediately. */
  push(text: string): void {
    this.buffer += text;
    const { chunks, rest } = takeSentences(this.buffer);
    this.buffer = rest;
    if (chunks.length) {
      this.pending.push(...chunks);
      void this.pump();
    }
  }

  /** Signal that no more text is coming; speak whatever partial sentence is left. */
  flush(): void {
    this.flushed = true;
    const tail = this.buffer.trim();
    this.buffer = "";
    if (tail) this.pending.push(tail);
    void this.pump();
  }

  /** Barge-in: discard queued text, stop playback, and release resources. */
  stop(): void {
    this.generation += 1;
    this.buffer = "";
    this.pending = [];
    this.flushed = false;
    this.started = false;
    this.running = false;
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    this.releaseUrls();
  }

  private releaseUrls(): void {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;

    try {
      while (this.pending.length) {
        const text = this.pending.shift()!;
        let blob: Blob;
        try {
          blob = await this.opts.synthesize(text);
        } catch (err) {
          this.opts.onError?.(err instanceof Error ? err : new Error("TTS failed."));
          continue;
        }
        if (generation !== this.generation) return; // interrupted mid-synthesis

        if (!this.started) {
          this.started = true;
          this.opts.onStart?.();
        }
        await this.play(blob, generation);
        if (generation !== this.generation) return;
      }
    } finally {
      if (generation === this.generation) {
        this.running = false;
        // More text may have arrived while the last clip played.
        if (this.pending.length) {
          void this.pump();
        } else if (this.flushed) {
          this.started = false;
          this.flushed = false;
          this.releaseUrls();
          this.opts.onIdle?.();
        }
      }
    }
  }

  private play(blob: Blob, generation: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const url = URL.createObjectURL(blob);
      this.urls.add(url);
      const audio = new Audio(url);
      this.audio = audio;

      const finish = () => {
        if (this.urls.delete(url)) URL.revokeObjectURL(url);
        if (this.audio === audio) this.audio = null;
        resolve();
      };

      audio.onended = finish;
      audio.onerror = finish;
      audio.play().catch(() => {
        // Autoplay blocked or interrupted — don't wedge the queue.
        if (generation === this.generation) finish();
        else resolve();
      });
    });
  }
}
