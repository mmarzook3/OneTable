"""Staff + LAN print-agent API for hardware printing (#317)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.security.utils import get_authorization_scheme_param
from sqlmodel import Session

from . import models
from . import print_service as print_svc
from .db import get_session
from .permissions import Permission, require_permission
from .rate_limits import admin_user_limit

staff_router = APIRouter(tags=["Print jobs"])
agent_router = APIRouter(prefix="/print-agent", tags=["Print agent"])


def _agent_from_auth(
    session: Session,
    authorization: str | None,
    x_print_agent_token: str | None,
) -> models.PrintAgent:
    raw = (x_print_agent_token or "").strip()
    if not raw and authorization:
        scheme, param = get_authorization_scheme_param(authorization)
        if scheme.lower() == "bearer" and param:
            raw = param.strip()
    return print_svc.get_agent_by_token(session, raw)


@staff_router.post("/print-jobs")
@admin_user_limit()
def create_print_job(
    request: Request,
    response: Response,
    body: models.PrintJobCreate,
    current_user: Annotated[models.User, Depends(require_permission(Permission.ORDER_READ))],
    session: Session = Depends(get_session),
):
    """Enqueue a kitchen or receipt job for the LAN print agent."""
    if current_user.tenant_id is None:
        raise HTTPException(status_code=403, detail="Tenant required")
    job = print_svc.create_job(
        session,
        tenant_id=current_user.tenant_id,
        user_id=current_user.id,
        job_type=body.job_type,
        order_id=body.order_id,
        printer_role=body.printer_role,
        payload=body.payload,
    )
    status = print_svc.tenant_bridge_status(session, current_user.tenant_id)
    return {
        "job": print_svc.job_to_dict(job),
        "bridge": status,
    }


@staff_router.get("/print-jobs/status")
@admin_user_limit()
def print_bridge_status(
    request: Request,
    response: Response,
    current_user: Annotated[models.User, Depends(require_permission(Permission.ORDER_READ))],
    session: Session = Depends(get_session),
):
    if current_user.tenant_id is None:
        raise HTTPException(status_code=403, detail="Tenant required")
    return print_svc.tenant_bridge_status(session, current_user.tenant_id)


@staff_router.get("/print-jobs")
@admin_user_limit()
def list_print_jobs(
    request: Request,
    response: Response,
    current_user: Annotated[models.User, Depends(require_permission(Permission.ORDER_READ))],
    session: Session = Depends(get_session),
    limit: int = Query(50, ge=1, le=200),
    status: str | None = Query(None),
):
    if current_user.tenant_id is None:
        raise HTTPException(status_code=403, detail="Tenant required")
    jobs = print_svc.list_jobs(
        session, current_user.tenant_id, limit=limit, status=status
    )
    return [print_svc.job_to_dict(j) for j in jobs]


@staff_router.get("/tenant/print-agents")
@admin_user_limit()
def list_print_agents(
    request: Request,
    response: Response,
    current_user: Annotated[
        models.User, Depends(require_permission(Permission.SETTINGS_UPDATE))
    ],
    session: Session = Depends(get_session),
):
    if current_user.tenant_id is None:
        raise HTTPException(status_code=403, detail="Tenant required")
    agents = print_svc.list_agents(session, current_user.tenant_id)
    return [print_svc.agent_to_dict(a) for a in agents]


@staff_router.post("/tenant/print-agents")
@admin_user_limit()
def create_print_agent(
    request: Request,
    response: Response,
    body: models.PrintAgentCreate,
    current_user: Annotated[
        models.User, Depends(require_permission(Permission.SETTINGS_UPDATE))
    ],
    session: Session = Depends(get_session),
):
    if current_user.tenant_id is None:
        raise HTTPException(status_code=403, detail="Tenant required")
    agent, raw_token = print_svc.create_agent(
        session,
        tenant_id=current_user.tenant_id,
        device_id=body.device_id,
        display_name=body.display_name,
    )
    data = print_svc.agent_to_dict(agent)
    data["token"] = raw_token  # shown once
    return data


@staff_router.delete("/tenant/print-agents/{agent_id}")
@admin_user_limit()
def revoke_print_agent(
    request: Request,
    response: Response,
    agent_id: int,
    current_user: Annotated[
        models.User, Depends(require_permission(Permission.SETTINGS_UPDATE))
    ],
    session: Session = Depends(get_session),
):
    if current_user.tenant_id is None:
        raise HTTPException(status_code=403, detail="Tenant required")
    agent = print_svc.revoke_agent(session, current_user.tenant_id, agent_id)
    return print_svc.agent_to_dict(agent)


@agent_router.post("/heartbeat")
def agent_heartbeat(
    session: Session = Depends(get_session),
    authorization: Annotated[str | None, Header()] = None,
    x_print_agent_token: Annotated[str | None, Header()] = None,
):
    agent = _agent_from_auth(session, authorization, x_print_agent_token)
    agent = print_svc.touch_agent(session, agent)
    return print_svc.agent_to_dict(agent)


@agent_router.get("/jobs")
def agent_poll_jobs(
    session: Session = Depends(get_session),
    authorization: Annotated[str | None, Header()] = None,
    x_print_agent_token: Annotated[str | None, Header()] = None,
    limit: int = Query(10, ge=1, le=50),
):
    """Claim pending jobs for this agent (poll)."""
    agent = _agent_from_auth(session, authorization, x_print_agent_token)
    jobs = print_svc.claim_pending_jobs(session, agent, limit=limit)
    return [print_svc.job_to_dict(j) for j in jobs]


@agent_router.get("/jobs/claimed")
def agent_claimed_jobs(
    session: Session = Depends(get_session),
    authorization: Annotated[str | None, Header()] = None,
    x_print_agent_token: Annotated[str | None, Header()] = None,
    limit: int = Query(50, ge=1, le=50),
):
    """Read this agent's unsettled claims without requeueing or reassigning."""
    agent = _agent_from_auth(session, authorization, x_print_agent_token)
    jobs = print_svc.list_claimed_jobs(session, agent, limit=limit)
    return [print_svc.job_to_dict(j) for j in jobs]


@agent_router.post("/jobs/{job_id}/complete")
def agent_complete_job(
    job_id: int,
    body: models.PrintJobComplete,
    session: Session = Depends(get_session),
    authorization: Annotated[str | None, Header()] = None,
    x_print_agent_token: Annotated[str | None, Header()] = None,
):
    agent = _agent_from_auth(session, authorization, x_print_agent_token)
    job = print_svc.complete_job(
        session,
        agent,
        job_id,
        status=body.status,
        error_message=body.error_message,
    )
    return print_svc.job_to_dict(job)
