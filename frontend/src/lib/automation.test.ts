import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Action, executePlan, planActions, riskOf } from "./automation";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("riskOf", () => {
  it("classifies state-changing actions as high risk", () => {
    const high: Action[] = [
      { type: "navigate", url: "https://example.com" },
      { type: "click", x: 0.5, y: 0.5 },
      { type: "type", text: "hi" },
      { type: "press", key: "Enter" },
    ];
    for (const action of high) expect(riskOf(action)).toBe("high");
  });

  it("classifies observational actions as low risk", () => {
    const low: Action[] = [
      { type: "scroll", dy: 1 },
      { type: "wait", ms: 100 },
      { type: "screenshot" },
    ];
    for (const action of low) expect(riskOf(action)).toBe("low");
  });

  it("agrees with the backend's classification", () => {
    // Mirrors ActionRisk in backend/app/automation/schema.py. If the two drift, the
    // approval UI stops flagging something the server considers dangerous.
    const backendHighRisk = ["navigate", "click", "type", "press"];
    const backendLowRisk = ["scroll", "wait", "screenshot"];
    for (const type of backendHighRisk) {
      expect(riskOf({ type } as Action)).toBe("high");
    }
    for (const type of backendLowRisk) {
      expect(riskOf({ type } as Action)).toBe("low");
    }
  });
});

describe("planActions", () => {
  it("posts the goal and screenshot with the BYOK key in the header", async () => {
    const body = {
      plan: { goal: "g", actions: [] },
      summary: [],
      requires_approval: false,
      is_empty: true,
    };
    vi.mocked(fetch).mockResolvedValue(jsonResponse(body));

    const result = await planActions(
      {
        provider: "openai",
        model: "gpt-4o",
        goal: "find the docs",
        screenshot: "BASE64",
      },
      "sk-secret",
    );

    expect(result.is_empty).toBe(true);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toMatch(/\/automation\/plan$/);
    const headers = (init!.headers ?? {}) as Record<string, string>;
    expect(headers["X-Provider-Key"]).toBe("sk-secret");
    // The key authenticates the call; it must not also be in the body.
    expect(String(init!.body)).not.toContain("sk-secret");
  });

  it("surfaces the server's rejection message", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ detail: "The model did not return a valid action plan." }, 422),
    );
    await expect(
      planActions(
        { provider: "openai", model: "gpt-4o", goal: "x", screenshot: "b" },
        "k",
      ),
    ).rejects.toThrow(/valid action plan/);
  });

  it("falls back to status text when the error body is not JSON", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("gateway blew up", { status: 502, statusText: "Bad Gateway" }),
    );
    await expect(
      planActions(
        { provider: "openai", model: "gpt-4o", goal: "x", screenshot: "b" },
        "k",
      ),
    ).rejects.toThrow(/502/);
  });
});

describe("executePlan", () => {
  const plan = {
    goal: "g",
    actions: [{ type: "click", x: 0.5, y: 0.5 }] as Action[],
  };

  it("sends approved: true — the flag the server gates on", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ results: [] }));
    await executePlan(plan);

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toMatch(/\/automation\/execute$/);
    expect(JSON.parse(String(init!.body))).toEqual({ plan, approved: true });
  });

  it("returns the per-action results", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        results: [
          { index: 0, description: "Click at (0.500, 0.500)", ok: true, detail: "" },
        ],
      }),
    );
    const results = await executePlan(plan);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });

  it("returns an empty list when the server reports no results", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ detail: "Nothing to do." }));
    expect(await executePlan(plan)).toEqual([]);
  });

  it("propagates a refused approval as an error", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ detail: "Plan was not approved." }, 403),
    );
    await expect(executePlan(plan)).rejects.toThrow(/not approved/);
  });

  it("propagates automation being disabled", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ detail: "Automation is disabled." }, 503),
    );
    await expect(executePlan(plan)).rejects.toThrow(/disabled/);
  });
});
