# backend/routers/dashboard.py
import time
from collections import Counter
import gspread
from fastapi import APIRouter, HTTPException
from typing import Optional
from pydantic import BaseModel
from app_state import state
from models import ReopenRequest
from database import get_papers_index, get_paper_by_doi_from_file
from config import LOCK_TIMEOUT_SECONDS
from datetime import datetime

class SetLockRequest(BaseModel):
    doi: str
    annotator: str
    dataset: str

class CommentRequest(BaseModel):
    doi: str
    annotator: str
    comment: str

def _get_comments_worksheet():
    """Gets the 'Comments' worksheet, creating it if it does not exist."""
    if not state.worksheet:
        print("WARN: Cannot get comments worksheet, no main sheet connected.")
        return None
    try:
        ss = state.worksheet.spreadsheet
        return ss.worksheet("Comments")
    except gspread.WorksheetNotFound:
        print("LOG: 'Comments' worksheet not found. Creating it.")
        try:
            ss = state.worksheet.spreadsheet
            comments_ws = ss.add_worksheet(title="Comments", rows="1", cols="4")
            # --- FIX: Set a more logical default header order ---
            comments_ws.update('A1', [['doi', 'annotator', 'timestamp', 'comment']])
            print("LOG: Successfully created 'Comments' worksheet with headers.")
            return comments_ws
        except Exception as create_e:
            print(f"ERROR: Failed to create 'Comments' worksheet: {create_e}")
            return None
    except Exception as e:
        print(f"ERROR: Could not get 'Comments' worksheet: {e}")
        return None

router = APIRouter()

def get_human_readable_timestamp():
    return datetime.now().strftime('%m/%d/%Y - %I:%M:%S %p')

def is_annotation_complete(record: dict) -> bool:
    """An annotation is considered complete if the 'annotator' field is filled."""
    return bool(record.get('annotator', '').strip())

def _get_all_records():
    """Helper to safely get all records from the connected worksheet."""
    if not state.worksheet:
        print("WARN: Attempted to get records but no worksheet is connected.")
        return []
    try:
        return state.worksheet.get_all_records()
    except Exception as e:
        print(f"ERROR: Could not fetch records from Google Sheet: {e}")
        return []

@router.get("/api/synthetic-sheet-data")
async def get_synthetic_sheet_data():
    """Fetches all data from the 'SyntheticData' worksheet."""
    if not state.worksheet:
        raise HTTPException(status_code=400, detail="No active Google Sheet connection.")
    
    try:
        spreadsheet = state.worksheet.spreadsheet
        synth_worksheet = spreadsheet.worksheet("SyntheticData")
        
        all_values = synth_worksheet.get_all_values()
        headers = all_values[0] if all_values else []
        rows = all_values[1:] if len(all_values) > 1 else []
        
        # Convert rows to list of dicts
        records = [dict(zip(headers, row)) for row in rows]

        return {"headers": headers, "rows": records}
    except gspread.WorksheetNotFound:
        # If the sheet doesn't exist, it's not an error, just return empty data
        return {"headers": [], "rows": []}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to retrieve synthetic data: {e}")


@router.get("/api/comments/{doi:path}")
async def get_comments(doi: str):
    comments_ws = _get_comments_worksheet()
    if not comments_ws:
        raise HTTPException(status_code=500, detail="Could not access the Comments worksheet.")
    
    try:
        all_comments = comments_ws.get_all_records()
        doi_comments = [
            comment for comment in all_comments 
            if comment.get('doi') == doi
        ]
        doi_comments.sort(key=lambda r: r.get("timestamp", ""))
        return {"items": doi_comments}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to retrieve comments: {e}")

