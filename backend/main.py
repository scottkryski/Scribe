import json
import random
import requests
import re
import time
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, UploadFile, File
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
    try:
        # We assume the script is run from the project root or backend/
        # so we check one level up for the .git directory
        project_root = Path(__file__).parent.parent
        if not (project_root / ".git").exists():
             return "nogit" # Not a git repository

        # Use '--' to separate git options from paths
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            cwd=project_root, # Run the command in the project root
            check=True
        )
        return result.stdout.strip()
    except (FileNotFoundError, subprocess.CalledProcessError):
        # Git not installed, not a git repo, or other error
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

def setup_sheet_columns(ws: gspread.Worksheet):
    """Checks for and adds lock columns to the worksheet if they don't exist."""
    try:
        headers = ws.row_values(1)
        if 'lock_annotator' not in headers:
            print("Column 'lock_annotator' not found. Adding it...")
            ws.update_cell(1, len(headers) + 1, 'lock_annotator')
        if 'lock_timestamp' not in headers:
            headers = ws.row_values(1)
            print("Column 'lock_timestamp' not found. Adding it...")
            ws.update_cell(1, len(headers) + 1, 'lock_timestamp')
    except APIError as e:
        print(f"Error setting up sheet columns: {e}. This might happen with an empty sheet, which is okay.")
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
    
    # This logic for finding/creating a .env file is acceptable for distribution,
    # as the user sets the key via the UI.
    env_path_str = find_dotenv()
    if env_path_str:
        print(f"Loading .env file from: {env_path_str}")
        load_dotenv(dotenv_path=env_path_str)
    else:
        print("No .env file found. It will be created if an API key is saved via the UI.")
    
    configure_genai()
    print("GenAI configured with environment variables.")

    PDF_DIR.mkdir(exist_ok=True)
    DATA_DIR.mkdir(exist_ok=True)
    TEMPLATES_DIR.mkdir(exist_ok=True)
    
    # Create sheets config file if it doesn't exist
    if not SHEETS_CONFIG_FILE.exists():
        print(f"Sheets configuration not found. Creating empty file at {SHEETS_CONFIG_FILE}")
        with open(SHEETS_CONFIG_FILE, 'w') as f:
            json.dump([], f)

    # The static directory is bundled, so we don't need to create it.

    # Create a default template if the directory is empty
    if not any(TEMPLATES_DIR.iterdir()):
        print("Templates directory is empty. Creating default template.")
        shutil.copy(DEFAULT_TEMPLATE_FILE, TEMPLATES_DIR / "default.json")

    try:
        scopes = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive.file"]

        gspread_client = gspread.service_account(filename=CREDS_FILE, scopes=scopes)
        print("Successfully authenticated with Google Service Account.")
        
        # Discover local dataset files
        for filepath in DATA_DIR.glob("*.jsonl"):
            dataset_name = filepath.name
            AVAILABLE_DATASETS[dataset_name] = filepath
        print(f"Discovered {len(AVAILABLE_DATASETS)} available dataset files.")

        # Signal readiness
        if hasattr(app.state, 'ready_event'):
            app.state.ready_event.set()
    except Exception as e:
        print(f"FATAL ERROR during initialization: {e}")
        print("Could not authenticate with Google. Annotation features will be limited.")
        if hasattr(app.state, 'ready_event'):
            app.state.ready_event.set()

@app.post("/save-api-key")
def save_api_key(request: ApiKeyRequest):
    try:
        # This logic is fine. find_dotenv() will search up from the current working dir.
        # If not found, set_key will create a .env file next to the executable.
        env_path_str = find_dotenv()
        if not env_path_str:
            env_path = Path(".env")
            env_path.touch()
            env_path_str = str(env_path)
            print(f"Created a new .env file at: {env_path_str}")

        key = request.key

        set_key(env_path_str, "GEMINI_API_KEY", key)
        configure_genai() # Re-configure after saving a new key
        print(f"Successfully saved and reloaded GEMINI_API_KEY from {env_path_str}")
        return {"status": "success", "message": "API Key saved successfully."}
    except Exception as e:
        print(f"ERROR: Could not save API Key. Error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save API key: {e}")

