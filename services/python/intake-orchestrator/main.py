import os

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from service import IntakeOrchestratorService, IntakeRequest

INTERNAL_SERVICE_TOKEN = os.getenv("INTERNAL_SERVICE_TOKEN", "switchos-internal-dev-token-change-before-production")

app = FastAPI(title="SwitchOS Intake Orchestrator", version="1.0.0")
service = IntakeOrchestratorService()


class IntakePayload(BaseModel):
    vertical_name: str
    pickup_required: bool = True
    dropoff_required: bool = True
    item_count: int = 1
    special_handling: bool = False
    regulated_items: bool = False
    notes: str = ""


async def require_internal_access(x_internal_service_token: str | None = Header(default=None)) -> None:
    if x_internal_service_token != INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="invalid internal service token")


@app.get("/health")
def health():
    return {"status": "ok", "service": "intake-orchestrator"}


@app.post("/build-intake")
async def build_intake(payload: IntakePayload, x_internal_service_token: str | None = Header(default=None)):
    await require_internal_access(x_internal_service_token)
    request = IntakeRequest(**payload.model_dump())
    return service.build(request)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.getenv("BIND_HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8113")))
