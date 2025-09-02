# backend/routers/system.py
import os
import sys
import subprocess
from pathlib import Path

import requests
from fastapi import APIRouter, HTTPException
from dotenv import set_key, find_dotenv, load_dotenv

from models import ApiKeyRequest
from ai_requests import configure_genai
from utils import get_local_git_hash, open_folder
from config import DATA_DIR

# Create a router to hold all system-related endpoints
router = APIRouter()


@router.post("/save-api-key")
def save_api_key(request: ApiKeyRequest):
    """Saves the Gemini API key to the .env file."""
    print("LOG: Received request to save API key.")
    try:
        # find_dotenv will search for an existing .env file.
        # If not found, set_key will create a new one in the current directory.
        env_path_str = find_dotenv()
        if not env_path_str:
            env_path = Path(".env")
            env_path.touch()
            env_path_str = str(env_path)
            print(f"LOG: Created a new .env file at: {env_path_str}")

        set_key(env_path_str, "GEMINI_API_KEY", request.key)
        configure_genai()  # Re-apply the configuration with the new key
        print(f"LOG: Successfully saved and reloaded GEMINI_API_KEY from {env_path_str}")
        return {"status": "success", "message": "API Key saved successfully."}
    except Exception as e:
        print(f"ERROR: Could not save API Key. Error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save API key: {e}")


@router.get("/check-api-key")
def check_api_key():
    """Checks if a Gemini API key is currently set in the environment."""
    print("LOG: Checking if API key is set.")
    load_dotenv(override=True)  # Force reload from the .env file
    api_key = os.getenv("GEMINI_API_KEY")
    is_set = bool(api_key and api_key.strip())
    print(f"LOG: API key is_set status: {is_set}")
    return {"is_set": is_set}


@router.post("/open-data-folder")
def open_data_folder_endpoint():
    """Triggers the OS file explorer to open the 'data' directory."""
    return open_folder(DATA_DIR)


@router.get("/check-for-updates")
def check_for_updates():
    """Compares the local git hash with the remote main branch hash."""
    print("LOG: Checking for updates...")
    local_hash = get_local_git_hash()
    if local_hash == "nogit":
        print("LOG: Not a Git repository, cannot check for updates.")
        return {"update_available": False, "message": "Not a Git repository."}

    try:
        repo_url = "https://api.github.com/repos/scottkryski/Scribe/branches/main"
        response = requests.get(repo_url, timeout=5)
        response.raise_for_status()
        
        remote_data = response.json()
        remote_hash = remote_data.get("commit", {}).get("sha")

        if not remote_hash:
            raise HTTPException(status_code=500, detail="Could not parse remote commit hash.")

        print(f"LOG: Local hash: {local_hash}, Remote hash: {remote_hash}")
        if local_hash != remote_hash:
            print("LOG: Update available.")
            return {"update_available": True, "message": "A new version is available!"}
        else:
            print("LOG: Application is up to date.")
            return {"update_available": False, "message": "You are on the latest version."}
            
    except requests.RequestException as e:
        print(f"ERROR: Could not connect to GitHub to check for updates: {e}")
        raise HTTPException(status_code=503, detail=f"Could not connect to GitHub to check for updates: {e}")


@router.post("/update-and-restart")
def update_and_restart():
    """Launches the external update script and gracefully shuts down the server."""
    print("INFO: Update and restart triggered.")
    project_root = Path(__file__).parent.parent.parent  # Navigates from /backend/routers -> /backend -> /

    try:
        if sys.platform == "win32":
            update_script_path = project_root / "update.bat"
            if not update_script_path.exists():
                raise HTTPException(status_code=404, detail="update.bat not found.")
            
            subprocess.Popen(
                [str(update_script_path)],
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
                shell=True
            )
        else:  # macOS and Linux
            update_script_path = project_root / "update.sh"
            if not update_script_path.exists():
                raise HTTPException(status_code=404, detail="update.sh not found.")
            
            os.chmod(update_script_path, 0o755)
            subprocess.Popen([str(update_script_path)], preexec_fn=os.setpgrp)

        print("INFO: Launched update script. Server is now exiting.")
        sys.exit(0)  # Forcibly exits the Python process to allow the update script to run

    except Exception as e:
        print(f"ERROR: Failed to launch update script: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to launch update script: {e}")