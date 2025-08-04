import json
import random
import requests
import re
import time
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form
from fastapi.responses import Response, HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, HttpUrl
from typing import Optional, List, Dict, Set, Tuple, Any
import gspread
from gspread.exceptions import APIError
from dotenv import load_dotenv, set_key, find_dotenv
import os
from collections import Counter
import sys
import subprocess
import shutil
from bs4 import BeautifulSoup

from ai_requests import get_gemini_response, get_gemini_models, configure_genai

# --- PYINSTALLER CHANGE: Helper function to find bundled files ---
def resource_path(relative_path):
    """ Get absolute path to resource, works for dev and for PyInstaller """
    try:
        # PyInstaller creates a temp folder and stores path in _MEIPASS
        base_path = sys._MEIPASS
    except Exception:
        # When not running from a PyInstaller bundle, the base path is the script's directory
        base_path = os.path.abspath(Path(__file__).parent)

    return os.path.join(base_path, relative_path)

def get_local_git_hash():
    """Gets the git hash of the local repository."""
    print("LOG: Attempting to get local git hash.")
    try:
        # We assume the script is run from the project root or backend/
        # so we check one level up for the .git directory
        project_root = Path(__file__).parent.parent
        if not (project_root / ".git").exists():
             print("LOG: No .git directory found. Not a git repository.")
             return "nogit" # Not a git repository

        # Use '--' to separate git options from paths
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            cwd=project_root, # Run the command in the project root
            check=True
        )
        git_hash = result.stdout.strip()
        print(f"LOG: Successfully found local git hash: {git_hash}")
        return git_hash
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        # Git not installed, not a git repo, or other error
        print(f"LOG: Could not get git hash. Reason: {e}")
        return "nogit"


# --- Configuration ---
LOCK_TIMEOUT_SECONDS = 7200  # 2 hours

# User-managed directories, relative to the executable's location
DATA_DIR = Path("data")
PDF_DIR = Path("pdfs")
TEMPLATES_DIR = Path("templates")
SHEETS_CONFIG_FILE = DATA_DIR / "sheets_config.json"
# Bundled resources that PyInstaller will include with the app. Disabled for now
STATIC_DIR = resource_path("static")
CREDS_FILE = resource_path("credentials.json")
DEFAULT_TEMPLATE_FILE = resource_path("templates/default.json")


# --- App Setup ---
app = FastAPI(title="Scribe API")
origins = ["null", "http://127.0.0.1:5500", "http://localhost:8080", "http://127.0.0.1:8000"]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# --- Global State & Models ---
DATASET_QUEUES: Dict[str, List[dict]] = {}
AVAILABLE_DATASETS: Dict[str, Path] = {}
ANNOTATED_ITEMS: Set[str] = set()
INCOMPLETE_ANNOTATIONS: Dict[str, dict] = {}
gspread_client: Optional[gspread.Client] = None
worksheet: Optional[gspread.Worksheet] = None

class AnnotationSubmission(BaseModel):
    doi: str
    title: str
    dataset: str
    annotator: str
    annotations: Dict[str, Any]

class PdfRequest(BaseModel):
    url: HttpUrl
    title: Optional[str] = "untitled_paper"
    author: Optional[str] = "UnknownAuthor"
    year: Optional[int] = 0

class SkipRequest(BaseModel):
    dataset: str
    doi: str

class LoadRequest(BaseModel):
    dataset: str
    prioritize_incomplete: bool = True

class ApiKeyRequest(BaseModel):
    key: str

class GeminiRequest(BaseModel):
    pdf_filename: str
    model_name: str
    template: Dict[str, Any]

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/pdfs", StaticFiles(directory=PDF_DIR), name="pdfs")

def setup_sheet_columns(ws: gspread.Worksheet):
    """Checks for and adds lock columns to the worksheet if they don't exist."""
    print("LOG: Setting up sheet columns...")
    try:
        headers = ws.row_values(1)
        if 'lock_annotator' not in headers:
            print("LOG: Column 'lock_annotator' not found. Adding it...")
            ws.update_cell(1, len(headers) + 1, 'lock_annotator')
        if 'lock_timestamp' not in headers:
            headers = ws.row_values(1)
            print("LOG: Column 'lock_timestamp' not found. Adding it...")
            ws.update_cell(1, len(headers) + 1, 'lock_timestamp')
        print("LOG: Sheet columns setup complete.")
    except APIError as e:
        print(f"LOG: Error setting up sheet columns: {e}. This might happen with an empty sheet, which is okay.")
    except Exception as e:
        print(f"An unexpected error occurred during sheet setup: {e}")

@app.get("/", response_class=HTMLResponse)
async def read_root():
    html_file_path = Path(STATIC_DIR) / "index.html"
    try:
        with open(html_file_path, encoding="utf-8") as f:
            return HTMLResponse(content=f.read(), status_code=200)
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail=f"Server configuration error: index.html not found at {html_file_path}")
    
@app.get("/settings", response_class=HTMLResponse)
async def read_settings():
    html_file_path = Path(STATIC_DIR) / "settings.html"
    try:
        with open(html_file_path, encoding="utf-8") as f:
            return HTMLResponse(content=f.read(), status_code=200)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="settings.html not found")

@app.get("/guide", response_class=HTMLResponse)
async def read_guide():
    html_file_path = Path(STATIC_DIR) / "guide.html"
    try:
        with open(html_file_path, encoding="utf-8") as f:
            return HTMLResponse(content=f.read(), status_code=200)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="guide.html not found")

