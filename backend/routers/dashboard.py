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
import re

class SetLockRequest(BaseModel):
    doi: str
    annotator: str
    dataset: str

class CommentRequest(BaseModel):
    doi: str
    annotator: str
    comment: str

class ResolveReviewRequest(BaseModel):
    doi: str
    trigger_name: str
    reviewed_by: str
    resolution: str # e.g., "Confirmed Human", "Corrected to AI", or "Pending"
    reasoning: Optional[str]

def _get_reviews_worksheet():
    """Gets the 'Reviews' worksheet, returning None if it does not exist."""
    if not state.worksheet:
        print("WARN: Cannot get reviews worksheet, no main sheet connected.")
        return None
    try:
        ss = state.worksheet.spreadsheet
        return ss.worksheet("Reviews")
    except gspread.WorksheetNotFound:
        print("LOG: 'Reviews' worksheet not found, which is acceptable.")
        return None
    except Exception as e:
        print(f"ERROR: Could not get 'Reviews' worksheet: {e}")
        return None

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

_KNOWN_METADATA_FIELDS = {
    "annotator",
    "doi",
    "title",
    "abstract",
    "dataset",
    "lock_annotator",
    "lock_timestamp",
    "latest_comment",
    "status",
    "timestamp",
    "annotation_timestamp",
    "notes",
    "comment",
    "comments",
    "review_status",
    "reviewed_by",
    "reviewer_reasoning",
    "ai_summary",
    "ai_context",
    "ai_reasoning",
    "ai_model",
    "ai_timestamp",
    "ai_source",
    "pdf_url",
    "pdf_filename",
    "row_id",
    "id",
}
_METADATA_PREFIXES = ("lock_", "latest_", "ai_", "review_", "comment_", "system_", "bulk_", "generator_", "internal_", "metadata_", "sheet_", "pdf_")
_METADATA_SUFFIXES = ("_context", "_reasoning", "_timestamp", "_notes", "_note", "_comment", "_comments", "_history", "_url")


def _has_meaningful_value(value) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    if isinstance(value, (list, tuple, set, dict)):
        return len(value) > 0
    return True


def _record_has_submission(record: dict) -> bool:
    annotator_value = record.get("annotator")
    if _has_meaningful_value(annotator_value):
        return True
    annotator_value = record.get("Annotator")
    return _has_meaningful_value(annotator_value)


def _get_template_annotation_fields(headers):
    if not state.worksheet:
        return []
    try:
        spreadsheet_id = state.worksheet.spreadsheet.id
    except Exception:
        return []

    template = state.SHEET_TEMPLATES.get(spreadsheet_id)
    if not template:
        return []

    header_set = set(headers)
    fields = []
    for field in template.get("fields", []):
        field_id = field.get("id")
        if not field_id:
            continue
        if field_id in header_set:
            fields.append(field_id)
    return fields


def _infer_annotation_fields(headers):
    inferred = []
    for header in headers:
        if not header:
            continue
        normalized = header.strip().lower()
        if not normalized:
            continue
        if normalized in _KNOWN_METADATA_FIELDS:
            continue
        if any(normalized.startswith(prefix) for prefix in _METADATA_PREFIXES):
            continue
        if any(normalized.endswith(suffix) for suffix in _METADATA_SUFFIXES):
            continue
        inferred.append(header)
    return inferred


def _resolve_annotation_fields(headers):
    if not headers:
        return []
    from_template = _get_template_annotation_fields(headers)
    if from_template:
        return from_template
    return _infer_annotation_fields(headers)