@app.get("/check-api-key")
def check_api_key():
    load_dotenv(override=True)  # Force reloading the .env file
    api_key = os.getenv("GEMINI_API_KEY")
    is_set = bool(api_key and api_key.strip())
    return {"is_set": is_set}

@app.get("/get-gemini-models")
def get_available_gemini_models():
    return get_gemini_models()

@app.get("/get-sheet-stats")
def get_sheet_stats():
    if not worksheet:
        return {"completed_count": 0, "incomplete_count": 0}
    return {
        "completed_count": len(ANNOTATED_ITEMS),
        "incomplete_count": len(INCOMPLETE_ANNOTATIONS)
    }

@app.get("/get-detailed-stats")
def get_detailed_stats():
    if not worksheet:
        raise HTTPException(status_code=400, detail="No Google Sheet is currently connected.")
    try:
        records = worksheet.get_all_records()
        total_annotations = len(records)
        if total_annotations == 0:
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
        print(f"Requesting Gemini suggestions for '{request.pdf_filename}' using model '{request.model_name}'...")
        gemini_result = await get_gemini_response(
            gemini_model=request.model_name,
            pdf_filepath=pdf_path,
            template=request.template
        )
        # The response from genai is already a JSON-like object, we can access its text attribute
        response_data = json.loads(gemini_result.text)
        print("Successfully received and parsed suggestions from Gemini.")
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
        print(f"Dataset '{dataset_name}' is already in memory. Reloading to ensure consistency.")

    if dataset_name not in AVAILABLE_DATASETS:
        raise HTTPException(status_code=404, detail=f"Dataset file '{dataset_name}' not found on server.")

    filepath = AVAILABLE_DATASETS[dataset_name]
    print(f"Processing dataset: {dataset_name}. Prioritize incomplete: {request.prioritize_incomplete}")
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
        
        print(f"Found {len(incomplete_queue)} incomplete papers to prioritize.")
        print(f"Found {len(new_paper_queue)} new papers to annotate.")

        random.shuffle(new_paper_queue)
        
        if request.prioritize_incomplete:
            final_queue = incomplete_queue + new_paper_queue
            print("Prioritizing incomplete annotations at the front of the queue.")
        else:
            combined_queue = incomplete_queue + new_paper_queue
            random.shuffle(combined_queue)
            final_queue = combined_queue
            print("Shuffling incomplete annotations with the rest of the queue.")

        DATASET_QUEUES[dataset_name] = final_queue
        
        queued_count = len(final_queue)
        print(f"Finished processing. Total in file: {total_in_file}, Added to Queue: {queued_count}.")
        return {"status": "success", "dataset": dataset_name, "queued_count": queued_count, "total_in_file": total_in_file}

    except Exception as e:
        print(f"ERROR: Failed to load and process dataset '{dataset_name}'. Error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to process dataset file: {e}")


@app.post("/download-pdf")
async def download_pdf_proxy(request: PdfRequest):
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        response = requests.get(str(request.url), headers=headers, timeout=20)
        response.raise_for_status()
        content_type = response.headers.get('Content-Type', '')
        if 'application/pdf' not in content_type:
            raise HTTPException(status_code=415, detail=f"URL did not point to a PDF. Server sent Content-Type: {content_type}")
        
        # Sanitize author name to be ASCII-safe for filenames and headers
        author_raw = request.author or "UnknownAuthor"
        author_ascii = author_raw.encode('ascii', 'ignore').decode('ascii')
        author = re.sub(r'[^\w-]', '', author_ascii)

        year_str = str(request.year) if request.year else "UnknownYear"
        safe_title = re.sub(r'[^\w\s-]', '', request.title or "untitled").strip().lower()
        title_fragment = "_".join(safe_title.split()[:4])
        filename = f"{author}{year_str}-{title_fragment}.pdf"
        filepath = PDF_DIR / filename
        
        with open(filepath, "wb") as f:
            f.write(response.content)
        print(f"Successfully saved PDF to: {filepath}")
        
        return Response(
            content=response.content, 
            media_type="application/pdf",
            headers={"X-Saved-Filename": filename}
        )
    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=400, detail=f"Failed to download PDF from URL. Reason: {e}")

