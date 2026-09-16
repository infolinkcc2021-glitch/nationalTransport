import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(BASE, "backend.log")
os.chdir(BASE)
try:
    log = open(LOG, "a", encoding="utf-8")
    sys.stdout = log
    sys.stderr = log
except Exception:
    pass

import uvicorn

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, log_level="info")