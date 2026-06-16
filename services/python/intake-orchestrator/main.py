from fastapi import FastAPI
from pydantic import BaseModel
import os

from service import IntakeOrchestratorService, IntakeRequest

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


@app.get("/health")
def health():
    return {"status": "ok", "service": "intake-orchestrator"}


@app.post("/build-intake")
def build_intake(payload: IntakePayload):
    request = IntakeRequest(**payload.model_dump())
    return service.build(request)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8113")))