@router.post("/api/comments")
async def add_comment(request: CommentRequest):
    comments_ws = _get_comments_worksheet()
    if not comments_ws:
        raise HTTPException(status_code=500, detail="Could not access the Comments worksheet.")

    try:
        # --- FIX: Read headers to ensure data is inserted into the correct columns ---
        headers = comments_ws.row_values(1)
        if not headers:
             raise HTTPException(status_code=500, detail="Comments worksheet is missing headers.")

        comment_data = {
            "doi": request.doi,
            "annotator": request.annotator,
            "comment": request.comment,
            "timestamp": get_human_readable_timestamp()
        }
        
        # Build the row in the exact order of the sheet's current headers
        new_row = [comment_data.get(header, "") for header in headers]
        
        comments_ws.append_row(new_row, value_input_option='USER_ENTERED')
        return {"status": "success", "message": "Comment added."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to post comment: {e}")


@router.post("/api/set-lock")
async def set_lock(request: SetLockRequest):
    if not state.worksheet:
        raise HTTPException(status_code=400, detail="No active Google Sheet connection.")

    try:
        headers = state.worksheet.row_values(1)
        doi_col = headers.index('doi') + 1
        annotator_col = headers.index('annotator') + 1
        lock_annotator_col = headers.index('lock_annotator') + 1
        lock_timestamp_col = headers.index('lock_timestamp') + 1

        old_lock_cell = None
        try:
            old_lock_cell = state.worksheet.find(request.annotator, in_column=lock_annotator_col)
        except gspread.exceptions.CellNotFound:
            pass 

        new_lock_target_cell = None
        try:
            new_lock_target_cell = state.worksheet.find(request.doi, in_column=doi_col)
        except gspread.exceptions.CellNotFound:
            pass

        if old_lock_cell:
            old_lock_row_idx = old_lock_cell.row
            main_annotator_val = state.worksheet.cell(old_lock_row_idx, annotator_col).value
            is_placeholder = not main_annotator_val or not main_annotator_val.strip()

            if is_placeholder:
                state.worksheet.delete_rows(old_lock_row_idx)
                if new_lock_target_cell and new_lock_target_cell.row > old_lock_row_idx:
                    new_lock_target_cell = gspread.Cell(row=new_lock_target_cell.row - 1, col=new_lock_target_cell.col)
            else:
                state.worksheet.batch_update([
                    {'range': gspread.utils.rowcol_to_a1(old_lock_row_idx, lock_annotator_col), 'values': [['']]},
                    {'range': gspread.utils.rowcol_to_a1(old_lock_row_idx, lock_timestamp_col), 'values': [['']]}
                ])

        if new_lock_target_cell:
            state.worksheet.batch_update([
                {'range': gspread.utils.rowcol_to_a1(new_lock_target_cell.row, lock_annotator_col), 'values': [[request.annotator]]},
                {'range': gspread.utils.rowcol_to_a1(new_lock_target_cell.row, lock_timestamp_col), 'values': [[get_human_readable_timestamp()]]}
            ], value_input_option='USER_ENTERED')
        else:
            paper_info = get_paper_by_doi_from_file(state.AVAILABLE_DATASETS[request.dataset], request.doi)
            if not paper_info:
                 raise HTTPException(status_code=404, detail=f"Could not find paper data for DOI {request.doi}")
            
            row_values = [""] * len(headers)
            row_values[headers.index('doi')] = request.doi
            row_values[headers.index('title')] = paper_info.get('title', 'Title not found')
            row_values[headers.index('dataset')] = request.dataset
            row_values[headers.index('lock_annotator')] = request.annotator
            row_values[headers.index('lock_timestamp')] = get_human_readable_timestamp()
            
            state.worksheet.append_row(row_values, value_input_option='USER_ENTERED')

        return {"status": "success", "message": f"Lock transferred to {request.doi}"}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to set lock in Google Sheet: {e}")


@router.get("/api/sheet-data")
async def get_sheet_data(dataset: Optional[str] = None):
    if not state.worksheet:
        raise HTTPException(status_code=400, detail="No active Google Sheet connection.")
    
    active_dataset_name = dataset or getattr(state, 'currentDataset', None)
    if not active_dataset_name:
         return {"headers": [], "rows": []}

    try:
        all_values = state.worksheet.get_all_values()
        headers = all_values[0] if all_values else []
        
        lock_timestamp_col = headers.index('lock_timestamp') + 1 if 'lock_timestamp' in headers else -1
        if lock_timestamp_col != -1:
            cells_to_clear = []
            current_time = time.time()
            for i, row in enumerate(all_values[1:], start=2):
                if len(row) >= lock_timestamp_col:
                    ts_str = row[lock_timestamp_col - 1]
                    if not ts_str: continue
                    try:
                        ts = datetime.strptime(ts_str, '%m/%d/%Y - %I:%M:%S %p').timestamp()
                    except ValueError:
                        try: ts = float(ts_str)
                        except ValueError: continue
                    
                    if current_time - ts > LOCK_TIMEOUT_SECONDS:
                        print(f"LOG: Found stale lock on row {i}. Clearing.")
                        cells_to_clear.append(gspread.Cell(row=i, col=headers.index('lock_annotator') + 1, value=""))
                        cells_to_clear.append(gspread.Cell(row=i, col=lock_timestamp_col, value=""))
            
            if cells_to_clear:
                state.worksheet.update_cells(cells_to_clear, value_input_option='USER_ENTERED')
        
        sheet_records = state.worksheet.get_all_records()

        sheet_dois = {record.get('doi') for record in sheet_records}
        all_papers_index = get_papers_index(active_dataset_name)

        latest_comments = {}
        comments_ws = _get_comments_worksheet()
        if comments_ws:
            all_comments = comments_ws.get_all_records()
            all_comments.sort(key=lambda r: r.get("timestamp", ""), reverse=True)
            for comment in all_comments:
                doi = comment.get("doi")
                if doi and doi not in latest_comments:
                    latest_comments[doi] = f"{comment.get('annotator', 'Anon')}: {comment.get('comment', '')}"
        
        if "Latest Comment" not in headers: headers.append("Latest Comment")

        processed_rows = []
        for record in sheet_records:
            doi = record.get('doi')
            if not doi: continue
            
            is_complete = is_annotation_complete(record)
            annotator = record.get('annotator', '')
            status = 'Incomplete'

            lock_ts_str = str(record.get('lock_timestamp', '')).strip()
            is_locked = False
            if lock_ts_str:
                try:
                    ts = datetime.strptime(lock_ts_str, '%m/%d/%Y - %I:%M:%S %p').timestamp()
                except ValueError:
                    try: ts = float(lock_ts_str)
                    except ValueError: ts = 0
                if time.time() - ts < LOCK_TIMEOUT_SECONDS:
                    is_locked = True

            if is_locked:
                annotator = record.get('lock_annotator', '')
                status = 'Reviewing' if is_complete else 'Locked'
            elif is_complete:
                status = 'Completed'

            row = {
                'doi': doi, 'title': record.get('title', 'No Title'),
                'annotator': annotator, 'status': status,
                'latest_comment': latest_comments.get(doi, '')
            }
            for header in headers:
                field_key = header.replace(' ', '_').lower()
                if field_key not in row:
                    row[field_key] = record.get(header, '')
            processed_rows.append(row)

        for paper in all_papers_index:
            if paper['doi'] not in sheet_dois:
                processed_rows.append({
                    'doi': paper['doi'], 'title': paper.get('title', 'No Title'),
                    'annotator': '', 'status': 'Available',
                    'latest_comment': latest_comments.get(paper['doi'], '')
                })

        return {"headers": headers, "rows": processed_rows}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to retrieve or process sheet data: {e}")


@router.post("/reopen-annotation")
async def reopen_annotation(request: ReopenRequest):
    if not state.worksheet:
        raise HTTPException(status_code=400, detail="No active Google Sheet connection.")
        
    dataset_path = state.AVAILABLE_DATASETS.get(request.dataset)
    if not dataset_path:
        raise HTTPException(status_code=404, detail=f"Dataset '{request.dataset}' not found.")

    paper = get_paper_by_doi_from_file(dataset_path, request.doi)
    if not paper:
        raise HTTPException(status_code=404, detail=f"Paper with DOI '{request.doi}' not found in dataset.")

    try:
        cell = state.worksheet.find(request.doi, in_column=1)
        if cell:
            headers = state.worksheet.row_values(1)
            values = state.worksheet.row_values(cell.row)
            row_data = dict(zip(headers, values))
            
            non_placeholder_keys = ['annotator'] + [h for h in headers if '_context' in h or h.startswith('trigger_')]
            is_real_incomplete = any(row_data.get(key) for key in non_placeholder_keys)

            if is_real_incomplete:
                paper['existing_annotation'] = row_data
    except Exception as e:
        print(f"WARN: Could not find existing annotation for {request.doi} during reopen: {e}")
    
    return paper

@router.get("/get-sheet-stats")
async def get_sheet_stats():
    """Provides simple counts of completed vs incomplete annotations."""
    records = _get_all_records()
    if not records:
        return {"completed_count": 0, "incomplete_count": 0}

    status_counts = Counter(r.get("status") for r in records)
    return {
        "completed_count": status_counts.get("Completed", 0),
        "incomplete_count": status_counts.get("Incomplete", 0)
    }

@router.get("/get-detailed-stats")
async def get_detailed_stats():
    records = _get_all_records()
    if not records:
        raise HTTPException(status_code=404, detail="No data found in the sheet to generate stats.")

    total_annotations = len(records)
    overall_counts = {}
    doc_type_counts = Counter()
    annotator_counts = Counter()
    dataset_counts = Counter()
    status_counts = Counter()

    # Ethics specific counters
    ethics_ethicsDeclaration_counts = Counter()
    ethics_fields_counts = Counter()

    headers = list(records[0].keys()) if records else []
    boolean_fields = [h for h in headers if h.startswith("trigger_") and not h.endswith("_context")]
    ethics_boolean_fields = [h for h in headers if h.startswith("ethics_COI") and not h.endswith("_context")]
    ethics_fields = [
        h
        for h in headers
        if h.startswith("ethics_")
        and not h.endswith("_context")
        and h not in ethics_boolean_fields
    ]
    
    for record in records:
        for field in boolean_fields:
            if field not in overall_counts:
                overall_counts[field] = Counter()
            value = str(record.get(field, "")).upper()
            if value in ["TRUE", "FALSE"]:
                overall_counts[field][value] += 1

        for field in ethics_boolean_fields:
            if field not in overall_counts:
                overall_counts[field] = Counter()
            value = str(record.get(field, "")).upper()
            if value in ["TRUE", "FALSE"]:
                overall_counts[field][value] += 1

        for field in ethics_fields:
            if field not in overall_counts:
                overall_counts[field] = Counter()
            raw_value = record.get(field, "")
            value = str(raw_value).strip()
            if value:
                overall_counts[field][value] += 1

        doc_type = record.get("attribute_docType")
        if doc_type:
            doc_type_counts[doc_type] += 1

        annotator = record.get("Annotator") or record.get("annotator")
        if annotator:
            annotator_counts[annotator] += 1
        
        dataset = record.get("Dataset")
        if dataset:
            dataset_counts[dataset] += 1
            
        status = record.get("status", "Completed") or "Completed"
        status_counts[status] += 1

    leaderboard = [{"annotator": a, "count": c} for a, c in annotator_counts.most_common()]

    return {
        "total_annotations": total_annotations,
        "completed_annotations": status_counts.get("Completed", 0),
        "incomplete_annotations": status_counts.get("Incomplete", 0),
        "overall_counts": overall_counts,
        "doc_type_distribution": doc_type_counts,
        "leaderboard": leaderboard,
        "dataset_stats": dataset_counts
    }