def _calculate_annotation_completeness(records):
    if not records:
        return {
            "total": 0,
            "completed": 0,
            "incomplete": 0,
            "fields": [],
            "annotated_records": [],
            "incomplete_details": [],
            "dataset_annotation_counts": Counter(),
        }

    headers = list(records[0].keys())
    annotation_fields = _resolve_annotation_fields(headers)

    total = 0
    completed = 0
    incomplete = 0
    annotated_records = []
    incomplete_details = []
    dataset_annotation_counts = Counter()

    for record in records:
        if not _record_has_submission(record):
            continue
        annotated_records.append(record)
        total += 1

        dataset_value = (
            record.get("dataset")
            or record.get("Dataset")
            or getattr(state, "currentDataset", "")
        )
        if dataset_value:
            dataset_annotation_counts[dataset_value] += 1

        if not annotation_fields:
            completed += 1
            continue

        missing_fields = []
        for field in annotation_fields:
            value = record.get(field)
            if _has_meaningful_value(value):
                continue
            missing_fields.append(field)

        if not missing_fields:
            completed += 1
        else:
            incomplete += 1
            incomplete_details.append({
                "doi": record.get("doi") or record.get("DOI") or "",
                "title": record.get("title") or record.get("Title") or "",
                "annotator": record.get("annotator") or record.get("Annotator") or "",
                "dataset": dataset_value,
                "missing_fields": missing_fields,
            })

    return {
        "total": total,
        "completed": completed,
        "incomplete": incomplete,
        "fields": annotation_fields,
        "annotated_records": annotated_records,
        "incomplete_details": incomplete_details,
        "dataset_annotation_counts": dataset_annotation_counts,
    }


def _calculate_remaining_articles(dataset_annotation_counts: Counter):
    datasets_to_check = set(dataset_annotation_counts.keys())
    active_dataset = getattr(state, "currentDataset", None)
    if active_dataset:
        datasets_to_check.add(active_dataset)

    total_remaining = 0
    remaining_by_dataset = {}
    totals_by_dataset = {}

    for dataset_name in datasets_to_check:
        if not dataset_name:
            continue
        try:
            total_papers = len(get_papers_index(dataset_name))
        except Exception as e:
            print(f"WARN: Could not determine total papers for dataset '{dataset_name}': {e}")
            total_papers = 0

        annotated_count = dataset_annotation_counts.get(dataset_name, 0)
        remaining = max(total_papers - annotated_count, 0)
        totals_by_dataset[dataset_name] = total_papers
        remaining_by_dataset[dataset_name] = remaining
        total_remaining += remaining

    return {
        "total_remaining": total_remaining,
        "remaining_by_dataset": remaining_by_dataset,
        "totals_by_dataset": totals_by_dataset,
    }

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
    stats = _calculate_annotation_completeness(records)
    remaining_info = _calculate_remaining_articles(stats["dataset_annotation_counts"])
    return {
        "total_count": stats["total"],
        "completed_count": stats["completed"],
        "incomplete_count": stats["incomplete"],
        "remaining_count": remaining_info["total_remaining"],
    }

@router.get("/get-detailed-stats")
async def get_detailed_stats():
    records = _get_all_records()
    completeness = _calculate_annotation_completeness(records)
    annotated_records = completeness["annotated_records"]
    total_annotations = completeness["total"]
    remaining_info = _calculate_remaining_articles(completeness["dataset_annotation_counts"])

    if not annotated_records:
        return {
            "total_annotations": total_annotations,
            "completed_annotations": completeness["completed"],
            "incomplete_annotations": completeness["incomplete"],
            "overall_counts": {},
            "doc_type_distribution": {},
            "leaderboard": [],
            "dataset_stats": {},
            "incomplete_details": completeness["incomplete_details"],
            "annotation_fields": completeness.get("fields", []),
            "remaining_articles": remaining_info["total_remaining"],
            "remaining_by_dataset": remaining_info["remaining_by_dataset"],
            "dataset_totals": remaining_info["totals_by_dataset"],
        }

    overall_counts = {}
    doc_type_counts = Counter()
    annotator_counts = Counter()
    dataset_counts = Counter()

    headers = list(annotated_records[0].keys()) if annotated_records else (list(records[0].keys()) if records else [])
    boolean_fields = [h for h in headers if h.startswith("trigger_") and not h.endswith("_context")]
    ethics_boolean_fields = [h for h in headers if h.startswith("ethics_COI") and not h.endswith("_context")]
    ethics_fields = [
        h
        for h in headers
        if h.startswith("ethics_")
        and not h.endswith("_context")
        and h not in ethics_boolean_fields
    ]
    
    for record in annotated_records:
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
        
        dataset = record.get("Dataset") or record.get("dataset") or getattr(state, "currentDataset", "")
        if dataset:
            dataset_counts[dataset] += 1

    leaderboard = [{"annotator": a, "count": c} for a, c in annotator_counts.most_common()]
    overall_counts_serialized = {key: dict(counter) for key, counter in overall_counts.items()}
    dataset_stats_serialized = dict(dataset_counts)
    doc_type_distribution_serialized = dict(doc_type_counts)

    return {
        "total_annotations": total_annotations,
        "completed_annotations": completeness["completed"],
        "incomplete_annotations": completeness["incomplete"],
        "overall_counts": overall_counts_serialized,
        "doc_type_distribution": doc_type_distribution_serialized,
        "leaderboard": leaderboard,
        "dataset_stats": dataset_stats_serialized,
        "incomplete_details": completeness["incomplete_details"],
        "annotation_fields": completeness.get("fields", []),
        "remaining_articles": remaining_info["total_remaining"],
        "remaining_by_dataset": remaining_info["remaining_by_dataset"],
        "dataset_totals": remaining_info["totals_by_dataset"],
    }

