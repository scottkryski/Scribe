# backend/routers/annotation.py
import time
from typing import Optional
from fastapi import APIRouter, HTTPException
from gspread.exceptions import APIError
from datetime import datetime

from models import AnnotationSubmission, SkipRequest
from app_state import state
from config import LOCK_TIMEOUT_SECONDS
from database import get_paper_by_doi_from_file

router = APIRouter()

# --- FIX: Use a cross-platform compatible timestamp format ---
def get_human_readable_timestamp():
    return datetime.now().strftime('%m/%d/%Y - %I:%M:%S %p')

def clear_lock(doi: str):
    """Finds a row by DOI and clears the lock_annotator and lock_timestamp fields."""
    print(f"LOG: Attempting to clear lock for DOI: {doi}")
    if not state.worksheet:
        return
    try:
        headers = state.worksheet.row_values(1)
        if 'doi' not in headers: return

        cell = state.worksheet.find(doi, in_column=headers.index('doi') + 1)
        if not cell: return

        lock_annotator_col = headers.index('lock_annotator') + 1
        lock_timestamp_col = headers.index('lock_timestamp') + 1
        
        state.worksheet.update_cell(cell.row, lock_annotator_col, "")
        state.worksheet.update_cell(cell.row, lock_timestamp_col, "")
        print(f"LOG: Cleared lock for DOI {doi} in sheet row {cell.row}.")
    except Exception as e:
        print(f"ERROR: Error clearing lock for DOI {doi}: {e}")

@router.get("/check-for-resumable-paper")
def check_for_resumable_paper(annotator: str):
    print(f"LOG: Checking for resumable paper for annotator '{annotator}'")
    if not state.worksheet:
        return {"resumable": False}

    try:
        all_values = state.worksheet.get_all_values()
        if not all_values: return {"resumable": False}
        
        headers = all_values[0]
        required_cols = ['doi', 'title', 'dataset', 'lock_annotator', 'lock_timestamp']
        if not all(h in headers for h in required_cols):
            return {"resumable": False}

        doi_idx, title_idx, dataset_idx, lock_annotator_idx, lock_timestamp_idx = (headers.index(h) for h in required_cols)

        for row in reversed(all_values[1:]):
            if len(row) > max(lock_annotator_idx, lock_timestamp_idx, doi_idx, title_idx, dataset_idx):
                if row[lock_annotator_idx].strip() == annotator and row[lock_timestamp_idx]:
                    try:
                        ts_str = row[lock_timestamp_idx]
                        try:
                            ts = datetime.strptime(ts_str, '%m/%d/%Y - %I:%M:%S %p').timestamp()
                        except ValueError:
                            ts = float(ts_str)

                        if time.time() - ts < LOCK_TIMEOUT_SECONDS:
                            print(f"LOG: Found resumable paper for {annotator}. DOI: {row[doi_idx]}")
                            return {
                                "resumable": True, "doi": row[doi_idx],
                                "title": row[title_idx], "dataset": row[dataset_idx]
                            }
                    except (ValueError, TypeError):
                        continue
        
        return {"resumable": False}
    except Exception as e:
        print(f"ERROR: Could not check for resumable paper: {e}")
        return {"resumable": False}

