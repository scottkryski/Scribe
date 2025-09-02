# backend/utils.py
import subprocess
from pathlib import Path
import os
import sys

def get_local_git_hash():
    """Gets the git hash of the local repository."""
    print("LOG: Attempting to get local git hash.")
    try:
        project_root = Path(__file__).parent.parent
        if not (project_root / ".git").exists():
             print("LOG: No .git directory found. Not a git repository.")
             return "nogit"

        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            cwd=project_root,
            check=True
        )
        git_hash = result.stdout.strip()
        print(f"LOG: Successfully found local git hash: {git_hash}")
        return git_hash
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        print(f"LOG: Could not get git hash. Reason: {e}")
        return "nogit"

def open_folder(path: Path):
    """Opens a folder in the system's file explorer."""
    print(f"LOG: Request to open folder at {path}")
    os.makedirs(path, exist_ok=True)
    try:
        if sys.platform == "win32":
            os.startfile(path)
        elif sys.platform == "darwin": # macOS
            subprocess.run(["open", path])
        else: # linux
            subprocess.run(["xdg-open", path])
        return {"status": "success", "path": str(path)}
    except Exception as e:
        print(f"ERROR: Failed to open folder: {e}")
        return {"status": "error", "message": str(e)}