# backend/routers/sheets.py
import json
import re
from collections import Counter
from fastapi import APIRouter, HTTPException
from gspread.exceptions import APIError
from pydantic import BaseModel
from datetime import datetime, timezone

from models import SheetUrlRequest, ConnectSheetRequest
from app_state import state
from config import SHEETS_CONFIG_FILE

router = APIRouter()

# NEW: simple pantic model for posting comments
class NewComment(BaseModel):
    doi: str
    comment: str
    annotator: str

def _read_sheets_config():
    if not SHEETS_CONFIG_FILE.exists(): return []
    with open(SHEETS_CONFIG_FILE, 'r') as f: return json.load(f)

def _write_sheets_config(config):
    with open(SHEETS_CONFIG_FILE, 'w') as f: json.dump(config, f, indent=2)

def setup_sheet_columns(ws):
    """
    Checks for and adds required columns to the worksheet.
    If the sheet is empty, it creates a default set of headers.
    """
    print("LOG: Setting up sheet columns...")
    try:
        headers = ws.row_values(1)
    except APIError:
        print("LOG: Sheet appears to be empty. Creating default headers.")
        headers = []
    except Exception as e:
        print(f"An unexpected error occurred during sheet setup: {e}")
        return

    if not headers:
        default_headers = [
            'doi', 'title', 'dataset', 'annotator',
            'lock_annotator', 'lock_timestamp'
        ]
        ws.update('A1', [default_headers])
        print("LOG: Created default headers in the empty sheet.")
        return

    required_columns = ['dataset', 'lock_annotator', 'lock_timestamp']
    for col_name in required_columns:
        if col_name not in headers:
            print(f"LOG: Column '{col_name}' not found. Adding it...")
            ws.update_cell(1, len(headers) + 1, col_name)
            headers.append(col_name)
    
    print("LOG: Sheet columns setup complete.")

def ensure_comments_worksheet():
    """
    Ensure a 'Comments' worksheet exists in the connected spreadsheet.
    Returns the gspread Worksheet instance.
    """
    if not state.worksheet:
        raise HTTPException(status_code=400, detail="No Google Sheet connected.")
    try:
        ss = state.worksheet.spreadsheet
        try:
            ws = ss.worksheet("Comments")
        except Exception:
            ws = ss.add_worksheet(title="Comments", rows=1000, cols=4)
            ws.update('A1:D1', [["doi", "annotator", "timestamp", "comment"]])
        return ws
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to access/create Comments sheet: {e}")


@router.get("/api/sheets")
def get_sheets():
    return _read_sheets_config()

@router.post("/api/sheets")
def add_or_update_sheet(request: SheetUrlRequest):
    match = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", request.url)
    if not match:
        raise HTTPException(status_code=400, detail="Invalid Google Sheet URL.")
    
    sheet_id = match.group(1)
    sheet_config = {"name": request.name, "id": sheet_id}
    config = _read_sheets_config()
    
    existing_sheet_index = next((i for i, sheet in enumerate(config) if sheet['name'] == request.name), None)
    
    if existing_sheet_index is not None:
        config[existing_sheet_index] = sheet_config
    else:
        config.append(sheet_config)
        
    _write_sheets_config(config)
    return {"status": "success", "message": "Sheet configuration saved."}


@router.delete("/api/sheets/{sheet_id}")
def delete_sheet(sheet_id: str):
    config = _read_sheets_config()
    new_config = [s for s in config if s.get('id') != sheet_id]
    if len(new_config) == len(config):
        raise HTTPException(status_code=404, detail="Sheet ID not found.")
    _write_sheets_config(new_config)
    return {"status": "success"}

@router.post("/connect-to-sheet")
def connect_to_sheet(request: ConnectSheetRequest):
    if not state.gspread_client:
        raise HTTPException(status_code=500, detail="gspread client not initialized.")
    try:
        sh = state.gspread_client.open_by_key(request.sheet_id)
        state.worksheet = sh.sheet1
        
        setup_sheet_columns(state.worksheet)

        state.ANNOTATED_ITEMS.clear()
        state.INCOMPLETE_ANNOTATIONS.clear()

        all_records = state.worksheet.get_all_records()

        if all_records:
            # --- FIX START: Redefined "completeness" logic ---
            # An annotation is complete if it has an annotator.
            # It's incomplete if it has data but no annotator.
            for i, rec in enumerate(all_records, start=2):
                doi = rec.get('doi', '').strip()
                if not doi: continue

                is_complete = bool(rec.get('annotator', '').strip())
                
                if is_complete:
                    state.ANNOTATED_ITEMS.add(doi)
                else:
                    # Check if it's more than just a placeholder before adding to incomplete
                    other_values = [v for k, v in rec.items() if k not in ['doi', 'title', 'dataset', 'lock_annotator', 'lock_timestamp'] and v]
                    if other_values:
                         state.INCOMPLETE_ANNOTATIONS[doi] = {'data': rec, 'row_num': i}
            # --- FIX END ---

        return {"status": "success", "completed_count": len(state.ANNOTATED_ITEMS), "incomplete_count": len(state.INCOMPLETE_ANNOTATIONS)}
    except APIError as e:
        error_details = e.response.json().get('error', {}).get('message', 'Unknown API Error')
        raise HTTPException(status_code=400, detail=f"Could not connect. Check Sheet ID and permissions. Error: {error_details}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {e}")

@router.get("/get-sheet-stats")
def get_sheet_stats():
    if not state.worksheet:
        return {"completed_count": 0, "incomplete_count": 0}
    return {"completed_count": len(state.ANNOTATED_ITEMS), "incomplete_count": len(state.INCOMPLETE_ANNOTATIONS)}

@router.get("/get-detailed-stats")
def get_detailed_stats():
    if not state.worksheet:
        raise HTTPException(status_code=400, detail="No Google Sheet is currently connected.")
    try:
        records = state.worksheet.get_all_records()
        if not records: return {"total_annotations": 0}
        
        headers = state.worksheet.row_values(1)
        excluded = {'doi', 'title', 'dataset', 'annotator', 'lock_annotator', 'lock_timestamp'}
        bool_fields = [h for h in headers if h and '_context' not in h and h not in excluded]

        annotator_counts = Counter(r.get("annotator") for r in records if r.get("annotator"))

        return {
            "total_annotations": len(records),
            "overall_counts": {f: dict(Counter(str(r.get(f, 'N/A')).upper() for r in records)) for f in bool_fields},
            "doc_type_distribution": dict(Counter(r.get("attribute_docType") for r in records if r.get("attribute_docType"))),
            "annotator_stats": dict(annotator_counts),
            "dataset_stats": dict(Counter(r.get("dataset") for r in records if r.get("dataset"))),
            "leaderboard": [{"annotator": a, "count": c} for a, c in annotator_counts.most_common()]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get detailed stats: {e}")

@router.get("/api/comments/{doi:path}")
def list_comments(doi: str):
    ws = ensure_comments_worksheet()
    rows = ws.get_all_records()
    items = [r for r in rows if str(r.get("doi","")).strip() == doi.strip()]
    items.sort(key=lambda r: r.get("timestamp",""), reverse=True)
    return {"items": items}

@router.post("/api/comments")
def add_comment(payload: NewComment):
    ws = ensure_comments_worksheet()
    ts = datetime.now(timezone.utc).isoformat()
    ws.append_row([payload.doi, payload.annotator, ts, payload.comment], value_input_option="RAW")
    return {"ok": True, "timestamp": ts}