@router.get("/get-next-paper")
def get_next_paper(dataset: str, annotator: str, pdf_required: bool = True, skip_doi: Optional[str] = None):
    print(f"\n--- LOG: GET_NEXT_PAPER for dataset '{dataset}' by '{annotator}' ---")
    if not state.worksheet:
        raise HTTPException(status_code=400, detail="No Google Sheet is currently connected.")
    if not annotator or annotator == 'unknown':
        raise HTTPException(status_code=400, detail="Annotator name must be set in Settings.")
    if dataset not in state.DATASET_QUEUES or not state.DATASET_QUEUES[dataset]:
        raise HTTPException(status_code=404, detail=f"Dataset '{dataset}' queue is empty or not loaded.")

    try:
        all_sheet_values = state.worksheet.get_all_values()
        headers = all_sheet_values[0] if all_sheet_values else []
        
        if not headers:
            headers = ['doi', 'title', 'dataset', 'annotator', 'lock_annotator', 'lock_timestamp']
            state.worksheet.update('A1', [headers])

        doi_col_idx = headers.index('doi')
        lock_annotator_col_idx = headers.index('lock_annotator')
        lock_timestamp_col_idx = headers.index('lock_timestamp')

        unavailable_dois = set(state.ANNOTATED_ITEMS)
        if skip_doi: unavailable_dois.add(skip_doi)
        
        for row in all_sheet_values[1:]:
            if len(row) > max(doi_col_idx, lock_annotator_col_idx, lock_timestamp_col_idx):
                doi = row[doi_col_idx]
                if doi and row[lock_annotator_col_idx].strip() != annotator and row[lock_timestamp_col_idx]:
                    try:
                        ts_str = row[lock_timestamp_col_idx]
                        try: ts = datetime.strptime(ts_str, '%m/%d/%Y - %I:%M:%S %p').timestamp()
                        except ValueError: ts = float(ts_str)
                        
                        if time.time() - ts < LOCK_TIMEOUT_SECONDS:
                            unavailable_dois.add(doi)
                    except (ValueError, TypeError): pass

        active_filter_dois = set(state.ACTIVE_FILTERS.get(dataset, {}).get("dois")) if dataset in state.ACTIVE_FILTERS else None

        candidate_paper_info = None
        for paper_info in state.DATASET_QUEUES[dataset]:
            doi = paper_info.get('doi')
            if doi in unavailable_dois: continue
            if active_filter_dois is not None and doi not in active_filter_dois: continue
            if pdf_required and not (paper_info.get('open_access_pdf') or "").startswith('http'): continue
            candidate_paper_info = paper_info
            break

        if not candidate_paper_info:
            raise HTTPException(status_code=404, detail="No available papers found in the queue.")

        candidate_doi = candidate_paper_info.get('doi')
        full_candidate_paper = get_paper_by_doi_from_file(state.AVAILABLE_DATASETS[dataset], candidate_doi)
        if not full_candidate_paper:
            raise HTTPException(status_code=500, detail=f"Could not retrieve full data for DOI {candidate_doi}.")

        try:
            cell = state.worksheet.find(candidate_doi, in_column=doi_col_idx + 1)
            if cell:
                state.worksheet.update_cell(cell.row, lock_annotator_col_idx + 1, annotator)
                state.worksheet.update_cell(cell.row, lock_timestamp_col_idx + 1, get_human_readable_timestamp())
            else:
                placeholder_row = {h: "" for h in headers}
                placeholder_row.update({
                    'doi': candidate_doi, 'title': full_candidate_paper.get('title', ''), 'dataset': dataset,
                    'lock_annotator': annotator, 'lock_timestamp': get_human_readable_timestamp()
                })
                state.worksheet.append_row([placeholder_row.get(h, "") for h in headers], value_input_option='USER_ENTERED')
            
            full_candidate_paper['lock_info'] = {"locked": True, "remaining_seconds": LOCK_TIMEOUT_SECONDS}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Could not acquire lock for paper in Google Sheet. Reason: {e}")

        # --- FIX: Corrected typo from INCOMEPLETE to INCOMPLETE ---
        if candidate_doi in state.INCOMPLETE_ANNOTATIONS:
            full_candidate_paper['existing_annotation'] = state.INCOMPLETE_ANNOTATIONS[candidate_doi]['data']
        
        return full_candidate_paper
    except (ValueError, APIError) as e:
        raise HTTPException(status_code=500, detail=f"A spreadsheet error occurred: {e}")

@router.post("/submit-annotation")
def submit_annotation(submission: AnnotationSubmission):
    """
    Submits an annotation to the Google Sheet.

    Args:
        submission (AnnotationSubmission): The annotation data to be submitted.

    Returns:
        dict: A JSON response containing the status of the submission and the DOI of the paper.

    Raises:
        HTTPException: If an error occurs while submitting the annotation to the Google Sheet.
    """
    print(f"LOG: Received annotation submission for DOI: {submission.doi} by annotator: {submission.annotator}")
    if not state.worksheet:
        raise HTTPException(status_code=400, detail="No Google Sheet is currently connected.")
        
    submitted_doi = submission.doi
    try:
        headers = state.worksheet.row_values(1)
        if not headers:
            headers = list(submission.annotations.keys())
            base_headers = ['doi', 'title', 'dataset', 'annotator']
            headers = base_headers + [h for h in headers if h not in base_headers]
            state.worksheet.update('A1', [headers])

        flat_submission = {"doi": submission.doi, "title": submission.title, "dataset": submission.dataset, "annotator": submission.annotator, **submission.annotations}
        
        new_headers = list(headers)
        has_new = False
        for key in flat_submission.keys():
            if key not in new_headers:
                new_headers.append(key)
                has_new = True
        if has_new:
            state.worksheet.update('A1', [new_headers])
            headers = new_headers

        cell = None
        try:
            doi_col_index = headers.index('doi') + 1
            cell = state.worksheet.find(submitted_doi, in_column=doi_col_index)
        except (ValueError, APIError):
            cell = None

        row_values = []
        for header in headers:
            value = flat_submission.get(header, "")
            if value is None:
                value = ""
            row_values.append(value)

        if cell:
            state.worksheet.update(f'A{cell.row}', [row_values], value_input_option='USER_ENTERED')
        else:
            state.worksheet.append_row(row_values, value_input_option='USER_ENTERED')

        clear_lock(submitted_doi)

        if submission.dataset in state.DATASET_QUEUES:
            state.DATASET_QUEUES[submission.dataset] = [p for p in state.DATASET_QUEUES[submission.dataset] if p.get('doi') != submitted_doi]
        
        state.ANNOTATED_ITEMS.add(submitted_doi)
        # --- FIX: Corrected typo from INCOMEPLETE to INCOMPLETE ---
        if submitted_doi in state.INCOMPLETE_ANNOTATIONS:
            del state.INCOMPLETE_ANNOTATIONS[submitted_doi]

        return {"status": "success", "doi": submitted_doi}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write to Google Sheet: {e}")

