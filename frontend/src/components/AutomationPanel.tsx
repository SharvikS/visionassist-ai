"use client";

import { useCallback, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  MousePointerClick,
  Play,
  ShieldQuestion,
  X,
} from "lucide-react";
import {
  ActionPlan,
  ActionResult,
  executePlan,
  planActions,
  riskOf,
} from "@/lib/automation";
import { ScreenCapture } from "@/lib/capture";
import Button from "./ui/Button";
import { useUsage } from "./usage-context";
import { useVault } from "./vault-context";

type Phase = "idle" | "planning" | "review" | "running" | "done";

/** How long to wait for the first decodable frame after the share is granted. */
const FRAME_TIMEOUT_MS = 10_000;

/**
 * Milestone-4 surface: the model proposes browser actions, a human approves them, and
 * only then do they run.
 *
 * The review step is the entire point, so the UI is built to make rejection easy and
 * approval deliberate: the plan is listed action by action with the model's own stated
 * reason for each, state-changing steps are flagged, and the approve button says exactly
 * how many actions it will run. Nothing is pre-approved and there is no "always allow".
 */
export default function AutomationPanel() {
  const { activeProvider, activeModel, configured, getKey } = useVault();
  const { record } = useUsage();

  const [phase, setPhase] = useState<Phase>("idle");
  const [goal, setGoal] = useState("");
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [results, setResults] = useState<ActionResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const captureRef = useRef<ScreenCapture | null>(null);

  const hasKey = configured.includes(activeProvider);
  const busy = phase === "planning" || phase === "running";

  /** Grab a single frame of the shared screen to plan against. */
  const grabFrame = useCallback(async (): Promise<string> => {
    return new Promise((resolve, reject) => {
      // Without this, a stream that starts but never produces a decodable frame leaves
      // the promise pending forever and the UI stuck on "Planning…".
      const timeout = setTimeout(() => {
        settle(() => reject(new Error("Timed out waiting for a screen frame.")));
      }, FRAME_TIMEOUT_MS);

      let settled = false;
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        captureRef.current?.stop();
        captureRef.current = null;
        finish();
      };

      const capture = new ScreenCapture({
        fps: 1,
        onFrame: (jpegBase64) => settle(() => resolve(jpegBase64)),
        onEnded: () =>
          settle(() => reject(new Error("Screen share ended before a frame arrived."))),
      });
      captureRef.current = capture;
      capture.start().catch((err) => settle(() => reject(err)));
    });
  }, []);

  async function propose() {
    const text = goal.trim();
    if (!text || busy) return;

    setError(null);
    setNotice(null);
    setResults([]);
    setPlan(null);
    setPhase("planning");

    try {
      const key = await getKey(activeProvider);
      if (!key) throw new Error(`No API key configured for ${activeProvider}.`);

      const screenshot = await grabFrame();
      const response = await planActions(
        { provider: activeProvider, model: activeModel, goal: text, screenshot },
        key,
      );

      // Planning is a vision call — bill it whether or not the plan is approved.
      record({ promptText: text, frames: 1 });

      if (response.is_empty) {
        setNotice(
          "The model returned no actions — the goal may already be met, or it could not see what it needs.",
        );
        setPhase("idle");
        return;
      }

      setPlan(response.plan);
      setPhase("review");
    } catch (err) {
      captureRef.current?.stop();
      captureRef.current = null;
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        setError("Screen share is required to plan actions.");
      } else {
        setError(err instanceof Error ? err.message : "Planning failed.");
      }
      setPhase("idle");
    }
  }

  async function approve() {
    if (!plan || busy) return;
    setError(null);
    setPhase("running");
    try {
      setResults(await executePlan(plan));
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Execution failed.");
      setPhase("review"); // stay on the plan so the user can retry or reject
    }
  }

  function reject() {
    setPlan(null);
    setResults([]);
    setPhase("idle");
    setNotice("Plan rejected. Nothing was run.");
  }

  const highRiskCount = plan?.actions.filter((a) => riskOf(a) === "high").length ?? 0;

  return (
    <div className="flex h-full flex-col p-4">
      <div className="flex items-end gap-2">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              propose();
            }
          }}
          rows={1}
          disabled={busy || phase === "review"}
          placeholder={
            hasKey ? "What should it do? e.g. search for the docs" : "Add an API key first"
          }
          className="va-focus max-h-24 flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none transition-colors duration-300 focus:border-accent disabled:opacity-50"
        />
        <Button
          onClick={propose}
          disabled={!goal.trim() || phase === "review" || !hasKey}
          loading={phase === "planning"}
        >
          {phase !== "planning" && <MousePointerClick size={15} />}
          {phase === "planning" ? "Planning…" : "Plan"}
        </Button>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        Actions run in a browser on the server — never on your desktop. Every plan needs
        your approval before anything runs.
      </p>

      <div className="mt-3 flex-1 overflow-y-auto">
        {phase === "review" && plan && (
          <div className="va-in-up rounded-xl border border-warning/40 bg-warning/5 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <ShieldQuestion size={15} className="text-warning" />
              Approve {plan.actions.length}{" "}
              {plan.actions.length === 1 ? "action" : "actions"}?
            </div>

            <ol className="space-y-2">
              {plan.actions.map((action, i) => (
                <li
                  key={i}
                  className={
                    "va-row va-in-up flex gap-2 rounded-lg border border-transparent p-1.5 text-xs hover:border-border hover:bg-surface-2/50 " +
                    `va-d-${Math.min(i + 1, 6)}`
                  }
                >
                  <span className="mt-0.5 tabular-nums text-muted">{i + 1}.</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <code className="rounded bg-surface-2 px-1 py-0.5 text-[11px]">
                        {action.type}
                      </code>
                      {riskOf(action) === "high" && (
                        <span
                          className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-warning"
                          title="Changes state on the page"
                        >
                          <AlertTriangle size={11} /> changes state
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 break-words text-muted">
                      {describe(action)}
                    </div>
                    {action.reason && (
                      <div className="mt-0.5 break-words italic text-muted/80">
                        &ldquo;{action.reason}&rdquo;
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>

            {highRiskCount > 0 && (
              <p className="mt-3 text-[11px] text-warning">
                {highRiskCount} of these change page state. Read them before approving —
                the plan was written by a model that read your screen.
              </p>
            )}

            <div className="mt-3 flex gap-2">
              <Button onClick={approve} size="sm">
                <Play size={14} /> Run {plan.actions.length}
              </Button>
              <Button onClick={reject} variant="danger" size="sm">
                <X size={14} /> Reject
              </Button>
            </div>
          </div>
        )}

        {phase === "running" && (
          <p className="text-center text-sm text-muted">
            <span className="va-pulse">Running the approved plan…</span>
          </p>
        )}

        {results.length > 0 && (
          <ol className="mt-3 space-y-1.5">
            {results.map((r) => (
              <li key={r.index} className="flex gap-2 text-xs">
                {r.ok ? (
                  <Check size={13} className="mt-0.5 shrink-0 text-success" />
                ) : (
                  <X size={13} className="mt-0.5 shrink-0 text-danger" />
                )}
                <div className="min-w-0">
                  <div className="break-words">{r.description}</div>
                  {r.detail && (
                    <div className="break-words text-muted">{r.detail}</div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}

        {notice && phase === "idle" && (
          <p className="text-center text-sm text-muted">{notice}</p>
        )}

        {phase === "idle" && !notice && (
          <p className="text-center text-sm text-muted">
            Describe a goal. You&apos;ll review the plan before anything runs.
          </p>
        )}
      </div>

      {error && (
        <div className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
    </div>
  );
}

/** Human-readable one-liner, mirroring `describe()` on the backend actions. */
function describe(action: ActionPlan["actions"][number]): string {
  switch (action.type) {
    case "navigate":
      return `Navigate to ${action.url}`;
    case "click":
      return `Click at (${action.x.toFixed(3)}, ${action.y.toFixed(3)})`;
    case "type": {
      const preview =
        action.text.length <= 40 ? action.text : `${action.text.slice(0, 37)}...`;
      return action.selector
        ? `Type "${preview}" into ${action.selector}`
        : `Type "${preview}"`;
    }
    case "press":
      return `Press ${action.key}`;
    case "scroll":
      return `Scroll ${action.dy >= 0 ? "down" : "up"} ${Math.abs(action.dy)} viewport(s)`;
    case "wait":
      return `Wait ${action.ms}ms`;
    case "screenshot":
      return "Take a screenshot";
  }
}
