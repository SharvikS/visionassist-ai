/**
 * Client for the automation endpoints, mirroring backend/app/automation/schema.py.
 *
 * The types here are deliberately a mirror rather than a loose `unknown` — the approval
 * UI renders these fields to a human who is deciding whether to let them run, so a
 * shape change that silently drops a field from the review is a safety regression, not
 * a cosmetic one.
 */

import { API_BASE } from "./api";
import { ProviderId } from "./providers";

export type ActionRisk = "low" | "high";

export interface BaseAction {
  reason?: string;
}

export type Action =
  | ({ type: "navigate"; url: string } & BaseAction)
  | ({ type: "click"; x: number; y: number } & BaseAction)
  | ({ type: "type"; text: string; selector?: string | null } & BaseAction)
  | ({ type: "press"; key: string } & BaseAction)
  | ({ type: "scroll"; dy: number } & BaseAction)
  | ({ type: "wait"; ms: number } & BaseAction)
  | ({ type: "screenshot" } & BaseAction);

export interface ActionPlan {
  goal: string;
  actions: Action[];
}

export interface PlanResponse {
  plan: ActionPlan;
  summary: string[];
  requires_approval: boolean;
  is_empty: boolean;
}

export interface ActionResult {
  index: number;
  description: string;
  ok: boolean;
  detail: string;
}

/** Which actions change state. Mirrors ActionRisk in the backend schema. */
const HIGH_RISK: ReadonlySet<Action["type"]> = new Set([
  "navigate",
  "click",
  "type",
  "press",
]);

export function riskOf(action: Action): ActionRisk {
  return HIGH_RISK.has(action.type) ? "high" : "low";
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return typeof body?.detail === "string" ? body.detail : JSON.stringify(body);
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

/** Ask the model for a plan. Runs nothing — the response is inert until approved. */
export async function planActions(
  req: { provider: ProviderId; model: string; goal: string; screenshot: string },
  apiKey: string,
): Promise<PlanResponse> {
  const res = await fetch(`${API_BASE}/automation/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Provider-Key": apiKey },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

/**
 * Execute a plan the user approved.
 *
 * `approved` is sent explicitly rather than implied by calling this function, so the
 * flag the server gates on is visible at the call site — the one place a reviewer of
 * this code would look to check that nothing runs unreviewed.
 */
export async function executePlan(plan: ActionPlan): Promise<ActionResult[]> {
  const res = await fetch(`${API_BASE}/automation/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan, approved: true }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const body = await res.json();
  return body.results ?? [];
}
