import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechQueue, takeSentences } from "./speech-queue";

describe("takeSentences", () => {
  it("returns nothing for an unterminated fragment", () => {
    const { chunks, rest } = takeSentences("this has no ending yet");
    expect(chunks).toEqual([]);
    expect(rest).toBe("this has no ending yet");
  });

  it("splits on a sentence terminator followed by whitespace", () => {
    const { chunks, rest } = takeSentences("First sentence here. Second one trails");
    expect(chunks).toEqual(["First sentence here."]);
    expect(rest).toBe("Second one trails");
  });

  it("splits on question and exclamation marks", () => {
    expect(takeSentences("Is this working? ").chunks).toEqual(["Is this working?"]);
    expect(takeSentences("That certainly works! ").chunks).toEqual([
      "That certainly works!",
    ]);
  });

  it("holds back a short exclamation rather than speaking a runt clip", () => {
    // Under the 12-character minimum, so it waits for the next sentence.
    expect(takeSentences("It works! ").chunks).toEqual([]);
  });

  it("keeps a closing quote or bracket with its sentence", () => {
    const { chunks } = takeSentences('He said "all done." Next part follows');
    expect(chunks).toEqual(['He said "all done."']);
  });

  it("splits on newlines", () => {
    const { chunks } = takeSentences("Line one is long enough\nLine two");
    expect(chunks).toEqual(["Line one is long enough"]);
  });

  it("extracts several sentences from one buffer", () => {
    const { chunks, rest } = takeSentences(
      "The first one here. The second one here! And a trailing bit",
    );
    expect(chunks).toEqual(["The first one here.", "The second one here!"]);
    expect(rest).toBe("And a trailing bit");
  });

  it("holds back a short leading fragment instead of speaking it alone", () => {
    // "Ok." on its own would be a choppy one-word clip.
    const { chunks, rest } = takeSentences("Ok. ");
    expect(chunks).toEqual([]);
    expect(rest.trim()).toBe("Ok.");
  });

  it("does not lose text across repeated calls", () => {
    let buffer = "";
    const spoken: string[] = [];
    for (const piece of ["Hello there friend", ". ", "How are you today", "? "]) {
      buffer += piece;
      const { chunks, rest } = takeSentences(buffer);
      spoken.push(...chunks);
      buffer = rest;
    }
    expect(spoken.join(" ") + buffer).toContain("Hello there friend.");
    expect(spoken.join(" ") + buffer).toContain("How are you today?");
  });
});

describe("SpeechQueue", () => {
  beforeEach(() => {
    // jsdom has no real audio pipeline; make playback resolve immediately.
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => `blob:${Math.random()}`),
      revokeObjectURL: vi.fn(),
    });
    class FakeAudio {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
      pause = vi.fn();
      play = vi.fn(() => {
        // Fire completion on the next tick, like a real short clip.
        setTimeout(() => this.onended?.(), 0);
        return Promise.resolve();
      });
    }
    vi.stubGlobal("Audio", FakeAudio);
  });

  const blob = () => new Blob(["audio"], { type: "audio/mpeg" });

  it("synthesizes each complete sentence as it streams in", async () => {
    // Typed parameter so `mock.calls[n][0]` is the text, not an empty tuple.
    const synthesize = vi.fn(async (_text: string) => blob());
    const queue = new SpeechQueue({ synthesize });

    queue.push("The first sentence here. ");
    queue.push("The second sentence here. ");
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(2));

    expect(synthesize.mock.calls.map((c) => c[0])).toEqual([
      "The first sentence here.",
      "The second sentence here.",
    ]);
  });

  it("does not synthesize an unterminated fragment until flushed", async () => {
    const synthesize = vi.fn(async () => blob());
    const queue = new SpeechQueue({ synthesize });

    queue.push("still going");
    await new Promise((r) => setTimeout(r, 10));
    expect(synthesize).not.toHaveBeenCalled();

    queue.flush();
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledWith("still going"));
  });

  it("reports idle once the queue drains after a flush", async () => {
    const onIdle = vi.fn();
    const queue = new SpeechQueue({ synthesize: async () => blob(), onIdle });

    queue.push("A complete sentence here. ");
    queue.flush();
    await vi.waitFor(() => expect(onIdle).toHaveBeenCalled());
  });

  it("stop() discards queued text so barge-in cannot resume the old answer", async () => {
    const synthesize = vi.fn(async () => blob());
    const queue = new SpeechQueue({ synthesize });

    queue.push("One sentence here. Two sentence here. Three sentence here. ");
    queue.stop();
    const callsAtStop = synthesize.mock.calls.length;

    await new Promise((r) => setTimeout(r, 20));
    // At most the one already in flight when stop() landed.
    expect(synthesize.mock.calls.length).toBeLessThanOrEqual(callsAtStop + 1);
    expect(queue.isSpeaking).toBe(false);
  });

  it("drops synthesis that completes after an interrupt", async () => {
    let release: (b: Blob) => void = () => {};
    const synthesize = vi.fn(
      () => new Promise<Blob>((resolve) => { release = resolve; }),
    );
    const onStart = vi.fn();
    const queue = new SpeechQueue({ synthesize, onStart });

    queue.push("A sentence long enough here. ");
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalled());

    queue.stop();          // barge-in while synthesis is still outstanding
    release(blob());       // the stale request finally resolves
    await new Promise((r) => setTimeout(r, 20));

    // The late result must not begin playback for an answer the user interrupted.
    expect(onStart).not.toHaveBeenCalled();
  });

  it("keeps going when one sentence fails to synthesize", async () => {
    const synthesize = vi
      .fn()
      .mockRejectedValueOnce(new Error("TTS 500"))
      .mockResolvedValue(blob());
    const onError = vi.fn();
    const queue = new SpeechQueue({ synthesize, onError });

    queue.push("The first sentence here. The second sentence here. ");
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(2));
    expect(onError).toHaveBeenCalled();
  });

  it("releases object URLs rather than leaking them for the tab's lifetime", async () => {
    const queue = new SpeechQueue({ synthesize: async () => blob() });
    queue.push("A sentence long enough here. ");
    queue.flush();
    await vi.waitFor(() =>
      expect(URL.revokeObjectURL).toHaveBeenCalled(),
    );
  });
});
