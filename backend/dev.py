"""Run API + Vite dev server together (optional)."""

from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

from backend.paths import repo_root


def main() -> None:
    root = repo_root()
    env = os.environ.copy()
    api = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.main:app", "--reload", "--host", "127.0.0.1", "--port", "8000"],
        cwd=str(root),
        env=env,
    )
    web_dir = root / "web"
    if not (web_dir / "node_modules").is_dir():
        subprocess.run(["npm", "ci"], cwd=str(web_dir), check=True)
    ui = subprocess.Popen(
        ["npm", "run", "dev", "--", "--host", "127.0.0.1", "--port", "5173"],
        cwd=str(web_dir),
        env=env,
    )
    print("API: http://127.0.0.1:8000  UI: http://127.0.0.1:5173", flush=True)
    try:
        while True:
            time.sleep(1)
            if api.poll() is not None:
                break
            if ui.poll() is not None:
                break
    except KeyboardInterrupt:
        pass
    finally:
        api.terminate()
        ui.terminate()
        api.wait(timeout=5)
        ui.wait(timeout=5)


if __name__ == "__main__":
    main()
