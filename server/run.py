"""Run the server: `python run.py` (reads MAP_* settings; see README.md)."""
import logging
import os

import uvicorn

from mapserver.app import create_app
from mapserver.config import Settings

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = Settings.from_env()
    cfg.check()
    uvicorn.run(create_app(cfg), host=os.environ.get("MAP_HOST", "127.0.0.1"), port=int(os.environ.get("MAP_PORT", "5000")))