@app.get("/get-datasets")
def get_datasets():
    return sorted(list(AVAILABLE_DATASETS.keys()))

@app.get("/get-next-paper")
def get_next_paper(dataset: str, annotator: str, pdf_required: bool = True):
    if not worksheet:
        raise HTTPException(status_code=400, detail="No Google Sheet is currently connected.")
    if not annotator or annotator == 'unknown':
        raise HTTPException(status_code=400, detail="Annotator name must be set in Settings before getting a paper.")

    if dataset not in DATASET_QUEUES or not DATASET_QUEUES[dataset]:
        raise HTTPException(status_code=404, detail=f"Dataset '{dataset}' queue is empty or not loaded.")

    try:
        all_sheet_values = worksheet.get_all_values()
        if not all_sheet_values:
             # If the sheet is completely empty, we can still proceed, but there are no locks or completed items to check.
            headers = []
        else:
            headers = all_sheet_values[0]

        # Handle case where sheet might be empty or columns don't exist yet
        doi_col_idx = headers.index('doi') if 'doi' in headers else -1
        annotator_col_idx = headers.index('annotator') if 'annotator' in headers else -1
        lock_annotator_col_idx = headers.index('lock_annotator') if 'lock_annotator' in headers else -1
        lock_timestamp_col_idx = headers.index('lock_timestamp') if 'lock_timestamp' in headers else -1

        if doi_col_idx != -1: # Only check for locks if columns exist
            for i, row in enumerate(all_sheet_values[1:]):
                # Check for existing lock for the current user
                if len(row) > lock_annotator_col_idx and row[lock_annotator_col_idx] == annotator:
                    lock_time_str = row[lock_timestamp_col_idx] if len(row) > lock_timestamp_col_idx else None
                    if lock_time_str:
                        try:
                            lock_time = float(lock_time_str)
                            if time.time() - lock_time < LOCK_TIMEOUT_SECONDS:
                                resume_doi = row[doi_col_idx]
                                print(f"Found existing lock for {annotator} on DOI {resume_doi}. Refreshing lock and resuming session.")
                                worksheet.update_cell(i + 2, lock_timestamp_col_idx + 1, time.time())
                                paper_to_resume = next((p for p in DATASET_QUEUES[dataset] if p.get('doi') == resume_doi), None)
                                if paper_to_resume:
                                    paper_to_resume['lock_info'] = {"locked": True, "remaining_seconds": LOCK_TIMEOUT_SECONDS}
                                    if resume_doi in INCOMPLETE_ANNOTATIONS:
                                        paper_to_resume['existing_annotation'] = INCOMPLETE_ANNOTATIONS[resume_doi]['data']
                                    return paper_to_resume
                        except (ValueError, TypeError):
                            continue

            unavailable_dois = set()
            for row in all_sheet_values[1:]:
                if len(row) <= max(doi_col_idx, annotator_col_idx, lock_annotator_col_idx, lock_timestamp_col_idx):
                    continue
                
                doi = row[doi_col_idx]
                is_completed = bool(row[annotator_col_idx].strip())
                lock_holder = row[lock_annotator_col_idx]
                lock_time_str = row[lock_timestamp_col_idx]

                if is_completed:
                    unavailable_dois.add(doi)
                    continue
                
                is_locked_by_another = lock_holder and lock_holder != annotator and lock_time_str
                if is_locked_by_another:
                    try:
                        if time.time() - float(lock_time_str) < LOCK_TIMEOUT_SECONDS:
                            unavailable_dois.add(doi)
                    except (ValueError, TypeError):
                        pass
        else: # No columns yet, so no unavailable DOIs
            unavailable_dois = set()


        candidate_paper = None
        papers_to_check = [p for p in DATASET_QUEUES[dataset] if p.get('doi') not in unavailable_dois]

        for paper_data in papers_to_check:
            if pdf_required:
                pdf_url_info = paper_data.get('open_access_pdf', {})
                pdf_url = pdf_url_info.get('url') if isinstance(pdf_url_info, dict) else pdf_url_info

                if not pdf_url or not isinstance(pdf_url, str) or not pdf_url.startswith('http'):
                    continue

                try:
                    headers_req = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
                    response = requests.head(str(pdf_url), headers=headers_req, timeout=10, allow_redirects=True)
                    response.raise_for_status()
                    content_type = response.headers.get('Content-Type', '')
                    
                    if 'application/pdf' not in content_type:
                        print(f"Skipping DOI {paper_data.get('doi')} - Not a PDF (Content-Type: {content_type})")
                        continue
                except requests.exceptions.RequestException:
                    continue
            
            candidate_paper = paper_data
            break

        if not candidate_paper:
            raise HTTPException(status_code=404, detail="No available (unlocked and un-annotated) papers found. Please try again later.")

        candidate_doi = candidate_paper.get('doi')
        
        if doi_col_idx != -1: # Only try to lock if columns exist
            try:
                cell = worksheet.find(candidate_doi, in_column=doi_col_idx + 1)
                if cell is None:
                    # This can happen if the dataset is not yet in the sheet. We can still proceed.
                    print(f"DOI {candidate_doi} not found in sheet. Proceeding without lock.")
                else:
                    row_num = cell.row
                    current_lock_holder = worksheet.cell(row_num, lock_annotator_col_idx + 1).value
                    if current_lock_holder and current_lock_holder != annotator:
                        raise HTTPException(status_code=409, detail="Paper was locked by another user just now. Please try again.")
                    worksheet.update_cell(row_num, lock_annotator_col_idx + 1, annotator)
                    worksheet.update_cell(row_num, lock_timestamp_col_idx + 1, time.time())
                    print(f"Lock acquired for DOI {candidate_doi} by {annotator}.")
                    candidate_paper['lock_info'] = {"locked": True, "remaining_seconds": LOCK_TIMEOUT_SECONDS}
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"An error occurred while trying to lock the paper: {e}")

        if candidate_doi in INCOMPLETE_ANNOTATIONS:
            candidate_paper['existing_annotation'] = INCOMPLETE_ANNOTATIONS[candidate_doi]['data']
        return candidate_paper

    except (ValueError, APIError) as e:
        raise HTTPException(status_code=500, detail=f"A spreadsheet error occurred: {e}")