@router.get("/api/reviews")
async def get_reviews_data():
    """Fetches ALL review items from the 'Reviews' worksheet."""
    reviews_ws = _get_reviews_worksheet()
    if not reviews_ws:
        return {"rows": []}
    
    try:
        review_records = reviews_ws.get_all_records()

        # Build a lookup of the latest sheet values by DOI for quick comparisons.
        sheet_records = _get_all_records()
        sheet_lookup = {}
        for record in sheet_records:
            doi_value = _extract_doi(record)
            normalized_doi = _normalize_doi(doi_value)
            if normalized_doi and normalized_doi not in sheet_lookup:
                normalized_map = {}
                for header, value in record.items():
                    norm_key = _normalize_header_key(header)
                    if norm_key and norm_key not in normalized_map:
                        normalized_map[norm_key] = value
                entry = {
                    "raw": record,
                    "normalized": normalized_map
                }
                sheet_lookup[normalized_doi] = entry
                if doi_value:
                    sheet_lookup[str(doi_value).strip()] = entry
                    sheet_lookup[str(doi_value).strip().lower()] = entry

        for record in review_records:
            doi_value = record.get("DOI") or record.get("doi")
            normalized_doi = _normalize_doi(doi_value)
            trigger_name = record.get("Trigger_Name")
            current_value = None
            matches_ai = None
            located_field = None
            status_reason = "row_not_found"

            if normalized_doi and trigger_name:
                sheet_entry = (
                    sheet_lookup.get(normalized_doi)
                    or sheet_lookup.get(str(doi_value).strip() if doi_value else None)
                    or sheet_lookup.get(str(doi_value).strip().lower() if doi_value else None)
                )
                if sheet_entry is None:
                    for candidate_record in sheet_records:
                        candidate_doi = _extract_doi(candidate_record)
                        if _normalize_doi(candidate_doi) == normalized_doi:
                            normalized_map = {}
                            for header, value in candidate_record.items():
                                norm_key = _normalize_header_key(header)
                                if norm_key and norm_key not in normalized_map:
                                    normalized_map[norm_key] = value
                            sheet_entry = {
                                "raw": candidate_record,
                                "normalized": normalized_map,
                            }
                            sheet_lookup[normalized_doi] = sheet_entry
                            break
                if sheet_entry is not None:
                    raw_row = sheet_entry["raw"]
                    normalized_row = sheet_entry["normalized"]
                    status_reason = "column_not_found"
                    candidate_headers = []
                    for key in (
                        "Label_Field",
                        "Label_Column",
                        "Field_Name",
                        "Field_Id",
                        "Field_ID",
                        "Target_Field",
                        "Target_Column",
                    ):
                        value = record.get(key)
                        if value:
                            candidate_headers.append(value)

                    for dynamic_key, dynamic_value in record.items():
                        if (
                            isinstance(dynamic_key, str)
                            and dynamic_value
                            and dynamic_key.endswith(("_Field", "_Column"))
                            and dynamic_value not in candidate_headers
                        ):
                            candidate_headers.append(dynamic_value)

                    candidate_headers.extend(
                        [
                            "Human_Label",
                            "human_label",
                            "Human Label",
                            trigger_name,
                        ]
                    )

                    if trigger_name:
                        trigger_base = str(trigger_name).strip()
                        trigger_lower = trigger_base.lower()
                        trigger_no_space = trigger_lower.replace(" ", "_")
                        trigger_no_dash = trigger_no_space.replace("-", "_")
                        trigger_variants = {
                            trigger_base,
                            trigger_lower,
                            trigger_no_space,
                            trigger_no_dash,
                            f"trigger_{trigger_base}",
                            f"trigger_{trigger_lower}",
                            f"trigger_{trigger_no_space}",
                            f"trigger_{trigger_no_dash}",
                            f"Trigger_{trigger_base}",
                            f"Trigger_{trigger_lower}",
                            f"Trigger_{trigger_no_space}",
                            f"Trigger_{trigger_no_dash}",
                        }
                        candidate_headers.extend([v for v in trigger_variants if v])

                    candidate_headers.extend(
                        _candidate_columns_from_trigger(trigger_name)
                    )

                    seen_candidates = set()
                    deduped_candidates = []
                    for cand in candidate_headers:
                        if cand and cand not in seen_candidates:
                            deduped_candidates.append(cand)
                            seen_candidates.add(cand)
                    candidate_headers = deduped_candidates

                    for candidate in candidate_headers:
                        if not candidate:
                            continue
                        candidate_str = str(candidate).strip()
                        if not candidate_str:
                            continue
                        if candidate_str in raw_row:
                            current_value = raw_row.get(candidate_str)
                            located_field = candidate_str
                        else:
                            norm_key = _normalize_header_key(candidate_str)
                            if norm_key and norm_key in normalized_row:
                                current_value = normalized_row[norm_key]
                                located_field = _first_header_with_norm(raw_row, norm_key) or candidate_str
                        if current_value is not None:
                            break

                    if current_value is None:
                        norm_trigger = _normalize_header_key(trigger_name)
                        if norm_trigger and norm_trigger in normalized_row:
                            current_value = normalized_row[norm_trigger]
                            located_field = next(
                                (hdr for hdr in raw_row.keys() if _normalize_header_key(hdr) == norm_trigger),
                                trigger_name,
                            )
                    if current_value is None and trigger_name:
                        norm_trigger = _normalize_header_key(trigger_name)
                        if norm_trigger:
                            for header, value in raw_row.items():
                                if _normalize_header_key(header) == norm_trigger:
                                    current_value = value
                                    located_field = header
                                    break
                    if current_value is None and trigger_name:
                        norm_trigger = _normalize_header_key(trigger_name)
                        if norm_trigger:
                            for header, value in raw_row.items():
                                header_norm = _normalize_header_key(header)
                                if header_norm and norm_trigger in header_norm:
                                    current_value = value
                                    located_field = header
                                    break

                    if current_value is not None:
                        ai_label = record.get("AI_Label")
                        current_value_stripped = str(current_value).strip()
                        if ai_label is None:
                            matches_ai = None
                        else:
                            ai_label_stripped = str(ai_label).strip()
                            matches_ai = current_value_stripped.lower() == ai_label_stripped.lower()
                        status_reason = "ok"
                    else:
                        matches_ai = None
                        if located_field:
                            status_reason = "column_blank"
                        else:
                            status_reason = "column_not_found"
                            located_field = trigger_name or located_field

            record["Current_Label"] = current_value
            record["Current_Label_Field"] = located_field
            record["Label_Matches_AI"] = matches_ai
            record["Label_Check_Status"] = status_reason

        return {"rows": review_records}  # Send everything to the frontend
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to retrieve reviews: {e}")