@app.on_event("startup")
def startup_event():
    global gspread_client, AVAILABLE_DATASETS
    print("LOG: --- Application Startup ---")
    
    # This logic for finding/creating a .env file is acceptable for distribution,
    # as the user sets the key via the UI.
    env_path_str = find_dotenv()
    if env_path_str:
        print(f"LOG: Loading .env file from: {env_path_str}")
        load_dotenv(dotenv_path=env_path_str)
    else:
        print("LOG: No .env file found. It will be created if an API key is saved via the UI.")
    
    configure_genai()
    print("LOG: GenAI configured with environment variables.")

    print("LOG: Creating required directories...")
    PDF_DIR.mkdir(exist_ok=True)
    DATA_DIR.mkdir(exist_ok=True)
    TEMPLATES_DIR.mkdir(exist_ok=True)
    
    # Create sheets config file if it doesn't exist
    if not SHEETS_CONFIG_FILE.exists():
        print(f"LOG: Sheets configuration not found. Creating empty file at {SHEETS_CONFIG_FILE}")
        with open(SHEETS_CONFIG_FILE, 'w') as f:
            json.dump([], f)

    # The static directory is bundled, so we don't need to create it.

    # Create a default template if the directory is empty
    if not any(TEMPLATES_DIR.iterdir()):
        print("LOG: Templates directory is empty. Creating default template.")
        shutil.copy(DEFAULT_TEMPLATE_FILE, TEMPLATES_DIR / "default.json")

    try:
        print("LOG: Authenticating with Google Service Account...")
        scopes = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive.file"]

        gspread_client = gspread.service_account(filename=CREDS_FILE, scopes=scopes)
        print("LOG: Successfully authenticated with Google Service Account.")
        
        # Discover local dataset files
        print("LOG: Discovering local dataset files...")
        for filepath in DATA_DIR.glob("*.jsonl"):
            dataset_name = filepath.name
            AVAILABLE_DATASETS[dataset_name] = filepath
        print(f"LOG: Discovered {len(AVAILABLE_DATASETS)} available dataset files.")

        # Signal readiness
        if hasattr(app.state, 'ready_event'):
            app.state.ready_event.set()
        print("LOG: --- Startup Complete ---")
    except Exception as e:
        print(f"FATAL ERROR during initialization: {e}")
        print("Could not authenticate with Google. Annotation features will be limited.")
        if hasattr(app.state, 'ready_event'):
            app.state.ready_event.set()

@app.post("/save-api-key")
def save_api_key(request: ApiKeyRequest):
    print("LOG: Received request to save API key.")
    try:
        # This logic is fine. find_dotenv() will search up from the current working dir.
        # If not found, set_key will create a .env file next to the executable.
        env_path_str = find_dotenv()
        if not env_path_str:
            env_path = Path(".env")
            env_path.touch()
            env_path_str = str(env_path)
            print(f"LOG: Created a new .env file at: {env_path_str}")

        key = request.key

        set_key(env_path_str, "GEMINI_API_KEY", key)
        configure_genai() # Re-configure after saving a new key
        print(f"LOG: Successfully saved and reloaded GEMINI_API_KEY from {env_path_str}")
        return {"status": "success", "message": "API Key saved successfully."}
    except Exception as e:
        print(f"ERROR: Could not save API Key. Error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save API key: {e}")

@app.get("/check-api-key")
def check_api_key():
    print("LOG: Checking if API key is set.")
    load_dotenv(override=True)  # Force reloading the .env file
    api_key = os.getenv("GEMINI_API_KEY")
    is_set = bool(api_key and api_key.strip())
    print(f"LOG: API key is_set status: {is_set}")
    return {"is_set": is_set}

@app.get("/get-gemini-models")
def get_available_gemini_models():
    print("LOG: Requesting list of available Gemini models.")
    return get_gemini_models()

@app.get("/get-sheet-stats")
def get_sheet_stats():
    print("LOG: Requesting sheet stats.")
    if not worksheet:
        print("LOG: No worksheet connected, returning zero stats.")
        return {"completed_count": 0, "incomplete_count": 0}
    stats = {
        "completed_count": len(ANNOTATED_ITEMS),
        "incomplete_count": len(INCOMPLETE_ANNOTATIONS)
    }
    print(f"LOG: Returning sheet stats: {stats}")
    return stats

@app.get("/get-detailed-stats")
def get_detailed_stats():
    print("LOG: Requesting detailed stats from Google Sheet.")
    if not worksheet:
        raise HTTPException(status_code=400, detail="No Google Sheet is currently connected.")
    try:
        records = worksheet.get_all_records()
        total_annotations = len(records)
        if total_annotations == 0:
            print("LOG: Sheet is empty, returning zero detailed stats.")
            return {"total_annotations": 0}

        headers = worksheet.row_values(1)
        
        # Dynamically find boolean-like fields (exclude known non-data fields)
        excluded_headers = {'doi', 'title', 'dataset', 'annotator', 'lock_annotator', 'lock_timestamp'}
        boolean_fields = [
            h for h in headers 
            if h and '_context' not in h and h not in excluded_headers
        ]

        overall_counts = {field: Counter(str(r.get(field, 'N/A')).upper() for r in records) for field in boolean_fields}
        
        doc_type_counts = Counter(r.get("attribute_docType") for r in records if r.get("attribute_docType"))
        annotator_counts = Counter(r.get("annotator") for r in records if r.get("annotator"))
        dataset_counts = Counter(r.get("dataset") for r in records if r.get("dataset"))
        leaderboard = annotator_counts.most_common()

        print(f"LOG: Successfully processed detailed stats for {total_annotations} records.")
        return {
            "total_annotations": total_annotations,
            "overall_counts": {k: dict(v) for k, v in overall_counts.items()},
            "doc_type_distribution": dict(doc_type_counts),
            "annotator_stats": dict(annotator_counts),
            "dataset_stats": dict(dataset_counts),
            "leaderboard": [{"annotator": a, "count": c} for a, c in leaderboard]
        }
    except Exception as e:
        print(f"ERROR: Could not fetch or process detailed stats from Google Sheet: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get detailed stats: {e}")