def clear_lock(doi: str):
    if not worksheet:
        print(f"Warning: Cannot clear lock for DOI {doi}, no sheet connected.")
        return
    try:
        headers = worksheet.row_values(1)
        if 'doi' not in headers: return # Can't find column

        cell = worksheet.find(doi, in_column=headers.index('doi') + 1)
        if not cell:
            print(f"Warning: Could not find DOI {doi} in sheet to clear lock.")
            return

        lock_annotator_col = headers.index('lock_annotator') + 1
        lock_timestamp_col = headers.index('lock_timestamp') + 1
        
        worksheet.update_cell(cell.row, lock_annotator_col, "")
        worksheet.update_cell(cell.row, lock_timestamp_col, "")
        print(f"Cleared lock for DOI {doi} in sheet.")
    except Exception as e:
        print(f"Error clearing lock for DOI {doi}: {e}")

@app.get("/get-lock-status/{doi:path}")
def get_lock_status(doi: str):
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
            return {
                "locked": True,
                "remaining_seconds": int(LOCK_TIMEOUT_SECONDS - elapsed_time)
            }
        else:
            return {"locked": False, "remaining_seconds": 0}

    except (APIError, ValueError, IndexError) as e:
        print(f"Could not retrieve lock status for {doi}: {e}")
        return {"locked": False, "remaining_seconds": 0}

@app.post("/skip-paper")
def skip_paper(request: SkipRequest):
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

    return {"status": "success", "skipped_doi": request.doi}

