"""On-screen automation endpoints (M4) — plan, then execute what a human approved.

Two endpoints, deliberately separate:

  POST /automation/plan     model proposes; nothing runs
  POST /automation/execute  a human-approved plan runs

Splitting them is the approval gate. `/plan` has no side effects at all, so the model's
output is inert until a person has read the plan and posted it back. A single endpoint
that planned and executed in one call would have no point at which review could happen.

The whole feature is **off unless `VA_AUTOMATION_ENABLED` is set**. It is the only part of
this service that acts rather than answers, so it does not turn itself on by default.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field, ValidationError

from ..automation import ActionPlan
from ..automation.playwright_page import launch
from ..automation.prompt import ACTION_SYSTEM_PROMPT, build_goal_message
from ..automation.runner import AutomationError, execute_plan
from ..config import get_settings
from ..providers import ProviderError
from ..router import get_router
from ..schemas import MAX_IMAGE_B64_CHARS, ChatRequest, Message, Provider

logger = logging.getLogger("visionassist.automation")
router = APIRouter(tags=["automation"])

MAX_GOAL_CHARS = 2_000

#: Models wrap JSON in prose or a markdown fence despite instructions not to. Salvaging
#: the object is a parsing concern, not a safety one — whatever comes out still has to
#: pass the full ActionPlan schema before it can be shown to anyone.
_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL)


def _require_key(x_provider_key: str | None) -> str:
    if not x_provider_key:
        raise HTTPException(
            status_code=401,
            detail="Missing BYOK provider key. Supply it in the 'X-Provider-Key' header.",
        )
    return x_provider_key


def _require_enabled() -> None:
    if not get_settings().automation_enabled:
        raise HTTPException(
            status_code=503,
            detail=(
                "Automation is disabled. Set VA_AUTOMATION_ENABLED=true to turn it on."
            ),
        )


class PlanRequest(BaseModel):
    provider: Provider
    model: str = Field(..., min_length=1, max_length=200)
    goal: str = Field(..., min_length=1, max_length=MAX_GOAL_CHARS)
    #: base64 JPEG of the page the plan should be made against.
    screenshot: str = Field(..., min_length=1, max_length=MAX_IMAGE_B64_CHARS)


class PlanResponse(BaseModel):
    plan: ActionPlan
    summary: list[str]
    requires_approval: bool
    is_empty: bool


class ExecuteRequest(BaseModel):
    plan: ActionPlan
    #: Must be true. Not a formality — it is the one field that distinguishes a plan a
    #: human chose to run from one that merely round-tripped through the client.
    approved: bool = False


def _extract_json(text: str) -> dict[str, Any]:
    """Pull the first JSON object out of a model response."""
    fenced = _FENCE.search(text)
    candidate = fenced.group(1) if fenced else text
    start, end = candidate.find("{"), candidate.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("No JSON object in the model response.")
    parsed = json.loads(candidate[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("Model response was not a JSON object.")
    return parsed


@router.post("/automation/plan", response_model=PlanResponse)
async def plan_actions(
    req: PlanRequest,
    x_provider_key: str | None = Header(default=None),
) -> PlanResponse:
    """Ask the model for an action plan. Runs nothing."""
    _require_enabled()
    key = _require_key(x_provider_key)

    chat_req = ChatRequest(
        provider=req.provider,
        model=req.model,
        messages=[
            Message(role="system", text=ACTION_SYSTEM_PROMPT),
            Message(
                role="user",
                text=build_goal_message(req.goal),
                images=[req.screenshot],
            ),
        ],
        max_tokens=2048,
        temperature=0.0,
    )

    try:
        result = await get_router().chat(chat_req, api_key=key)
    except ProviderError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e

    try:
        plan = ActionPlan.model_validate(_extract_json(result.text))
    except (ValueError, ValidationError) as e:
        # The model produced something the schema rejects. That is the schema working —
        # report it plainly rather than relaying the model's raw text, which at this
        # point may be echoing hostile page content.
        logger.warning("Rejected model action plan: %s", e)
        raise HTTPException(
            status_code=422,
            detail="The model did not return a valid action plan. Try rephrasing the goal.",
        ) from e

    return PlanResponse(
        plan=plan,
        summary=plan.summary(),
        requires_approval=plan.requires_approval,
        is_empty=plan.is_empty,
    )


@router.post("/automation/execute")
async def execute_actions(req: ExecuteRequest) -> dict[str, Any]:
    """Execute an approved plan in a fresh, isolated browser context."""
    _require_enabled()

    if not req.approved:
        raise HTTPException(
            status_code=403,
            detail="Plan was not approved. Actions run only after explicit approval.",
        )

    if req.plan.is_empty:
        return {"results": [], "detail": "Nothing to do."}

    # Logged before execution, not after: if a step wedges the browser, the record of
    # what was authorised still exists.
    logger.info(
        "Executing approved plan (%d actions): %s",
        len(req.plan.actions),
        "; ".join(req.plan.summary()),
    )

    settings = get_settings()
    try:
        async with launch(headless=settings.automation_headless) as page:
            results = await execute_plan(page, req.plan)
    except AutomationError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e

    return {"results": [r.to_dict() for r in results]}
