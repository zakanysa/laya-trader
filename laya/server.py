"""Serve a Laya checkpoint to the trader on Jev's wire protocol (POST /v1/systemone).

    pip install -r laya/requirements.txt
    python laya/server.py                                      # zero-shot base: convaiinnovations/laya, typed-decisions
    LAYA_CHECKPOINT=./laya-trader python laya/server.py        # the folder the Kaggle notebook produced
    LAYA_CHECKPOINT=you/laya-trader HF_TOKEN=... python laya/server.py   # or the Hub repo it pushed

Then run the bot with MODEL=laya (LAYA_URL defaults to http://127.0.0.1:8000).

Env: LAYA_CHECKPOINT, LAYA_SUBFOLDER, LAYA_DEVICE (cuda/cpu, auto by default), LAYA_HOST
(127.0.0.1), LAYA_PORT (8000), LAYA_API_KEY (require "Authorization: Bearer <key>"), HF_TOKEN.
"""
import json
import os
import statistics
import time
from pathlib import Path
from typing import Optional

import laya
import uvicorn
from fastapi import FastAPI, Header, HTTPException

BASE = "convaiinnovations/laya"
CHECKPOINT = os.environ.get("LAYA_CHECKPOINT", BASE)
# The base bundle keeps the checkpoint the notebook starts from in a subfolder; a fine-tuned folder is its own root.
SUBFOLDER = os.environ.get("LAYA_SUBFOLDER", "typed-decisions" if CHECKPOINT == BASE else "") or None
API_KEY = os.environ.get("LAYA_API_KEY")

here = Path(__file__).parent
QUESTIONS = {"direction": json.loads((here / "question.json").read_text(encoding="utf-8"))}
SAMPLE = json.loads((here / "sample-state.json").read_text(encoding="utf-8"))

agent = laya.load(CHECKPOINT, subfolder=SUBFOLDER, device=os.environ.get("LAYA_DEVICE") or None, token=os.environ.get("HF_TOKEN"))

# Warm up, then time a realistic request: a decision has to land inside a 300 ms block.
agent.system_one(SAMPLE, QUESTIONS)
times = []
for _ in range(10):
    t0 = time.perf_counter()
    agent.system_one(SAMPLE, QUESTIONS)
    times.append((time.perf_counter() - t0) * 1000)
p50 = statistics.median(times)
print(f"laya: {CHECKPOINT}{'/' + SUBFOLDER if SUBFOLDER else ''} on {agent.device}, p50 {p50:.0f} ms per decision"
      + ("" if p50 < 200 else " (too slow for 300 ms blocks: expect late blocks; use a GPU)"), flush=True)

app = FastAPI(title="laya-trader")


@app.post("/v1/systemone")
def systemone(body: dict, authorization: Optional[str] = Header(default=None)):
    if API_KEY and authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="missing or wrong bearer token")
    if "state" not in body or "questions" not in body:
        raise HTTPException(status_code=422, detail="body needs state and questions")
    try:
        return agent.system_one(body["state"], body["questions"])
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.get("/health")
def health():
    return {"checkpoint": CHECKPOINT, "subfolder": SUBFOLDER, "device": str(agent.device), "p50Ms": round(p50, 1)}


if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("LAYA_HOST", "127.0.0.1"), port=int(os.environ.get("LAYA_PORT", "8000")), log_level="warning")