@app.post("/submit-annotation")
def submit_annotation(submission: AnnotationSubmission):
    if not worksheet:
        raise HTTPException(status_code=400, detail="No Google Sheet is currently connected.")
        
    submitted_doi = submission.doi
    try:
        headers = worksheet.row_values(1)
        if 'doi' not in headers: # Sheet is likely empty or unformatted
             raise HTTPException(status_code=500, detail=f"The sheet does not have a 'doi' column. Cannot save.")

        cell = worksheet.find(submitted_doi, in_column=headers.index('doi') + 1)
        if not cell:
             raise HTTPException(status_code=404, detail=f"Could not find submitted DOI {submitted_doi} in the sheet. Cannot save.")

        row_to_update = cell.row
        
        # Flatten the submission data to match the sheet headers
        flat_submission = {
            "doi": submission.doi,
            "title": submission.title,
            "dataset": submission.dataset,
            "annotator": submission.annotator,
            **submission.annotations
        }
        
        row_values = [flat_submission.get(h, "") for h in headers if 'lock_' not in h]

        worksheet.update(f'A{row_to_update}', [row_values], value_input_option='USER_ENTERED')
        
        clear_lock(submitted_doi)

        dataset_name = submission.dataset
        if dataset_name in DATASET_QUEUES and DATASET_QUEUES[dataset_name]:
            DATASET_QUEUES[dataset_name] = [p for p in DATASET_QUEUES[dataset_name] if p.get('doi') != submitted_doi]
        
        ANNOTATED_ITEMS.add(submitted_doi)
        if submitted_doi in INCOMPLETE_ANNOTATIONS:
            del INCOMPLETE_ANNOTATIONS[submitted_doi]

        print(f"Successfully wrote annotation and cleared lock for DOI {submitted_doi}.")
        return {"status": "success", "doi": submitted_doi}
        
    except Exception as e:
        print(f"ERROR: Failed to write to Google Sheet for DOI {submitted_doi}. Lock was NOT cleared. Error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to write to Google Sheet: {e}")
    
@app.post("/open-data-folder")
def open_data_folder():
    """Opens the data folder in the system's file explorer."""
    data_path = DATA_DIR
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
    return _read_sheets_config()

@app.post("/api/sheets")
def add_or_update_sheet(request: SheetUrlRequest):
    """Adds a new sheet or updates an existing one by name, parsing the ID from the URL."""
    # Regex to extract the sheet ID from a Google Sheet URL
    # Example URL: https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0
    match = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", request.url)
    if not match:
        raise HTTPException(status_code=400, detail="Invalid Google Sheet URL. Could not find a valid Sheet ID.")
    
    sheet_id = match.group(1)

    # Now create the config object that we will save
    sheet_config = SheetConfigRequest(name=request.name, id=sheet_id)
    
    config = _read_sheets_config()
    # Check if a sheet with the same name exists and update it
    for i, sheet in enumerate(config):
        if sheet['name'] == sheet_config.name:
            config[i] = sheet_config.dict()
            _write_sheets_config(config)
            return {"status": "success", "message": f"Sheet '{sheet_config.name}' updated."}
    # If not found, add as a new sheet
    config.append(sheet_config.dict())
    _write_sheets_config(config)
    return {"status": "success", "message": f"Sheet '{sheet_config.name}' added."}

@app.delete("/api/sheets/{sheet_id}")
def delete_sheet(sheet_id: str):
    """Deletes a sheet configuration by its ID."""
    config = _read_sheets_config()
    new_config = [sheet for sheet in config if sheet.get('id') != sheet_id]
    if len(new_config) == len(config):
        raise HTTPException(status_code=404, detail="Sheet ID not found in configuration.")
    _write_sheets_config(new_config)
    return {"status": "success", "message": "Sheet configuration deleted."}

class ConnectSheetRequest(BaseModel):
    sheet_id: str