@app.post("/get-gemini-suggestions")
async def get_gemini_suggestions(request: GeminiRequest):
    pdf_path = PDF_DIR / request.pdf_filename
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail=f"PDF file '{request.pdf_filename}' not found on server.")
    
    try:
        print(f"LOG: Requesting Gemini suggestions for '{request.pdf_filename}' using model '{request.model_name}'...")
        gemini_result = await get_gemini_response(
            gemini_model=request.model_name,
            pdf_filepath=pdf_path,
            template=request.template
        )
        # The response from genai is already a JSON-like object, we can access its text attribute
        response_data = json.loads(gemini_result.text)
        print("LOG: Successfully received and parsed suggestions from Gemini.")
        return response_data
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        print(f"ERROR: An unexpected error occurred while getting Gemini suggestions: {e}")
        raise HTTPException(status_code=500, detail=f"An error occurred while communicating with the AI model: {e}")


@app.post("/load-dataset")
def load_dataset(request: LoadRequest):
    dataset_name = request.dataset
    if dataset_name in DATASET_QUEUES:
        print(f"LOG: Dataset '{dataset_name}' is already in memory. Reloading to ensure consistency.")

    if dataset_name not in AVAILABLE_DATASETS:
        raise HTTPException(status_code=404, detail=f"Dataset file '{dataset_name}' not found on server.")

    filepath = AVAILABLE_DATASETS[dataset_name]
    print(f"LOG: Processing dataset: {dataset_name}. Prioritize incomplete: {request.prioritize_incomplete}")
    all_papers = []
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()

        decoder = json.JSONDecoder()
        idx = 0
        while idx < len(content):
            while idx < len(content) and content[idx].isspace():
                idx += 1
            if idx == len(content):
                break
            try:
                obj, end_idx = decoder.raw_decode(content, idx)
                all_papers.append(obj)
                idx = end_idx
            except json.JSONDecodeError as e:
                print(f"  -> JSON decoding error in {dataset_name} at char {idx}. Skipping rest of file.")
                print(f"  -> Error: {e}")
                break
        
        total_in_file = len(all_papers)
        incomplete_queue = []
        new_paper_queue = []

        for paper in all_papers:
            doi = paper.get('doi')
            if not doi:
                continue

            if doi in INCOMPLETE_ANNOTATIONS:
                incomplete_queue.append(paper)
            elif doi not in ANNOTATED_ITEMS:
                new_paper_queue.append(paper)
        
        print(f"LOG: Found {len(incomplete_queue)} incomplete papers to prioritize.")
        print(f"LOG: Found {len(new_paper_queue)} new papers to annotate.")

        random.shuffle(new_paper_queue)
        
        if request.prioritize_incomplete:
            final_queue = incomplete_queue + new_paper_queue
            print("LOG: Prioritizing incomplete annotations at the front of the queue.")
        else:
            combined_queue = incomplete_queue + new_paper_queue
            random.shuffle(combined_queue)
            final_queue = combined_queue
            print("LOG: Shuffling incomplete annotations with the rest of the queue.")

        DATASET_QUEUES[dataset_name] = final_queue
        
        queued_count = len(final_queue)
        print(f"LOG: Finished processing. Total in file: {total_in_file}, Added to Queue: {queued_count}.")
        return {"status": "success", "dataset": dataset_name, "queued_count": queued_count, "total_in_file": total_in_file}

    except Exception as e:
        print(f"ERROR: Failed to load and process dataset '{dataset_name}'. Error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to process dataset file: {e}")


