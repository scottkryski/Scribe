# backend/main.py
import asyncio
import json
import shutil
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv, find_dotenv
import gspread

# Import modular components
from config import (
    PDF_DIR, DATA_DIR, TEMPLATES_DIR, STATIC_DIR, SHEETS_CONFIG_FILE,
    DEFAULT_TEMPLATE_FILE, CREDS_FILE
)
from app_state import state
from ai_requests import configure_genai
from database import index_dataset_if_needed
from routers import ai, annotation, dataset, pdf, sheets, system, templates, dashboard # Import dashboard

# --- App Setup ---
app = FastAPI(title="Scribe API")
origins = ["null", "http://127.0.0.1:5500", "http://localhost:8080", "http://127.0.0.1:8000"]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

@app.middleware("http")
async def add_csp_header(request: Request, call_next):
    response: Response = await call_next(request)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' https://cdn.tailwindcss.com https://unpkg.com 'unsafe-eval' 'unsafe-inline'; "
        "style-src 'self' https://unpkg.com https://fonts.googleapis.com 'unsafe-inline'; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data:; "
        "object-src 'none';"
        "frame-src blob:;"
    )
    return response

# --- App State for startup readiness ---
app.state.ready_event = asyncio.Event()
app.state.startup_message = "Initializing..."
app.state.startup_error = None

# --- Mount static files ---
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/pdfs", StaticFiles(directory=PDF_DIR), name="pdfs")

# --- Include all the modular routers ---
app.include_router(ai.router)
app.include_router(annotation.router)
app.include_router(dataset.router)
app.include_router(pdf.router)
app.include_router(sheets.router)
app.include_router(system.router)
app.include_router(templates.router)
app.include_router(dashboard.router)


def run_startup_tasks():
    """Contains the original blocking startup logic."""
    print("LOG: --- Background Startup Tasks Running ---")
    
    try:
        app.state.startup_message = "Loading environment variables..."
        load_dotenv(dotenv_path=find_dotenv())
        
        configure_genai()
        print("LOG: GenAI configured.")

        app.state.startup_message = "Creating required directories..."
        PDF_DIR.mkdir(exist_ok=True)
        DATA_DIR.mkdir(exist_ok=True)
        TEMPLATES_DIR.mkdir(exist_ok=True)
        
        if not SHEETS_CONFIG_FILE.exists():
            with open(SHEETS_CONFIG_FILE, 'w') as f: json.dump([], f)

        if not any(TEMPLATES_DIR.iterdir()):
            shutil.copy(DEFAULT_TEMPLATE_FILE, TEMPLATES_DIR / "default.json")

        app.state.startup_message = "Authenticating with Google Services..."
        # --- FIX: Add the drive.readonly scope to access file metadata ---
        scopes = [
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive.readonly"
        ]
        state.gspread_client = gspread.service_account(filename=CREDS_FILE, scopes=scopes)
        
        app.state.startup_message = "Discovering local datasets..."
        files_to_index = list(DATA_DIR.glob("*.jsonl"))
        for i, filepath in enumerate(files_to_index):
            dataset_name = filepath.name
            app.state.startup_message = f"Indexing dataset {i+1}/{len(files_to_index)}: {dataset_name}"
            state.AVAILABLE_DATASETS[dataset_name] = filepath
            index_dataset_if_needed(filepath)
            
    except Exception as e:
        app.state.startup_error = f"FATAL ERROR during initialization: {e}"
        print(app.state.startup_error)
    finally:
        app.state.ready_event.set()
        print("LOG: --- Startup Process Finished ---")

@app.on_event("startup")
async def startup_event():
    """Launches the blocking startup tasks in a background thread."""
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, run_startup_tasks)

# --- Core Page and Status Endpoints ---

@app.get("/", response_class=HTMLResponse)
async def read_root():
    html_file_path = Path(STATIC_DIR) / "index.html"
    if not html_file_path.exists():
        raise HTTPException(status_code=500, detail="index.html not found")
    with open(html_file_path, encoding="utf-8") as f:
        return HTMLResponse(content=f.read(), status_code=200)

@app.get("/settings", response_class=HTMLResponse)
async def read_settings():
    html_file_path = Path(STATIC_DIR) / "settings.html"
    if not html_file_path.exists():
        raise HTTPException(status_code=404, detail="settings.html not found")
    with open(html_file_path, encoding="utf-8") as f:
        return HTMLResponse(content=f.read(), status_code=200)

@app.get("/guide", response_class=HTMLResponse)
async def read_guide():
    html_file_path = Path(STATIC_DIR) / "guide.html"
    if not html_file_path.exists():
        raise HTTPException(status_code=404, detail="guide.html not found")
    with open(html_file_path, encoding="utf-8") as f:
        return HTMLResponse(content=f.read(), status_code=200)
        
@app.get("/api/status")
async def get_app_status():
    """Endpoint for the frontend to poll the server's startup status."""
    if not app.state.ready_event.is_set():
        return {"status": "starting", "message": app.state.startup_message}
    if app.state.startup_error:
        return {"status": "error", "message": app.state.startup_error}
    return {"status": "ready"}