@router.get("/get-lock-status/{doi:path}")
def get_lock_status(doi: str):
    if not state.worksheet: return {"locked": False, "remaining_seconds": 0}
    try:
        headers = state.worksheet.row_values(1)
        if 'doi' not in headers or 'lock_timestamp' not in headers: return {"locked": False, "remaining_seconds": 0}
        
        doi_col_index = headers.index('doi') + 1
        lock_ts_col_index = headers.index('lock_timestamp') + 1
        
        cell = state.worksheet.find(doi, in_column=doi_col_index)
        if not cell: return {"locked": False, "remaining_seconds": 0}
        
        lock_timestamp_str = state.worksheet.cell(cell.row, lock_ts_col_index).value
        if not lock_timestamp_str: return {"locked": False, "remaining_seconds": 0}

        try:
            ts = datetime.strptime(lock_timestamp_str, '%m/%d/%Y - %I:%M:%S %p').timestamp()
        except ValueError:
            ts = float(lock_timestamp_str)

        elapsed_time = time.time() - ts
        if elapsed_time < LOCK_TIMEOUT_SECONDS:
            return {"locked": True, "remaining_seconds": int(LOCK_TIMEOUT_SECONDS - elapsed_time)}
        else:
            return {"locked": False, "remaining_seconds": 0}
    except (APIError, ValueError, IndexError):
        return {"locked": False, "remaining_seconds": 0}

@router.post("/skip-paper")
def skip_paper(request: SkipRequest):
    if not state.worksheet: raise HTTPException(status_code=400, detail="No Google Sheet is currently connected.")
    
    try:
        headers = state.worksheet.row_values(1)
        doi_col_idx = headers.index('doi') + 1
        annotator_col_idx = headers.index('annotator') + 1
        
        cell = state.worksheet.find(request.doi, in_column=doi_col_idx)
        if cell:
            annotator_val = state.worksheet.cell(cell.row, annotator_col_idx).value
            if not annotator_val or not annotator_val.strip():
                print(f"LOG: Deleting placeholder row {cell.row} for skipped DOI {request.doi}.")
                state.worksheet.delete_rows(cell.row)
            else:
                clear_lock(request.doi)
    except Exception as e:
        print(f"WARN: Could not process sheet row for skipped DOI {request.doi}. Reason: {e}")

    if request.dataset in state.DATASET_QUEUES and state.DATASET_QUEUES[request.dataset]:
        queue = state.DATASET_QUEUES[request.dataset]
        paper_to_move = next((p for i, p in enumerate(queue) if p.get('doi') == request.doi), None)
        if paper_to_move:
            queue.remove(paper_to_move)
            queue.append(paper_to_move)
            
    return {"status": "success", "skipped_doi": request.doi}

@router.get("/get-paper-by-doi")
def get_paper_by_doi(doi: str, dataset: str):
    if dataset not in state.AVAILABLE_DATASETS:
        raise HTTPException(status_code=404, detail=f"Dataset '{dataset}' not found.")
    
    paper_data = get_paper_by_doi_from_file(state.AVAILABLE_DATASETS[dataset], doi)
    
    if paper_data:
        paper_data['lock_info'] = get_lock_status(doi)
        # --- FIX: Corrected typo from INCOMEPLETE to INCOMPLETE ---
        if doi in state.INCOMPLETE_ANNOTATIONS:
            paper_data['existing_annotation'] = state.INCOMPLETE_ANNOTATIONS[doi]['data']
        return paper_data
    else:
        raise HTTPException(status_code=404, detail=f"Paper with DOI '{doi}' not found in dataset '{dataset}'.")