@app.post("/download-pdf")
async def download_pdf_proxy(request: PdfRequest):
    print(f"LOG: Received request to download PDF from URL: {request.url}")

    # Sanitize and create filename
    author_raw = request.author or "UnknownAuthor"
    author_ascii = author_raw.encode('ascii', 'ignore').decode('ascii')
    author = re.sub(r'[^\w-]', '', author_ascii)
    year_str = str(request.year) if request.year else "UnknownYear"
    safe_title = re.sub(r'[^\w\s-]', '', request.title or "untitled").strip().lower()
    title_fragment = "_".join(safe_title.split()[:4])
    filename = f"{author}{year_str}-{title_fragment}.pdf"
    filepath = PDF_DIR / filename

    # Check if file already exists
    if filepath.exists():
        print(f"LOG: PDF already exists locally: {filepath}")
        with open(filepath, "rb") as f:
            pdf_content = f.read()
        return Response(
            content=pdf_content,
            media_type="application/pdf",
            headers={"X-Saved-Filename": filename}
        )

    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        response = requests.get(str(request.url), headers=headers, timeout=20, allow_redirects=True)
        response.raise_for_status()
        content_type = response.headers.get('Content-Type', '')

        pdf_content = None
        if 'application/pdf' in content_type:
            pdf_content = response.content
        elif 'text/html' in content_type:
            print("LOG: URL is HTML, searching for PDF links...")
            soup = BeautifulSoup(response.text, 'lxml')
            pdf_link = soup.find('a', href=re.compile(r'\.pdf$', re.I))
            if pdf_link:
                pdf_url = pdf_link['href']
                # Handle relative URLs
                if not pdf_url.startswith('http'):
                    from urllib.parse import urljoin
                    pdf_url = urljoin(str(request.url), pdf_url)
                
                print(f"LOG: Found PDF link: {pdf_url}")
                pdf_response = requests.get(pdf_url, headers=headers, timeout=20)
                pdf_response.raise_for_status()
                if 'application/pdf' in pdf_response.headers.get('Content-Type', ''):
                    pdf_content = pdf_response.content
                else:
                    raise HTTPException(status_code=415, detail=f"Found link, but it did not point to a PDF. Content-Type: {pdf_response.headers.get('Content-Type', '')}")
            else:
                raise HTTPException(status_code=415, detail="HTML page found, but no PDF link could be automatically discovered.")

        if pdf_content:
            with open(filepath, "wb") as f:
                f.write(pdf_content)
            print(f"LOG: Successfully saved PDF to: {filepath}")
            return Response(
                content=pdf_content,
                media_type="application/pdf",
                headers={"X-Saved-Filename": filename}
            )
        else:
             raise HTTPException(status_code=415, detail=f"URL did not point to a PDF. Server sent Content-Type: {content_type}")

    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=400, detail=f"Failed to download PDF from URL. Reason: {e}")
    except HTTPException as e:
        raise e # Re-raise HTTPException directly
    except Exception as e:
        # Catch-all for other unexpected errors
        print(f"ERROR: An unexpected error occurred during PDF processing: {e}")
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred during PDF processing: {e}")


@app.post("/upload-pdf")
async def upload_pdf(file: UploadFile = File(...), expected_filename: str = Form(...)):
    """Uploads a PDF file to the server's PDF directory, renaming it to the expected filename."""
    print(f"LOG: Request to upload PDF '{file.filename}' and rename to '{expected_filename}'.")
    
    # Basic validation on the expected filename
    if not expected_filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Invalid expected filename. Must end with .pdf.")

    file_path = PDF_DIR / expected_filename
    try:
        contents = await file.read()
        with open(file_path, "wb") as f:
            f.write(contents)
        
        print(f"LOG: Successfully saved uploaded PDF as: {expected_filename}")
        return {"status": "success", "filename": expected_filename, "url": f"/pdfs/{expected_filename}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error saving uploaded PDF file: {e}")


@app.get("/get-datasets")
def get_datasets():
    print("LOG: Requesting list of available datasets.")
    return sorted(list(AVAILABLE_DATASETS.keys()))