@router.post("/api/reviews/resolve")
async def resolve_review_item(request: ResolveReviewRequest):
    reviews_ws = _get_reviews_worksheet()
    if not reviews_ws:
        raise HTTPException(status_code=404, detail="Reviews worksheet not found.")

    try:
        all_values = reviews_ws.get_all_values()
        if not all_values:
            raise HTTPException(status_code=404, detail="Review item not found.")

        headers = all_values[0]
        records_data = all_values[1:]

        doi_col_idx = headers.index("DOI")
        trigger_col_idx = headers.index("Trigger_Name")
        status_col_idx = headers.index("Review_Status") + 1
        reviewer_col_idx = headers.index("Reviewed_By") + 1
        reasoning_col_idx = headers.index("Reviewer_Reasoning") + 1

        for i, record_row in enumerate(records_data):
            if record_row[doi_col_idx] == request.doi and record_row[trigger_col_idx] == request.trigger_name:
                row_to_update = i + 2
                
                updates = []
                # CORRECTED: Use gspread.utils to get A1 notation for the range
                status_range = gspread.utils.rowcol_to_a1(row_to_update, status_col_idx)
                reviewer_range = gspread.utils.rowcol_to_a1(row_to_update, reviewer_col_idx)
                
                updates.append({'range': status_range, 'values': [[request.resolution]]})
                updates.append({'range': reviewer_range, 'values': [[request.reviewed_by]]})

                if request.reasoning is not None:
                    reasoning_range = gspread.utils.rowcol_to_a1(row_to_update, reasoning_col_idx)
                    updates.append({'range': reasoning_range, 'values': [[request.reasoning]]})
                
                if updates:
                    reviews_ws.batch_update(updates, value_input_option='USER_ENTERED')
                
                return {"status": "success", "message": "Review status updated."}
        
        raise HTTPException(status_code=404, detail="Review item not found.")
    except (ValueError, IndexError) as e:
        raise HTTPException(status_code=500, detail=f"Sheet format error. Did you add the 'Reviewer_Reasoning' column? Error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update review status: {e}")


