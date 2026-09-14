import hmac
import os
import sys
import uuid
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from config_validation import validate_boot_configuration
from durable_run_store import DurableRunStore
from service import IntakeOrchestratorService, IntakeRequest

validate_boot_configuration()

INTERNAL_SERVICE_TOKEN = os.getenv("INTERNAL_SERVICE_TOKEN", "").strip()

app = FastAPI(title="SwitchOS Intake Orchestrator", version="1.0.0")
service = IntakeOrchestratorService()
execution_store = DurableRunStore("intake-orchestrator")


class IntakePayload(BaseModel):
    vertical_name: str
    pickup_required: bool = True
    dropoff_required: bool = True
    item_count: int = 1
    special_handling: bool = False
    regulated_items: bool = False
    notes: str = ""


async def require_internal_access(x_internal_service_token: str | None = Header(default=None)) -> None:
    if not INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=503, detail="internal authentication is not configured")
    if not x_internal_service_token or not hmac.compare_digest(x_internal_service_token, INTERNAL_SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail="invalid internal service token")


@app.on_event("startup")
async def startup() -> None:
    execution_store.initialize()


@app.get("/health")
def health() -> dict[str, str]:
    try:
        execution_store.check()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    return {"status": "healthy", "service": "intake-orchestrator"}


@app.post("/build-intake")
async def build_intake(
    payload: IntakePayload,
    x_internal_service_token: str | None = Header(default=None),
    x_trace_id: str | None = Header(default=None),
):
    await require_internal_access(x_internal_service_token)
    request = IntakeRequest(**payload.model_dump())
    trace_id = (x_trace_id or f"intake-{uuid.uuid4()}").strip()[:128]
    if not trace_id:
        raise HTTPException(status_code=400, detail="x-trace-id must not be blank")
    response = service.build(request)
    execution_store.record(
        "build_intake",
        trace_id,
        {
            "vertical_name": request.vertical_name,
            "item_count": request.item_count,
            "pickup_required": request.pickup_required,
            "dropoff_required": request.dropoff_required,
            "special_handling": request.special_handling,
            "regulated_items": request.regulated_items,
        },
        {
            "playbook": response["playbook"],
            "routing_mode": response["routing_mode"],
            "batching_eligible": response["batching_eligible"],
            "readiness_score": response["readiness_score"],
        },
    )
    return response


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.getenv("BIND_HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8113")))