@app.get("/get-next-paper")
def get_next_paper(dataset: str, annotator: str, pdf_required: bool = True):
    print(f"\n--- LOG: GET_NEXT_PAPER triggered for dataset '{dataset}' by '{annotator}' ---")
    if not worksheet:
        print("ERROR-LOG: No Google Sheet connected.")
        raise HTTPException(status_code=400, detail="No Google Sheet is currently connected.")
    if not annotator or annotator == 'unknown':
        print("ERROR-LOG: Annotator name is not set.")
        raise HTTPException(status_code=400, detail="Annotator name must be set in Settings before getting a paper.")

    if dataset not in DATASET_QUEUES or not DATASET_QUEUES[dataset]:
        print(f"ERROR-LOG: Dataset queue for '{dataset}' is empty or not loaded.")
        raise HTTPException(status_code=404, detail=f"Dataset '{dataset}' queue is empty or not loaded.")

    try:
        print("LOG: Fetching all values from the sheet to check for locks and completed items.")
        all_sheet_values = worksheet.get_all_values()
        headers = all_sheet_values[0] if all_sheet_values else []
        print(f"LOG: Sheet has {len(all_sheet_values)} rows (including header).")

        doi_col_idx = headers.index('doi') if 'doi' in headers else -1
        lock_annotator_col_idx = headers.index('lock_annotator') if 'lock_annotator' in headers else -1
        lock_timestamp_col_idx = headers.index('lock_timestamp') if 'lock_timestamp' in headers else -1

        print("LOG: Building set of unavailable DOIs from sheet...")
        unavailable_dois = set(ANNOTATED_ITEMS)
        
        if doi_col_idx != -1:
            for row in all_sheet_values[1:]:
                if len(row) <= max(doi_col_idx, lock_annotator_col_idx, lock_timestamp_col_idx): continue
                
                doi = row[doi_col_idx]
                if not doi or doi in unavailable_dois: continue

                lock_holder = row[lock_annotator_col_idx]
                lock_time_str = row[lock_timestamp_col_idx]

                if lock_holder and lock_holder != annotator and lock_time_str:
                    try:
                        if time.time() - float(lock_time_str) < LOCK_TIMEOUT_SECONDS:
                            if doi not in unavailable_dois:
                                unavailable_dois.add(doi)
                    except (ValueError, TypeError): pass

        print(f"LOG: Total unavailable DOIs (completed or locked by others): {len(unavailable_dois)}")

        print("LOG: Searching queue for the next available and valid paper...")
        candidate_paper = None
        papers_to_check = (p for p in DATASET_QUEUES[dataset])
        checked_count = 0
        has_logged_exhaustion_message = False

        for paper_data in papers_to_check:
            checked_count += 1
            doi = paper_data.get('doi')
            is_prioritized = doi in INCOMPLETE_ANNOTATIONS

            if not is_prioritized and not has_logged_exhaustion_message:
                print("\nLOG: --- Prioritized incomplete list exhausted. Now searching through new papers. ---\n")
                has_logged_exhaustion_message = True
            
            if doi in unavailable_dois:
                continue

            if pdf_required:
                pdf_url_info = paper_data.get('open_access_pdf', {})
                pdf_url = pdf_url_info.get('url') if isinstance(pdf_url_info, dict) else pdf_url_info

                if not pdf_url or not isinstance(pdf_url, str) or not pdf_url.startswith('http'):
                    continue

                try:
                    browser_headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
                    response = requests.get(str(pdf_url), headers=browser_headers, timeout=20, allow_redirects=True, stream=True)
                    response.raise_for_status()
                    content_type = response.headers.get('Content-Type', '')
                    response.close()
                    
                    if 'application/pdf' not in content_type and 'text/html' not in content_type:
                        continue
                except requests.exceptions.RequestException:
                    continue
            
            candidate_paper = paper_data
            break

        if not candidate_paper:
            print("ERROR-LOG: No available papers with valid PDFs found in the queue after checking all items.")
            raise HTTPException(status_code=404, detail="No available papers with valid PDFs found in the queue.")

        candidate_doi = candidate_paper.get('doi')
        
        print(f"LOG: Attempting to lock paper {candidate_doi} for '{annotator}' in the sheet.")
        if doi_col_idx != -1:
            try:
                cell = worksheet.find(candidate_doi, in_column=doi_col_idx + 1)
                if cell:
                    # --- EXISTING PAPER: Update the lock on the found row ---
                    row_num = cell.row
                    worksheet.update_cell(row_num, lock_annotator_col_idx + 1, annotator)
                    worksheet.update_cell(row_num, lock_timestamp_col_idx + 1, time.time())
                    print(f"LOG: Lock acquired for DOI {candidate_doi} by {annotator} in row {row_num}.")
                    candidate_paper['lock_info'] = {"locked": True, "remaining_seconds": LOCK_TIMEOUT_SECONDS}
                else:
                    # --- NEW PAPER: Append a new row with lock info ---
                    print(f"LOG: DOI {candidate_doi} not found in sheet. Creating new row to apply lock.")
                    
                    new_row_data = {h: "" for h in headers}
                    new_row_data['doi'] = candidate_doi
                    new_row_data['title'] = candidate_paper.get('title', 'No Title Provided') 
                    new_row_data['dataset'] = dataset 
                    new_row_data['lock_annotator'] = annotator
                    new_row_data['lock_timestamp'] = time.time()

                    row_values = [new_row_data.get(h, "") for h in headers]
                    
                    worksheet.append_row(row_values, value_input_option='USER_ENTERED')
                    
                    print(f"LOG: Appended new row and acquired lock for DOI {candidate_doi} by {annotator}.")
                    candidate_paper['lock_info'] = {"locked": True, "remaining_seconds": LOCK_TIMEOUT_SECONDS}

            except Exception as e:
                print(f"WARN-LOG: Could not lock paper {candidate_doi}. Reason: {e}")

        if candidate_doi in INCOMPLETE_ANNOTATIONS:
            print(f"LOG: Found existing incomplete annotation data for DOI {candidate_doi}.")
            candidate_paper['existing_annotation'] = INCOMPLETE_ANNOTATIONS[candidate_doi]['data']
        
        print(f"--- LOG: GET_NEXT_PAPER finished successfully. Returning DOI {candidate_doi}. ---\n")
        return candidate_paper

    except (ValueError, APIError) as e:
        print(f"ERROR-LOG: A spreadsheet error occurred in get_next_paper: {e}")
        raise HTTPException(status_code=500, detail=f"A spreadsheet error occurred: {e}")

def clear_lock(doi: str):
    print(f"LOG: Attempting to clear lock for DOI: {doi}")
    if not worksheet:
        print(f"WARN-LOG: Cannot clear lock for DOI {doi}, no sheet connected.")
        return
    try:
        headers = worksheet.row_values(1)
        if 'doi' not in headers: 
            print("WARN-LOG: Cannot clear lock, 'doi' column not in sheet.")
            return

        cell = worksheet.find(doi, in_column=headers.index('doi') + 1)
        if not cell:
            print(f"WARN-LOG: Could not find DOI {doi} in sheet to clear lock.")
            return

        lock_annotator_col = headers.index('lock_annotator') + 1
        lock_timestamp_col = headers.index('lock_timestamp') + 1
        
        worksheet.update_cell(cell.row, lock_annotator_col, "")
        worksheet.update_cell(cell.row, lock_timestamp_col, "")
        print(f"LOG: Cleared lock for DOI {doi} in sheet row {cell.row}.")
    except Exception as e:
        print(f"ERROR: Error clearing lock for DOI {doi}: {e}")