def _normalize_header_key(key: Optional[str]) -> str:
    if key is None:
        return ""
    return re.sub(r"[^a-z0-9]+", "", str(key).lower())


def _first_header_with_norm(row: dict, normalized_key: str) -> Optional[str]:
    for header in row.keys():
        if _normalize_header_key(header) == normalized_key:
            return header
    return None


def _candidate_columns_from_trigger(trigger_name: Optional[str]) -> list[str]:
    if not trigger_name:
        return []

    base = trigger_name.strip()
    if not base:
        return []

    candidates = []
    lower = base.lower()

    keyword_map = [
        ("human", "trigger_humans"),
        ("animal", "trigger_animals"),
        ("experimental", "trigger_experimental"),
        ("experiment", "trigger_experimental"),
        ("intervention", "trigger_experimental"),
        ("personal", "trigger_PersonalSensitiveData"),
        ("sensitive", "trigger_PersonalSensitiveData"),
        ("data", "trigger_PersonalSensitiveData"),
    ]
    for keyword, column in keyword_map:
        if keyword in lower:
            candidates.append(column)

    tokens = re.findall(r"[a-z0-9]+", lower)
    if tokens:
        underscore = "_".join(tokens)
        camel = "".join(token.capitalize() for token in tokens)
        candidates.append(f"trigger_{underscore}")
        candidates.append(f"trigger_{camel}")

    candidates.append(f"trigger_{lower}")

    # Remove duplicates while preserving order
    seen = set()
    ordered = []
    for cand in candidates:
        if cand and cand not in seen:
            ordered.append(cand)
            seen.add(cand)
    return ordered


def _normalize_doi(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if not normalized:
        return None
    prefixes = [
        "https://doi.org/",
        "http://doi.org/",
        "doi:",
        "doi.org/",
    ]
    for prefix in prefixes:
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix):]
    normalized = normalized.strip()
    return normalized or None


def _extract_doi(record: dict) -> Optional[str]:
    if not record:
        return None
    for key, value in record.items():
        norm_key = _normalize_header_key(key)
        if norm_key.endswith("doi") or "doi" in norm_key:
            if value:
                return str(value).strip()
    return None
