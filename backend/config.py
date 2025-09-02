# backend/config.py
import os
import sys
from pathlib import Path

def resource_path(relative_path):
    """ Get absolute path to resource, works for dev and for PyInstaller """
    try:
        # PyInstaller creates a temp folder and stores path in _MEIPASS
        base_path = sys._MEIPASS
    except Exception:
        # When not running from a PyInstaller bundle, the base path is the script's directory
        base_path = os.path.abspath(Path(__file__).parent)
    return os.path.join(base_path, relative_path)

# --- Configuration ---
LOCK_TIMEOUT_SECONDS = 7200  # 2 hours

# --- NEW: Define script's parent directory for robust pathing ---
_SCRIPT_DIR = Path(__file__).resolve().parent

# User-managed directories, created relative to where the app is run
DATA_DIR = Path("data")
PDF_DIR = Path("pdfs")
TEMPLATES_DIR = Path("templates") # This is the user-facing directory
SHEETS_CONFIG_FILE = DATA_DIR / "sheets_config.json"

# Bundled resources that PyInstaller will include with the app.
STATIC_DIR = resource_path("static")
CREDS_FILE = resource_path("credentials.json")

# The SOURCE for the default template file.
DEFAULT_TEMPLATE_FILE = _SCRIPT_DIR.parent / "templates" / "default.json"