@app.get("/get-lock-status/{doi:path}")
def get_lock_status(doi: str):
    print(f"LOG: Checking lock status for DOI: {doi}")
    if not worksheet:
        return {"locked": False, "remaining_seconds": 0}
    try:
        headers = worksheet.row_values(1)
        if 'doi' not in headers or 'lock_timestamp' not in headers:
            return {"locked": False, "remaining_seconds": 0}

        doi_col_index = headers.index('doi') + 1
        lock_ts_col_index = headers.index('lock_timestamp') + 1
        
        cell = worksheet.find(doi, in_column=doi_col_index)
        if not cell:
            return {"locked": False, "remaining_seconds": 0}
            
        lock_timestamp_str = worksheet.cell(cell.row, lock_ts_col_index).value
        if not lock_timestamp_str:
            return {"locked": False, "remaining_seconds": 0}

        lock_time = float(lock_timestamp_str)
        elapsed_time = time.time() - lock_time
        
        if elapsed_time < LOCK_TIMEOUT_SECONDS:
            remaining = int(LOCK_TIMEOUT_SECONDS - elapsed_time)
            print(f"LOG: DOI {doi} is locked with {remaining} seconds remaining.")
            return {
                "locked": True,
                "remaining_seconds": remaining
            }
        else:
            print(f"LOG: DOI {doi} lock has expired.")
            return {"locked": False, "remaining_seconds": 0}

    except (APIError, ValueError, IndexError) as e:
        print(f"LOG: Could not retrieve lock status for {doi}: {e}")
        return {"locked": False, "remaining_seconds": 0}

@app.post("/skip-paper")
def skip_paper(request: SkipRequest):
    print(f"LOG: Received request to skip paper with DOI: {request.doi}")
    if not worksheet:
        raise HTTPException(status_code=400, detail="No Google Sheet is currently connected.")
    clear_lock(request.doi)
    
    dataset_name = request.dataset
    if dataset_name in DATASET_QUEUES and DATASET_QUEUES[dataset_name]:
        queue = DATASET_QUEUES[dataset_name]
        paper_to_move = None
        for i, paper in enumerate(queue):
            if paper.get('doi') == request.doi:
                paper_to_move = queue.pop(i)
                break
        if paper_to_move:
            queue.append(paper_to_move)
            print(f"LOG: Moved paper {request.doi} to the end of the '{dataset_name}' queue.")

    return {"status": "success", "skipped_doi": request.doi}

@app.post("/submit-annotation")
def submit_annotation(submission: AnnotationSubmission):
    print(f"LOG: Received annotation submission for DOI: {submission.doi} by annotator: {submission.annotator}")
    if not worksheet:
        raise HTTPException(status_code=400, detail="No Google Sheet is currently connected.")
        
    submitted_doi = submission.doi
    try:
        headers = worksheet.row_values(1)
        if 'doi' not in headers: # Sheet is likely empty or unformatted
             raise HTTPException(status_code=500, detail="The sheet does not have a 'doi' column. Cannot save.")

        # Flatten the submission data
        flat_submission = {
            "doi": submission.doi,
            "title": submission.title,
            "dataset": submission.dataset,
            "annotator": submission.annotator,
            **submission.annotations
        }

        # Find the row for the DOI, if it exists
        cell = None
        try:
            doi_col_index = headers.index('doi') + 1
            cell = worksheet.find(submitted_doi, in_column=doi_col_index)
        except (ValueError, APIError):
            # This can happen if the sheet is empty or the 'doi' column is missing.
            # We proceed assuming it's a new entry.
            cell = None

        if cell:
            # --- Existing Paper: Update the row ---
            row_to_update = cell.row
            print(f"LOG: Found existing entry for DOI {submitted_doi} in row {row_to_update}. Updating...")
            # This logic assumes lock columns are at the end, which is how setup_sheet_columns creates them.
            row_values = [flat_submission.get(h, "") for h in headers if 'lock_' not in h]
            worksheet.update(f'A{row_to_update}', [row_values], value_input_option='USER_ENTERED')
            print(f"LOG: Successfully updated annotation for existing DOI {submitted_doi}.")
        else:
            # --- New Paper: Append a new row ---
            print(f"LOG: DOI {submitted_doi} not found in sheet. Appending as a new row...")
            # This correctly handles papers that are not yet in the sheet.
            row_values = [flat_submission.get(h, "") for h in headers]
            worksheet.append_row(row_values, value_input_option='USER_ENTERED')
            print(f"LOG: Successfully appended new annotation for DOI {submitted_doi}.")

        
        clear_lock(submitted_doi)

        # Update local state
        dataset_name = submission.dataset
        if dataset_name in DATASET_QUEUES and DATASET_QUEUES[dataset_name]:
            DATASET_QUEUES[dataset_name] = [p for p in DATASET_QUEUES[dataset_name] if p.get('doi') != submitted_doi]
            print(f"LOG: Removed DOI {submitted_doi} from in-memory queue '{dataset_name}'.")
        
        ANNOTATED_ITEMS.add(submitted_doi)
        if submitted_doi in INCOMPLETE_ANNOTATIONS:
            del INCOMPLETE_ANNOTATIONS[submitted_doi]
            print(f"LOG: Removed DOI {submitted_doi} from incomplete list.")

        print(f"LOG: Successfully wrote annotation and cleared lock for DOI {submitted_doi}.")
        return {"status": "success", "doi": submitted_doi}
        
    except Exception as e:
        print(f"ERROR: Failed to write to Google Sheet for DOI {submitted_doi}. Lock was NOT cleared. Error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to write to Google Sheet: {e}")
    