@app.post("/connect-to-sheet")
def connect_to_sheet(request: ConnectSheetRequest):
    """Connects to a specific Google Sheet and loads its metadata."""
    global worksheet, ANNOTATED_ITEMS, INCOMPLETE_ANNOTATIONS
    if not gspread_client:
        raise HTTPException(status_code=500, detail="gspread client not initialized.")

    try:
        sh = gspread_client.open_by_key(request.sheet_id)
        worksheet = sh.sheet1
        print(f"Successfully connected to Google Sheet by ID: {request.sheet_id}")

        # Reset state for the new sheet
        ANNOTATED_ITEMS.clear()
        INCOMPLETE_ANNOTATIONS.clear()

        setup_sheet_columns(worksheet)
        all_records = worksheet.get_all_records()

        if not all_records:
            print("Google Sheet is empty. No previous annotations found.")
        else:
            headers = all_records[0].keys()
            required_headers = [h for h in headers if h and '_context' not in h.lower() and 'lock_' not in h.lower()]
            for i, rec in enumerate(all_records, start=2):
                doi = rec.get('doi', '').strip()
                if not doi:
                    continue
                is_complete = all(str(rec.get(header, '')).strip() != '' for header in required_headers)
                if is_complete:
                    ANNOTATED_ITEMS.add(doi)
                else:
                    INCOMPLETE_ANNOTATIONS[doi] = {'data': rec, 'row_num': i}

        completed = len(ANNOTATED_ITEMS)
        incomplete = len(INCOMPLETE_ANNOTATIONS)
        print(f"Loaded sheet data: {completed} completed, {incomplete} incomplete.")

        return {
            "status": "success",
            "message": "Connected successfully.",
            "completed_count": completed,
            "incomplete_count": incomplete
        }
    except APIError as e:
        raise HTTPException(status_code=400, detail=f"Could not connect to Sheet. Check ID and permissions. Error: {e.response.json().get('error', {}).get('message')}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {e}")


# --- Template Management API ---

@app.get("/api/templates")
def get_templates():
    """Lists all available .json template files by scanning the directory."""
    if not TEMPLATES_DIR.exists():
        return []
    return sorted([f.name for f in TEMPLATES_DIR.glob("*.json")])

@app.get("/api/templates/{template_name}")
def get_template(template_name: str):
    """Gets the content of a specific template file."""
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
    if not re.match(r"^[a-zA-Z0-9_-]+\.json$", template_name):
        raise HTTPException(status_code=400, detail="Invalid template name.")

    file_path = TEMPLATES_DIR / template_name
    try:
        data = await request.json()
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4)
        return {"status": "success", "filename": template_name}
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON data.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error saving template file: {e}")

@app.delete("/api/templates/{template_name}")
def delete_template(template_name: str):
    """Deletes a template file."""
    if not re.match(r"^[a-zA-Z0-9_-]+\.json$", template_name):
        raise HTTPException(status_code=400, detail="Invalid template name.")

    file_path = TEMPLATES_DIR / template_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Template not found.")
    
    try:
        os.remove(file_path)
        return {"status": "success", "filename": template_name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error deleting template file: {e}")
    
@app.post("/open-templates-folder")
def open_templates_folder():
    """Opens the templates folder in the system's file explorer."""
    templates_path = TEMPLATES_DIR
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
        return {"status": "error", "message": str(e)}

@app.post("/upload-template")
async def upload_template(file: UploadFile = File(...)):
    """Uploads a .json template file."""
    if not file.filename.endswith(".json"):
        raise HTTPException(status_code=400, detail="Invalid file type. Please upload a .json file.")

    file_path = TEMPLATES_DIR / file.filename
    try:
        contents = await file.read()
        # Validate that it's valid JSON
        json.loads(contents)
        
        with open(file_path, "wb") as f:
            f.write(contents)
        
        print(f"Successfully uploaded template: {file.filename}")
        return {"status": "success", "filename": file.filename}
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON format in the uploaded file.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error saving uploaded file: {e}")
    
@app.get("/check-for-updates")
def check_for_updates():
    """Compares local git hash with the remote GitHub main branch hash."""
    local_hash = get_local_git_hash()
    if local_hash == "nogit":
        return {"update_available": False, "message": "Not a Git repository."}

    try:
        repo_url = "https://api.github.com/repos/scottkryski/Scribe/branches/main"
        response = requests.get(repo_url, timeout=5)
        response.raise_for_status()
        
        remote_data = response.json()
        remote_hash = remote_data.get("commit", {}).get("sha")

        if not remote_hash:
            raise HTTPException(status_code=500, detail="Could not parse remote commit hash.")

        if local_hash != remote_hash:
            return {"update_available": True, "message": "A new version is available!"}
        else:
            return {"update_available": False, "message": "You are on the latest version."}
            
    except requests.RequestException as e:
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