@app.post("/open-data-folder")
def open_data_folder():
    """Opens the data folder in the system's file explorer."""
    data_path = DATA_DIR
    print(f"LOG: Request to open data folder at {data_path}")
    os.makedirs(data_path, exist_ok=True)
    try:
        if sys.platform == "win32":
            os.startfile(data_path)
        elif sys.platform == "darwin": # macOS
            subprocess.run(["open", data_path])
        else: # linux
            subprocess.run(["xdg-open", data_path])
        return {"status": "success", "path": str(data_path)}
    except Exception as e:
        print(f"ERROR: Failed to open data folder: {e}")
        return {"status": "error", "message": str(e)}

# Google Sheets Management API

def _read_sheets_config():
    if not SHEETS_CONFIG_FILE.exists():
        return []
    with open(SHEETS_CONFIG_FILE, 'r') as f:
        return json.load(f)

def _write_sheets_config(config):
    with open(SHEETS_CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=2)

class SheetConfigRequest(BaseModel):
    name: str
    id: str

class SheetUrlRequest(BaseModel):
    name: str
    url: str

@app.get("/api/sheets")
def get_sheets():
    """Lists all configured Google Sheets."""
    print("LOG: Request to get all configured sheets.")
    return _read_sheets_config()

@app.post("/api/sheets")
def add_or_update_sheet(request: SheetUrlRequest):
    """Adds a new sheet or updates an existing one by name, parsing the ID from the URL."""
    print(f"LOG: Request to add or update sheet '{request.name}' with URL: {request.url}")
    # Regex to extract the sheet ID from a Google Sheet URL
    # Example URL: https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0
    match = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", request.url)
    if not match:
        raise HTTPException(status_code=400, detail="Invalid Google Sheet URL. Could not find a valid Sheet ID.")
    
    sheet_id = match.group(1)
    print(f"LOG: Extracted Sheet ID: {sheet_id}")

    # Now create the config object that we will save
    sheet_config = SheetConfigRequest(name=request.name, id=sheet_id)
    
    config = _read_sheets_config()
    # Check if a sheet with the same name exists and update it
    for i, sheet in enumerate(config):
        if sheet['name'] == sheet_config.name:
            config[i] = sheet_config.dict()
            _write_sheets_config(config)
            print(f"LOG: Updated existing sheet '{sheet_config.name}'.")
            return {"status": "success", "message": f"Sheet '{sheet_config.name}' updated."}
    # If not found, add as a new sheet
    config.append(sheet_config.dict())
    _write_sheets_config(config)
    print(f"LOG: Added new sheet '{sheet_config.name}'.")
    return {"status": "success", "message": f"Sheet '{sheet_config.name}' added."}

@app.delete("/api/sheets/{sheet_id}")
def delete_sheet(sheet_id: str):
    """Deletes a sheet configuration by its ID."""
    print(f"LOG: Request to delete sheet with ID: {sheet_id}")
    config = _read_sheets_config()
    new_config = [sheet for sheet in config if sheet.get('id') != sheet_id]
    if len(new_config) == len(config):
        raise HTTPException(status_code=404, detail="Sheet ID not found in configuration.")
    _write_sheets_config(new_config)
    print(f"LOG: Successfully deleted sheet config for ID {sheet_id}.")
    return {"status": "success", "message": "Sheet configuration deleted."}

class ConnectSheetRequest(BaseModel):
    sheet_id: str

@app.post("/connect-to-sheet")
def connect_to_sheet(request: ConnectSheetRequest):
    """Connects to a specific Google Sheet and loads its metadata."""
    global worksheet, ANNOTATED_ITEMS, INCOMPLETE_ANNOTATIONS
    print(f"LOG: Request to connect to sheet with ID: {request.sheet_id}")
    if not gspread_client:
        raise HTTPException(status_code=500, detail="gspread client not initialized.")

    try:
        sh = gspread_client.open_by_key(request.sheet_id)
        worksheet = sh.sheet1
        print(f"LOG: Successfully connected to Google Sheet by ID: {request.sheet_id}")

        # Reset state for the new sheet
        print("LOG: Resetting local annotation state (completed, incomplete).")
        ANNOTATED_ITEMS.clear()
        INCOMPLETE_ANNOTATIONS.clear()

        setup_sheet_columns(worksheet)
        print("LOG: Fetching all records from sheet to build initial state...")
        all_records = worksheet.get_all_records()

        if not all_records:
            print("LOG: Google Sheet is empty. No previous annotations found.")
        else:
            print(f"LOG: Processing {len(all_records)} records from the sheet.")
            headers = all_records[0].keys()
            required_headers = [h for h in headers if h and '_context' not in h.lower() and 'lock_' not in h.lower()]
            for i, rec in enumerate(all_records, start=2):
                doi = rec.get('doi', '').strip()
                if not doi:
                    # print(f"DEBUG-LOG: Skipping row {i} due to empty DOI.")
                    continue
                is_complete = all(str(rec.get(header, '')).strip() != '' for header in required_headers)
                if is_complete:
                    ANNOTATED_ITEMS.add(doi)
                else:
                    INCOMPLETE_ANNOTATIONS[doi] = {'data': rec, 'row_num': i}

        completed = len(ANNOTATED_ITEMS)
        incomplete = len(INCOMPLETE_ANNOTATIONS)
        print(f"LOG: Loaded sheet data: {completed} completed, {incomplete} incomplete.")

        return {
            "status": "success",
            "message": "Connected successfully.",
            "completed_count": completed,
            "incomplete_count": incomplete
        }
    except APIError as e:
        print(f"ERROR: API Error connecting to sheet: {e.response.json()}")
        raise HTTPException(status_code=400, detail=f"Could not connect to Sheet. Check ID and permissions. Error: {e.response.json().get('error', {}).get('message')}")
    except Exception as e:
        print(f"ERROR: An unexpected error occurred while connecting to sheet: {e}")
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {e}")


# --- Template Management API ---

@app.get("/api/templates")
def get_templates():
    """Lists all available .json template files by scanning the directory."""
    print("LOG: Request to get all templates.")
    if not TEMPLATES_DIR.exists():
        return []
    return sorted([f.name for f in TEMPLATES_DIR.glob("*.json")])

@app.get("/api/templates/{template_name}")
def get_template(template_name: str):
    """Gets the content of a specific template file."""
    print(f"LOG: Request to get template '{template_name}'.")
    if not re.match(r"^[a-zA-Z0-9_-]+\.json$", template_name):
        raise HTTPException(status_code=400, detail="Invalid template name.")
    
    file_path = TEMPLATES_DIR / template_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Template not found.")
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error reading template file: {e}")

@app.post("/api/templates/{template_name}")
async def save_template(template_name: str, request: Request):
    """Saves a template file."""
    print(f"LOG: Request to save template '{template_name}'.")
    if not re.match(r"^[a-zA-Z0-9_-]+\.json$", template_name):
        raise HTTPException(status_code=400, detail="Invalid template name.")

    file_path = TEMPLATES_DIR / template_name
    try:
        data = await request.json()
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4)
        print(f"LOG: Successfully saved template '{template_name}'.")
        return {"status": "success", "filename": template_name}
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON data.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error saving template file: {e}")

@app.delete("/api/templates/{template_name}")
def delete_template(template_name: str):
    """Deletes a template file."""
    print(f"LOG: Request to delete template '{template_name}'.")
    if not re.match(r"^[a-zA-Z0-9_-]+\.json$", template_name):
        raise HTTPException(status_code=400, detail="Invalid template name.")

    file_path = TEMPLATES_DIR / template_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Template not found.")
    
    try:
        os.remove(file_path)
        print(f"LOG: Successfully deleted template '{template_name}'.")
        return {"status": "success", "filename": template_name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error deleting template file: {e}")
    
@app.post("/open-templates-folder")
def open_templates_folder():
    """Opens the templates folder in the system's file explorer."""
    templates_path = TEMPLATES_DIR
    print(f"LOG: Request to open templates folder at {templates_path}")
    os.makedirs(templates_path, exist_ok=True)
    try:
        if sys.platform == "win32":
            os.startfile(templates_path)
        elif sys.platform == "darwin": # macOS
            subprocess.run(["open", templates_path])
        else: # linux
            subprocess.run(["xdg-open", templates_path])
        return {"status": "success", "path": str(templates_path)}
    except Exception as e:
        print(f"ERROR: Failed to open templates folder: {e}")
        return {"status": "error", "message": str(e)}

@app.post("/upload-template")
async def upload_template(file: UploadFile = File(...)):
    """Uploads a .json template file."""
    print(f"LOG: Request to upload template file '{file.filename}'.")
    if not file.filename.endswith(".json"):
        raise HTTPException(status_code=400, detail="Invalid file type. Please upload a .json file.")

    file_path = TEMPLATES_DIR / file.filename
    try:
        contents = await file.read()
        # Validate that it's valid JSON
        json.loads(contents)
        
        with open(file_path, "wb") as f:
            f.write(contents)
        
        print(f"LOG: Successfully uploaded template: {file.filename}")
        return {"status": "success", "filename": file.filename}
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON format in the uploaded file.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error saving uploaded file: {e}")
    
@app.get("/check-for-updates")
def check_for_updates():
    """Compares local git hash with the remote GitHub main branch hash."""
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
    
@app.post("/update-and-restart")
def update_and_restart():
    """
    Launches the external update script and then gracefully shuts down the server.
    """
    print("INFO: Update and restart triggered.")
    project_root = Path(__file__).parent.parent

    try:
        if sys.platform == "win32":
            # On Windows, use DETACHED_PROCESS to run the .bat file in a new console
            # that is independent of this server's process.
            update_script_path = project_root / "update.bat"
            if not update_script_path.exists():
                raise HTTPException(status_code=404, detail="update.bat not found.")
            
            subprocess.Popen(
                [str(update_script_path)],
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
                shell=True # shell=True is often needed for .bat files
            )
        else: # macOS and Linux
            update_script_path = project_root / "update.sh"
            if not update_script_path.exists():
                raise HTTPException(status_code=404, detail="update.sh not found.")
            
            # Make sure the script is executable
            os.chmod(update_script_path, 0o755)
            
            # On Unix-like systems, os.setpgrp is the key. It detaches the new process
            # from this one, so it won't be killed when the server stops.
            subprocess.Popen([str(update_script_path)], preexec_fn=os.setpgrp)

        # We can't easily shut down uvicorn from within. The best we can do is exit.
        # The update script's `sleep` will handle the race condition.
        # This is a bit abrupt but necessary for the self-update.
        print("INFO: Launched update script. Server is now exiting.")
        sys.exit(0) # Forcibly exits the Python process

    except Exception as e:
        print(f"ERROR: Failed to launch update script: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to launch update script: {e}")