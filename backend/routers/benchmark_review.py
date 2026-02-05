# backend/routers/benchmark_review.py
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import gspread
import gspread.utils
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from collections import Counter, defaultdict

from app_state import state
from config import DATA_DIR

router = APIRouter()


REVIEW_FILE = DATA_DIR / "review" / "benchmark_predictions.jsonl"
BENCHMARK_REVIEW_SHEET = "benchmark_review"

# A single, shared sheet that stores:
# - One row per incorrect prediction (doi + trigger_name)
# - Latest review + review history for that row
IDEAL_BENCHMARK_REVIEW_HEADERS = [
    "doi",
    "dataset",
    "doc_type",
    "trigger_name",
    "human_label",
    "model_label",
    "model_label_raw",
    "reasoning",
    "component_reasoning",
    "benchmark",
    "prediction_timestamp",
    "duration",
    "chunk_key",
    "chunk_start",
    "evidence_preview",
    "evidence_chunks_json",
    "chunk_count",
    "review_count",
    "reviewed_at_utc",
    "reviewed_by",
    "reason_codes_json",
    "comment",
    "review_history_json",
    "upload_filename",
    "upload_uploaded_at_utc",
    "upload_uploaded_by",
    "upload_source_mtime_utc",
]

MAX_CELL_CHARS = 45000


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_str(value: Any) -> str:
    if value is None:
        return ""
    text = str(value)
    return text


def _normalize_reason_codes(raw: Any) -> List[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.split(",")]
        return [p for p in parts if p]
    if isinstance(raw, list):
        out: List[str] = []
        for item in raw:
            text = str(item or "").strip()
            if text:
                out.append(text)
        return out
    return []


def _normalize_evidence_chunks(raw: Any) -> List[Dict[str, Any]]:
    if not raw:
        return []
    if not isinstance(raw, list):
        return [{"text": _safe_str(raw)}]

    normalized: List[Dict[str, Any]] = []
    for item in raw:
        if isinstance(item, dict):
            text = (
                item.get("chunk_text")
                or item.get("text")
                or item.get("content")
                or item.get("chunk")
                or ""
            )
            normalized.append(
                {
                    "score": item.get("score"),
                    "section": item.get("section"),
                    "char_start": item.get("char_start"),
                    "char_end": item.get("char_end"),
                    "text": _safe_str(text),
                }
            )
        else:
            normalized.append({"text": _safe_str(item)})
    return normalized


def _normalize_incorrect_item(trigger_name: str, ev: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "trigger_name": trigger_name,
        "human_label": ev.get("human_label"),
        "model_label": ev.get("model_label") if ev.get("model_label") is not None else ev.get("label"),
        "model_label_raw": ev.get("label_raw"),
        "reasoning": ev.get("reasoning"),
        "component_reasoning": ev.get("component_reasoning"),
        "benchmark": ev.get("benchmark"),
        "timestamp": ev.get("timestamp"),
        "duration": ev.get("duration"),
        "chunk_key": ev.get("chunk_key"),
        "chunk_start": ev.get("chunk_start"),
        "evidence_preview": ev.get("evidence_preview"),
        "evidence_chunks": _normalize_evidence_chunks(ev.get("evidence_chunks")),
    }


@dataclass(frozen=True)
class _BenchmarkCache:
    mtime: float
    queue: List[Dict[str, Any]]
    by_doi: Dict[str, Dict[str, Any]]
    incorrect_item_count: int
    source: Dict[str, Any]


_BENCHMARK_CACHE: Optional[_BenchmarkCache] = None


def _truncate_cell(value: Any, limit: int = MAX_CELL_CHARS) -> str:
    text = _safe_str(value)
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def _get_worksheet_if_exists(title: str) -> Optional[gspread.Worksheet]:
    if not state.worksheet:
        return None
    try:
        ss = state.worksheet.spreadsheet
        return ss.worksheet(title)
    except gspread.WorksheetNotFound:
        return None
    except Exception:
        return None


def _safe_int(value: Any) -> int:
    try:
        return int(str(value).strip())
    except Exception:
        return 0


def _safe_json_dumps(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return "[]"


def _parse_json(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (list, dict)):
        return value
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        return None


def _parse_evidence_chunks_from_cell(value: Any) -> List[Dict[str, Any]]:
    parsed = _parse_json(value)
    return _normalize_evidence_chunks(parsed)


def _parse_review_history_from_cell(value: Any) -> List[Dict[str, Any]]:
    parsed = _parse_json(value)
    if isinstance(parsed, list):
        out: List[Dict[str, Any]] = []
        for item in parsed:
            if isinstance(item, dict):
                out.append(item)
        return out
    return []


def _normalize_cell_value(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (dict, list)):
        return _truncate_cell(json.dumps(value, ensure_ascii=False))
    if isinstance(value, (int, float)):
        return value
    return _truncate_cell(str(value))


def _build_cache_from_review_sheet_rows(
    rows: List[Dict[str, Any]],
    source: Dict[str, Any],
    cache_key: float,
) -> _BenchmarkCache:
    by_doi: Dict[str, Dict[str, Any]] = {}
    queue_tmp: Dict[str, Dict[str, Any]] = {}
    incorrect_item_count = 0

    for row in rows or []:
        doi = str(row.get("doi") or "").strip()
        if not doi:
            continue
        trigger_name = str(row.get("trigger_name") or "").strip()
        if not trigger_name:
            continue

        payload = by_doi.setdefault(
            doi,
            {
                "doi": doi,
                "dataset": row.get("dataset"),
                "doc_type": row.get("doc_type"),
                "summary": {},
                "incorrect": [],
                "incorrect_count": 0,
            },
        )

        incorrect_item_count += 1
        item = {
            "trigger_name": trigger_name,
            "human_label": row.get("human_label"),
            "model_label": row.get("model_label"),
            "model_label_raw": row.get("model_label_raw"),
            "reasoning": row.get("reasoning"),
            "component_reasoning": row.get("component_reasoning"),
            "benchmark": row.get("benchmark"),
            "timestamp": row.get("prediction_timestamp"),
            "duration": row.get("duration"),
            "chunk_key": row.get("chunk_key"),
            "chunk_start": row.get("chunk_start"),
            "evidence_preview": row.get("evidence_preview"),
            "evidence_chunks": _parse_evidence_chunks_from_cell(
                row.get("evidence_chunks_json")
            ),
            "review_count": _safe_int(row.get("review_count")),
            "reviewed_at_utc": row.get("reviewed_at_utc"),
            "reviewed_by": row.get("reviewed_by"),
            "reason_codes_json": row.get("reason_codes_json"),
            "comment": row.get("comment"),
        }
        payload["incorrect"].append(item)
        payload["incorrect_count"] = int(payload["incorrect_count"] or 0) + 1

        queue_item = queue_tmp.setdefault(
            doi,
            {
                "doi": doi,
                "dataset": row.get("dataset"),
                "doc_type": row.get("doc_type"),
                "incorrect_count": 0,
                "accuracy": None,
                "reviewed_field_count": 0,
                "submission_count": 0,
            },
        )
        queue_item["incorrect_count"] = int(queue_item["incorrect_count"] or 0) + 1
        review_count = _safe_int(row.get("review_count"))
        if review_count > 0:
            queue_item["reviewed_field_count"] = int(
                queue_item.get("reviewed_field_count") or 0
            ) + 1
            queue_item["submission_count"] = int(
                queue_item.get("submission_count") or 0
            ) + review_count

    queue = list(queue_tmp.values())
    queue.sort(
        key=lambda item: (
            -int(item.get("incorrect_count") or 0),
            str(item.get("doi") or ""),
        )
    )

    return _BenchmarkCache(
        mtime=cache_key,
        queue=queue,
        by_doi=by_doi,
        incorrect_item_count=incorrect_item_count,
        source=source,
    )


def _load_benchmark_from_review_sheet() -> Optional[_BenchmarkCache]:
    if not state.worksheet:
        return None
    ws = _get_worksheet_if_exists(BENCHMARK_REVIEW_SHEET)
    if not ws:
        return None
    try:
        headers = ws.row_values(1)
    except Exception:
        headers = []

    header_set = {str(h or "").strip() for h in headers}
    if not {"doi", "trigger_name", "model_label"}.issubset(header_set):
        # This may be an old submissions-only sheet; not a prediction table source.
        return None

    try:
        rows = ws.get_all_records()
    except Exception as e:
        raise HTTPException(
            status_code=502, detail=f"Failed reading benchmark_review sheet: {e}"
        )

    uploaded_at = ""
    if rows:
        uploaded_at = str(rows[0].get("upload_uploaded_at_utc") or "").strip()
    cache_key = float(ws.id)
    if uploaded_at:
        try:
            cache_key = datetime.fromisoformat(uploaded_at.replace("Z", "+00:00")).timestamp()
        except Exception:
            pass

    source = {
        "type": "sheet",
        "sheet": BENCHMARK_REVIEW_SHEET,
        "uploaded_at_utc": uploaded_at,
    }
    return _build_cache_from_review_sheet_rows(
        rows=rows or [],
        source=source,
        cache_key=cache_key,
    )


def _load_benchmark_from_file() -> Optional[_BenchmarkCache]:
    if not REVIEW_FILE.exists():
        return None

    mtime = REVIEW_FILE.stat().st_mtime
    by_doi: Dict[str, Dict[str, Any]] = {}
    queue: List[Dict[str, Any]] = []
    incorrect_item_count = 0

    with REVIEW_FILE.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except Exception:
                continue

            doi = str(record.get("doi") or "").strip()
            if not doi:
                continue

            evaluations = record.get("evaluations") or {}
            if not isinstance(evaluations, dict):
                continue

            incorrect: List[Dict[str, Any]] = []
            for trigger_name, ev in evaluations.items():
                if not isinstance(ev, dict):
                    continue
                if ev.get("is_correct") is False:
                    incorrect.append(_normalize_incorrect_item(str(trigger_name), ev))

            if not incorrect:
                continue

            incorrect_item_count += len(incorrect)
            dataset = record.get("dataset")
            doc_type = record.get("doc_type")
            summary = (
                record.get("summary") if isinstance(record.get("summary"), dict) else {}
            )
            accuracy = summary.get("accuracy")

            doi_payload = {
                "doi": doi,
                "dataset": dataset,
                "doc_type": doc_type,
                "summary": summary,
                "incorrect": incorrect,
                "incorrect_count": len(incorrect),
            }
            by_doi[doi] = doi_payload
            queue.append(
                {
                    "doi": doi,
                    "dataset": dataset,
                    "doc_type": doc_type,
                    "incorrect_count": len(incorrect),
                    "accuracy": accuracy,
                }
            )

    queue.sort(
        key=lambda item: (-int(item.get("incorrect_count") or 0), str(item.get("doi") or ""))
    )

    return _BenchmarkCache(
        mtime=mtime,
        queue=queue,
        by_doi=by_doi,
        incorrect_item_count=incorrect_item_count,
        source={"type": "file", "file": str(REVIEW_FILE), "mtime": mtime},
    )


def _load_benchmark_cache() -> _BenchmarkCache:
    global _BENCHMARK_CACHE

    # Prefer sheet source when available so the data is shared via the spreadsheet.
    sheet_cache = _load_benchmark_from_review_sheet()
    if sheet_cache:
        if _BENCHMARK_CACHE and _BENCHMARK_CACHE.mtime == sheet_cache.mtime:
            return _BENCHMARK_CACHE
        _BENCHMARK_CACHE = sheet_cache
        return sheet_cache

    file_cache = _load_benchmark_from_file()
    if file_cache:
        if _BENCHMARK_CACHE and _BENCHMARK_CACHE.mtime == file_cache.mtime:
            return _BENCHMARK_CACHE
        _BENCHMARK_CACHE = file_cache
        return file_cache

    raise HTTPException(
        status_code=404,
        detail=(
            f"No benchmark review source found. Upload a jsonl file to the spreadsheet, "
            f"or ensure {REVIEW_FILE} exists on the server."
        ),
    )


def _get_or_create_worksheet(
    title: str, ideal_headers: List[str]
) -> Tuple[Optional[gspread.Worksheet], List[str]]:
    if not state.worksheet:
        return None, ideal_headers
    try:
        ss = state.worksheet.spreadsheet
    except Exception:
        return None, ideal_headers

    try:
        ws = ss.worksheet(title)
    except gspread.WorksheetNotFound:
        ws = ss.add_worksheet(title=title, rows="1", cols=str(max(10, len(ideal_headers))))
    except Exception:
        return None, ideal_headers

    try:
        existing_headers = ws.row_values(1)
    except Exception:
        existing_headers = []

    if not existing_headers:
        try:
            ws.update("A1", [ideal_headers], value_input_option="USER_ENTERED")
        except Exception:
            return ws, ideal_headers
        return ws, ideal_headers

    missing = [h for h in ideal_headers if h not in existing_headers]
    if missing:
        try:
            ws.add_cols(len(missing))
            start_cell = gspread.utils.rowcol_to_a1(1, len(existing_headers) + 1)
            ws.update(start_cell, [missing], value_input_option="USER_ENTERED")
            existing_headers = existing_headers + missing
        except Exception:
            pass
    return ws, existing_headers


def _reset_worksheet(ws: gspread.Worksheet, headers: List[str]) -> None:
    ws.clear()
    ws.update("A1", [headers], value_input_option="USER_ENTERED")


def _is_benchmark_review_table(headers: List[str]) -> bool:
    header_set = {str(h or "").strip() for h in headers}
    return {"doi", "trigger_name", "model_label"}.issubset(header_set)


def _read_benchmark_review_sheet_rows() -> Tuple[List[str], List[Dict[str, Any]]]:
    ws = _get_worksheet_if_exists(BENCHMARK_REVIEW_SHEET)
    if not ws:
        return [], []
    try:
        headers = ws.row_values(1)
    except Exception:
        headers = []
    try:
        rows = ws.get_all_records()
    except Exception:
        rows = []
    return headers, rows or []


def _history_entries_from_table_row(row: Dict[str, Any]) -> List[Dict[str, Any]]:
    doi = str(row.get("doi") or "").strip()
    trigger_name = str(row.get("trigger_name") or "").strip()
    history = _parse_review_history_from_cell(row.get("review_history_json"))
    if history:
        out: List[Dict[str, Any]] = []
        for entry in history:
            out.append(
                {
                    "timestamp_utc": entry.get("timestamp_utc")
                    or entry.get("timestamp")
                    or "",
                    "reviewed_by": entry.get("reviewed_by") or "",
                    "doi": doi,
                    "trigger_name": trigger_name,
                    "reason_codes_json": _safe_json_dumps(
                        _normalize_reason_codes(entry.get("reason_codes"))
                        or _normalize_reason_codes(entry.get("reason_codes_json"))
                    ),
                    "comment": entry.get("comment") or "",
                }
            )
        return out

    # Fallback for older rows that store only the latest review fields.
    review_count = _safe_int(row.get("review_count"))
    reason_codes = row.get("reason_codes_json")
    reviewed_at = row.get("reviewed_at_utc") or row.get("timestamp_utc") or ""
    reviewed_by = row.get("reviewed_by") or row.get("reviewed_by") or ""
    comment = row.get("comment") or ""

    if review_count > 0 or (isinstance(reason_codes, str) and reason_codes.strip()):
        return [
            {
                "timestamp_utc": reviewed_at,
                "reviewed_by": reviewed_by,
                "doi": doi,
                "trigger_name": trigger_name,
                "reason_codes_json": str(reason_codes or "[]"),
                "comment": comment,
            }
        ]
    return []


def _summarize_review_entries(entries: List[Dict[str, Any]]) -> Dict[str, Any]:
    reason_counts: Dict[str, int] = {}
    reviewer_counts: Dict[str, int] = {}
    reviewed_dois: set = set()
    reviewed_fields: set = set()

    for entry in entries:
        doi = str(entry.get("doi") or "").strip()
        trigger = str(entry.get("trigger_name") or "").strip()
        if doi:
            reviewed_dois.add(doi)
        if doi and trigger:
            reviewed_fields.add((doi, trigger))

        reviewer = str(entry.get("reviewed_by") or "").strip() or "unknown"
        reviewer_counts[reviewer] = reviewer_counts.get(reviewer, 0) + 1

        raw_codes = entry.get("reason_codes_json")
        codes: List[str] = []
        if isinstance(raw_codes, str) and raw_codes.strip():
            try:
                codes = _normalize_reason_codes(json.loads(raw_codes))
            except Exception:
                codes = _normalize_reason_codes(raw_codes)
        for code in codes:
            reason_counts[code] = reason_counts.get(code, 0) + 1

    return {
        "total_submissions": len(entries),
        "unique_dois_reviewed": len(reviewed_dois),
        "unique_fields_reviewed": len(reviewed_fields),
        "reason_counts": reason_counts,
        "reviewer_counts": reviewer_counts,
    }


def _bucket_incorrect_count(value: int) -> str:
    if value <= 0:
        return "0"
    if value == 1:
        return "1"
    if value == 2:
        return "2"
    if value <= 5:
        return "3-5"
    if value <= 10:
        return "6-10"
    return "11+"


class SubmitBenchmarkReviewRequest(BaseModel):
    doi: str
    trigger_name: str
    reason_codes: List[str] = Field(default_factory=list)
    comment: str = ""
    reviewed_by: str = "unknown"


class SubmitBenchmarkReviewBulkRequest(BaseModel):
    doi: str
    reason_codes: List[str] = Field(default_factory=list)
    comment: str = ""
    reviewed_by: str = "unknown"
    trigger_names: Optional[List[str]] = None


@router.get("/api/benchmark-reviews/overview")
async def get_benchmark_reviews_overview():
    try:
        cache = _load_benchmark_cache()
    except HTTPException as e:
        if e.status_code != 404:
            raise
        # Allow the Reviews page to load even before a jsonl has been uploaded.
        return {
            "sheet_connected": bool(state.worksheet),
            "source": {"type": "none", "detail": e.detail},
            "queue": [],
            "stats": {
                "total_submissions": 0,
                "unique_dois_reviewed": 0,
                "unique_fields_reviewed": 0,
                "reason_counts": {},
                "reviewer_counts": {},
                "queue_dois": 0,
                "remaining_dois": 0,
            },
            "recent_submissions": [],
        }
    headers, sheet_rows = _read_benchmark_review_sheet_rows()

    review_entries: List[Dict[str, Any]] = []
    uploaded_at = ""
    if _is_benchmark_review_table(headers) and sheet_rows:
        uploaded_at = str(sheet_rows[0].get("upload_uploaded_at_utc") or "").strip()
        for row in sheet_rows:
            review_entries.extend(_history_entries_from_table_row(row))

    submission_summary = _summarize_review_entries(review_entries)
    review_entries_sorted = sorted(
        review_entries,
        key=lambda e: str(e.get("timestamp_utc") or ""),
    )

    # Build per-DOI review reason summaries for UI exploration/filtering.
    doi_reason_counts: Dict[str, Counter] = defaultdict(Counter)
    doi_reason_codes: Dict[str, set] = defaultdict(set)
    reason_doi_set: Dict[str, set] = defaultdict(set)
    for entry in review_entries:
        doi = str(entry.get("doi") or "").strip()
        if not doi:
            continue
        raw_codes = entry.get("reason_codes_json")
        codes: List[str] = []
        if isinstance(raw_codes, str) and raw_codes.strip():
            try:
                codes = _normalize_reason_codes(json.loads(raw_codes))
            except Exception:
                codes = _normalize_reason_codes(raw_codes)
        for code in codes:
            doi_reason_counts[doi][code] += 1
            doi_reason_codes[doi].add(code)
            reason_doi_set[code].add(doi)

    # Build per-DOI incorrect trigger summaries.
    trigger_incorrect_counts: Counter = Counter()
    trigger_doi_set: Dict[str, set] = defaultdict(set)
    doi_trigger_names: Dict[str, List[str]] = {}
    for doi, payload in (cache.by_doi or {}).items():
        triggers = []
        for item in payload.get("incorrect") or []:
            trig = str(item.get("trigger_name") or "").strip()
            if not trig:
                continue
            triggers.append(trig)
            trigger_incorrect_counts[trig] += 1
            trigger_doi_set[trig].add(doi)
        # Preserve order but de-dup
        seen = set()
        unique_triggers = []
        for trig in triggers:
            if trig in seen:
                continue
            seen.add(trig)
            unique_triggers.append(trig)
        doi_trigger_names[doi] = unique_triggers

    explore_reasons = [
        {
            "reason": reason,
            "submission_count": count,
            "doi_count": len(reason_doi_set.get(reason, set())),
        }
        for reason, count in Counter(
            submission_summary.get("reason_counts") or {}
        ).most_common()
    ]
    explore_triggers = [
        {
            "trigger_name": trig,
            "incorrect_count": int(count),
            "doi_count": len(trigger_doi_set.get(trig, set())),
        }
        for trig, count in trigger_incorrect_counts.most_common()
    ]

    queue: List[Dict[str, Any]] = []
    for item in cache.queue:
        incorrect_count = int(item.get("incorrect_count") or 0)
        reviewed_field_count = int(item.get("reviewed_field_count") or 0)
        submission_count = int(item.get("submission_count") or 0)
        doi = str(item.get("doi") or "").strip()
        top_reasons = [
            {"reason": reason, "count": int(count)}
            for reason, count in doi_reason_counts.get(doi, Counter()).most_common(2)
        ]
        queue.append(
            {
                **item,
                "reviewed_field_count": reviewed_field_count,
                "submission_count": submission_count,
                "reason_codes": sorted(list(doi_reason_codes.get(doi, set()))),
                "top_reasons": top_reasons,
                "trigger_names": doi_trigger_names.get(doi, []),
                "fully_reviewed": incorrect_count > 0
                and reviewed_field_count >= incorrect_count,
            }
        )

    remaining = [q for q in queue if not q.get("fully_reviewed")]
    incorrect_distribution: Dict[str, int] = {}
    for q in queue:
        bucket = _bucket_incorrect_count(int(q.get("incorrect_count") or 0))
        incorrect_distribution[bucket] = incorrect_distribution.get(bucket, 0) + 1

    return {
        "sheet_connected": bool(state.worksheet),
        "source": {
            **(cache.source or {}),
            "file": cache.source.get("file")
            if isinstance(cache.source, dict)
            else str(REVIEW_FILE),
            "mtime": cache.mtime,
            "uploaded_at_utc": uploaded_at or (cache.source or {}).get("uploaded_at_utc"),
            "doi_count_with_incorrect": len(cache.queue),
            "incorrect_item_count": cache.incorrect_item_count,
        },
        "queue": queue,
        "stats": {
            **submission_summary,
            "queue_dois": len(queue),
            "remaining_dois": len(remaining),
            "incorrect_distribution": incorrect_distribution,
        },
        "explore": {
            "reasons": explore_reasons[:50],
            "triggers": explore_triggers[:50],
        },
        "recent_submissions": review_entries_sorted[-50:],
    }


@router.get("/api/benchmark-reviews/doi/{doi:path}")
async def get_benchmark_reviews_for_doi(doi: str):
    cache = _load_benchmark_cache()
    key = str(doi).strip()
    payload = cache.by_doi.get(key)
    if not payload:
        raise HTTPException(status_code=404, detail="DOI not found in benchmark review file.")
    return payload


@router.get("/api/benchmark-reviews/submissions")
async def get_benchmark_review_submissions(
    doi: Optional[str] = Query(default=None),
    trigger_name: Optional[str] = Query(default=None),
):
    headers, sheet_rows = _read_benchmark_review_sheet_rows()
    doi_key = str(doi).strip() if doi else None
    trigger_key = str(trigger_name).strip() if trigger_name else None

    if not sheet_rows:
        return {"rows": []}

    if not _is_benchmark_review_table(headers):
        # Legacy behavior: rows are already review submissions.
        rows = sheet_rows
        if doi_key:
            rows = [r for r in rows if str(r.get("doi") or "").strip() == doi_key]
        if trigger_key:
            rows = [
                r
                for r in rows
                if str(r.get("trigger_name") or "").strip() == trigger_key
            ]
        return {"rows": rows}

    entries: List[Dict[str, Any]] = []
    for row in sheet_rows:
        row_doi = str(row.get("doi") or "").strip()
        row_trigger = str(row.get("trigger_name") or "").strip()
        if doi_key and row_doi != doi_key:
            continue
        if trigger_key and row_trigger != trigger_key:
            continue
        entries.extend(_history_entries_from_table_row(row))

    entries = sorted(entries, key=lambda e: str(e.get("timestamp_utc") or ""))
    return {"rows": entries}


@router.post("/api/benchmark-reviews/submit")
async def submit_benchmark_review(request: SubmitBenchmarkReviewRequest):
    cache = _load_benchmark_cache()
    doi = str(request.doi or "").strip()
    if not doi:
        raise HTTPException(status_code=400, detail="Missing DOI.")

    trigger_name = str(request.trigger_name or "").strip()
    if not trigger_name:
        raise HTTPException(status_code=400, detail="Missing trigger_name.")

    if not request.reason_codes:
        raise HTTPException(status_code=400, detail="Select at least one reason code.")

    doi_payload = cache.by_doi.get(doi)
    if not doi_payload:
        raise HTTPException(status_code=404, detail="DOI not found in benchmark review file.")

    incorrect_items = doi_payload.get("incorrect") or []
    if trigger_name not in {str(item.get("trigger_name") or "").strip() for item in incorrect_items}:
        raise HTTPException(
            status_code=404,
            detail="trigger_name not found for this DOI in the benchmark review source.",
        )

    ws, headers = _get_or_create_worksheet(
        BENCHMARK_REVIEW_SHEET, IDEAL_BENCHMARK_REVIEW_HEADERS
    )
    if not ws:
        raise HTTPException(
            status_code=409,
            detail="No spreadsheet connected. Connect to a sheet to submit benchmark reviews.",
        )

    if not _is_benchmark_review_table(headers):
        raise HTTPException(
            status_code=409,
            detail="Benchmark predictions are not loaded into the benchmark_review sheet yet. Upload the jsonl first.",
        )

    reason_codes = [str(code).strip() for code in request.reason_codes if str(code).strip()]
    reviewed_by = str(request.reviewed_by or "").strip() or "unknown"
    comment = str(request.comment or "").strip()
    timestamp_utc = _utc_now_iso()

    try:
        values = ws.get_all_values()
    except Exception as e:
        raise HTTPException(
            status_code=502, detail=f"Failed reading benchmark_review sheet: {e}"
        )

    try:
        doi_col = headers.index("doi") + 1
        trigger_col = headers.index("trigger_name") + 1
    except ValueError:
        raise HTTPException(
            status_code=502,
            detail="benchmark_review sheet is missing required columns (doi, trigger_name).",
        )

    target_row = None
    for idx, row in enumerate(values[1:], start=2):
        row_doi = row[doi_col - 1].strip() if len(row) >= doi_col else ""
        row_trigger = row[trigger_col - 1].strip() if len(row) >= trigger_col else ""
        if row_doi == doi and row_trigger == trigger_name:
            target_row = idx
            break

    if not target_row:
        raise HTTPException(
            status_code=404,
            detail="No matching (doi, trigger_name) row found in benchmark_review sheet. Re-upload the jsonl to populate predictions.",
        )

    def _get_cell(col_name: str) -> str:
        try:
            col = headers.index(col_name) + 1
        except ValueError:
            return ""
        return values[target_row - 1][col - 1] if len(values[target_row - 1]) >= col else ""

    existing_history = _parse_review_history_from_cell(_get_cell("review_history_json"))
    existing_review_count = _safe_int(_get_cell("review_count"))

    existing_history.append(
        {
            "timestamp_utc": timestamp_utc,
            "reviewed_by": reviewed_by,
            "reason_codes": reason_codes,
            "comment": comment,
        }
    )
    new_review_count = existing_review_count + 1

    required_cols = {
        "review_count": str(new_review_count),
        "reviewed_at_utc": timestamp_utc,
        "reviewed_by": reviewed_by,
        "reason_codes_json": json.dumps(reason_codes, ensure_ascii=False),
        "comment": comment,
        "review_history_json": _truncate_cell(
            json.dumps(existing_history, ensure_ascii=False)
        ),
    }
    missing_cols = [name for name in required_cols.keys() if name not in headers]
    if missing_cols:
        raise HTTPException(
            status_code=502,
            detail=f"benchmark_review sheet is missing required columns: {missing_cols}. Re-upload the jsonl to reset headers.",
        )

    updates = []
    for col_name, value in required_cols.items():
        col = headers.index(col_name) + 1
        updates.append(
            {
                "range": gspread.utils.rowcol_to_a1(target_row, col),
                "values": [[value]],
            }
        )
    try:
        ws.batch_update(updates, value_input_option="USER_ENTERED")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed updating review row: {e}")

    # Reset cache so reviewed counts update immediately.
    global _BENCHMARK_CACHE
    _BENCHMARK_CACHE = None

    return {"status": "ok"}


@router.post("/api/benchmark-reviews/submit-bulk")
async def submit_benchmark_review_bulk(request: SubmitBenchmarkReviewBulkRequest):
    cache = _load_benchmark_cache()
    doi = str(request.doi or "").strip()
    if not doi:
        raise HTTPException(status_code=400, detail="Missing DOI.")

    if not request.reason_codes:
        raise HTTPException(status_code=400, detail="Select at least one reason code.")

    doi_payload = cache.by_doi.get(doi)
    if not doi_payload:
        raise HTTPException(status_code=404, detail="DOI not found in benchmark source.")

    ws, headers = _get_or_create_worksheet(
        BENCHMARK_REVIEW_SHEET, IDEAL_BENCHMARK_REVIEW_HEADERS
    )
    if not ws:
        raise HTTPException(
            status_code=409,
            detail="No spreadsheet connected. Connect to a sheet to submit benchmark reviews.",
        )

    if not _is_benchmark_review_table(headers):
        raise HTTPException(
            status_code=409,
            detail="Benchmark predictions are not loaded into the benchmark_review sheet yet. Upload the jsonl first.",
        )

    all_triggers = [
        str(item.get("trigger_name") or "").strip()
        for item in (doi_payload.get("incorrect") or [])
        if str(item.get("trigger_name") or "").strip()
    ]
    trigger_set = set(all_triggers)
    requested = request.trigger_names or all_triggers
    requested_norm = [str(t or "").strip() for t in requested if str(t or "").strip()]
    requested_norm = [t for t in requested_norm if t in trigger_set]
    if not requested_norm:
        raise HTTPException(
            status_code=400, detail="No valid trigger_names to submit."
        )

    reason_codes = [
        str(code).strip() for code in request.reason_codes if str(code).strip()
    ]
    reviewed_by = str(request.reviewed_by or "").strip() or "unknown"
    comment = str(request.comment or "").strip()
    timestamp_utc = _utc_now_iso()

    try:
        values = ws.get_all_values()
    except Exception as e:
        raise HTTPException(
            status_code=502, detail=f"Failed reading benchmark_review sheet: {e}"
        )

    required_cols = [
        "doi",
        "trigger_name",
        "review_count",
        "reviewed_at_utc",
        "reviewed_by",
        "reason_codes_json",
        "comment",
        "review_history_json",
    ]
    missing_cols = [c for c in required_cols if c not in headers]
    if missing_cols:
        raise HTTPException(
            status_code=502,
            detail=f"benchmark_review sheet missing columns: {missing_cols}. Re-upload the jsonl to reset headers.",
        )

    doi_col = headers.index("doi") + 1
    trigger_col = headers.index("trigger_name") + 1

    row_index_by_trigger: Dict[str, int] = {}
    for idx, row in enumerate(values[1:], start=2):
        row_doi = row[doi_col - 1].strip() if len(row) >= doi_col else ""
        if row_doi != doi:
            continue
        row_trigger = row[trigger_col - 1].strip() if len(row) >= trigger_col else ""
        if row_trigger:
            row_index_by_trigger[row_trigger] = idx

    missing_rows = [t for t in requested_norm if t not in row_index_by_trigger]
    if missing_rows:
        raise HTTPException(
            status_code=404,
            detail="Some fields are missing in the benchmark_review sheet. Re-upload the jsonl to populate predictions.",
        )

    def _get_cell(row_idx: int, col_name: str) -> str:
        col = headers.index(col_name) + 1
        if row_idx - 1 >= len(values):
            return ""
        row_vals = values[row_idx - 1]
        return row_vals[col - 1] if len(row_vals) >= col else ""

    updates = []
    updated_fields = 0
    for trigger_name in requested_norm:
        row_idx = row_index_by_trigger[trigger_name]
        existing_history = _parse_review_history_from_cell(
            _get_cell(row_idx, "review_history_json")
        )
        existing_review_count = _safe_int(_get_cell(row_idx, "review_count"))

        existing_history.append(
            {
                "timestamp_utc": timestamp_utc,
                "reviewed_by": reviewed_by,
                "reason_codes": reason_codes,
                "comment": comment,
            }
        )
        new_review_count = existing_review_count + 1

        col_values = {
            "review_count": str(new_review_count),
            "reviewed_at_utc": timestamp_utc,
            "reviewed_by": reviewed_by,
            "reason_codes_json": json.dumps(reason_codes, ensure_ascii=False),
            "comment": comment,
            "review_history_json": _truncate_cell(
                json.dumps(existing_history, ensure_ascii=False)
            ),
        }
        for col_name, value in col_values.items():
            col = headers.index(col_name) + 1
            updates.append(
                {
                    "range": gspread.utils.rowcol_to_a1(row_idx, col),
                    "values": [[value]],
                }
            )
        updated_fields += 1

    try:
        ws.batch_update(updates, value_input_option="USER_ENTERED")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed bulk updating rows: {e}")

    global _BENCHMARK_CACHE
    _BENCHMARK_CACHE = None

    return {"status": "ok", "updated_fields": updated_fields}


@router.post("/api/benchmark-reviews/upload")
async def upload_benchmark_predictions_jsonl(
    file: UploadFile = File(...),
    mode: str = Form(default="replace"),
    uploaded_by: str = Form(default="unknown"),
):
    if not state.worksheet:
        raise HTTPException(
            status_code=409,
            detail="No spreadsheet connected. Connect to a sheet to upload benchmark predictions.",
        )

    mode_norm = str(mode or "replace").strip().lower()
    if mode_norm not in ("replace",):
        raise HTTPException(status_code=400, detail="Invalid upload mode.")

    raw = await file.read()
    try:
        text = raw.decode("utf-8")
    except Exception:
        raise HTTPException(status_code=400, detail="File must be UTF-8 encoded jsonl.")

    doi_incorrect_counts: Dict[str, int] = {}
    line_count = 0
    incorrect_item_count = 0
    chunk_count = 0

    # Preserve existing reviews (either from the new table or the legacy submissions table).
    existing_ws = _get_worksheet_if_exists(BENCHMARK_REVIEW_SHEET)
    existing_review_map: Dict[Tuple[str, str], Dict[str, Any]] = {}
    if existing_ws:
        try:
            existing_headers = existing_ws.row_values(1)
        except Exception:
            existing_headers = []
        try:
            existing_rows = existing_ws.get_all_records()
        except Exception:
            existing_rows = []

        if _is_benchmark_review_table(existing_headers):
            for row in existing_rows:
                doi = str(row.get("doi") or "").strip()
                trigger = str(row.get("trigger_name") or "").strip()
                if not doi or not trigger:
                    continue
                existing_review_map[(doi, trigger)] = {
                    "review_count": _safe_int(row.get("review_count")),
                    "reviewed_at_utc": row.get("reviewed_at_utc") or "",
                    "reviewed_by": row.get("reviewed_by") or "",
                    "reason_codes_json": row.get("reason_codes_json") or "[]",
                    "comment": row.get("comment") or "",
                    "review_history_json": row.get("review_history_json") or "[]",
                }
        else:
            # Legacy: one row per submission with timestamp_utc/reviewed_by/doi/trigger_name/reason_codes_json/comment.
            grouped: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
            for row in existing_rows:
                doi = str(row.get("doi") or "").strip()
                trigger = str(row.get("trigger_name") or "").strip()
                if not doi or not trigger:
                    continue
                grouped.setdefault((doi, trigger), []).append(row)

            for key, rows in grouped.items():
                rows_sorted = sorted(
                    rows, key=lambda r: str(r.get("timestamp_utc") or "")
                )
                history: List[Dict[str, Any]] = []
                for r in rows_sorted:
                    history.append(
                        {
                            "timestamp_utc": r.get("timestamp_utc") or "",
                            "reviewed_by": r.get("reviewed_by") or "",
                            "reason_codes": _normalize_reason_codes(
                                _parse_json(r.get("reason_codes_json"))
                                or r.get("reason_codes_json")
                            ),
                            "comment": r.get("comment") or "",
                        }
                    )
                latest = history[-1] if history else {}
                existing_review_map[key] = {
                    "review_count": len(history),
                    "reviewed_at_utc": latest.get("timestamp_utc") or "",
                    "reviewed_by": latest.get("reviewed_by") or "",
                    "reason_codes_json": _safe_json_dumps(
                        latest.get("reason_codes") or []
                    ),
                    "comment": latest.get("comment") or "",
                    "review_history_json": _safe_json_dumps(history),
                }

    uploaded_at_utc = _utc_now_iso()
    uploaded_by_norm = str(uploaded_by or "unknown").strip() or "unknown"
    upload_filename = file.filename or ""

    prediction_rows: List[Dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        line_count += 1
        try:
            record = json.loads(line)
        except Exception:
            continue

        doi = str(record.get("doi") or "").strip()
        if not doi:
            continue
        dataset = record.get("dataset")
        doc_type = record.get("doc_type")
        evaluations = record.get("evaluations") or {}
        if not isinstance(evaluations, dict):
            continue

        for trigger_name, ev in evaluations.items():
            if not isinstance(ev, dict):
                continue
            if ev.get("is_correct") is not False:
                continue

            incorrect_item_count += 1
            doi_incorrect_counts[doi] = doi_incorrect_counts.get(doi, 0) + 1
            trigger = str(trigger_name)

            evidence_chunks = _normalize_evidence_chunks(ev.get("evidence_chunks"))
            evidence_preview = ev.get("evidence_preview") or ""
            chunk_key = ev.get("chunk_key")
            chunk_start = ev.get("chunk_start")
            chunk_count += len(evidence_chunks)

            key = (doi, trigger)
            existing = existing_review_map.get(key, {})

            sanitized_chunks = []
            for ch in evidence_chunks[:10]:
                if not isinstance(ch, dict):
                    continue
                sanitized_chunks.append(
                    {
                        "score": ch.get("score"),
                        "section": ch.get("section"),
                        "char_start": ch.get("char_start"),
                        "char_end": ch.get("char_end"),
                        "text": _truncate_cell(ch.get("text"), limit=8000),
                    }
                )

            prediction_rows.append(
                {
                    "doi": doi,
                    "dataset": _safe_str(dataset),
                    "doc_type": _safe_str(doc_type),
                    "trigger_name": trigger,
                    "human_label": _safe_str(ev.get("human_label")),
                    "model_label": _safe_str(
                        ev.get("model_label")
                    if ev.get("model_label") is not None
                    else ev.get("label"),
                    ),
                    "model_label_raw": _safe_str(ev.get("label_raw")),
                    "reasoning": _truncate_cell(ev.get("reasoning")),
                    "component_reasoning": _truncate_cell(ev.get("component_reasoning")),
                    "benchmark": ev.get("benchmark"),
                    "prediction_timestamp": _safe_str(ev.get("timestamp")),
                    "duration": _safe_str(ev.get("duration")),
                    "chunk_key": _safe_str(chunk_key),
                    "chunk_start": _safe_str(chunk_start),
                    "evidence_preview": _truncate_cell(evidence_preview),
                    "evidence_chunks_json": json.dumps(
                        sanitized_chunks, ensure_ascii=False
                    ),
                    "chunk_count": len(evidence_chunks),
                    "review_count": existing.get("review_count", 0),
                    "reviewed_at_utc": existing.get("reviewed_at_utc", ""),
                    "reviewed_by": existing.get("reviewed_by", ""),
                    "reason_codes_json": existing.get("reason_codes_json", "[]"),
                    "comment": existing.get("comment", ""),
                    "review_history_json": existing.get("review_history_json", "[]"),
                    "upload_filename": upload_filename,
                    "upload_uploaded_at_utc": uploaded_at_utc,
                    "upload_uploaded_by": uploaded_by_norm,
                    "upload_source_mtime_utc": "",
                }
            )

    ws, headers = _get_or_create_worksheet(
        BENCHMARK_REVIEW_SHEET, IDEAL_BENCHMARK_REVIEW_HEADERS
    )
    if not ws:
        raise HTTPException(status_code=502, detail="Failed to prepare worksheet for upload.")

    if mode_norm == "replace":
        _reset_worksheet(ws, IDEAL_BENCHMARK_REVIEW_HEADERS)

    # Keep deterministic ordering: DOI then trigger_name
    prediction_rows.sort(
        key=lambda r: (str(r.get("doi") or ""), str(r.get("trigger_name") or ""))
    )
    rows_to_append = [
        [_normalize_cell_value(row.get(h, "")) for h in IDEAL_BENCHMARK_REVIEW_HEADERS]
        for row in prediction_rows
    ]

    try:
        if rows_to_append:
            ws.append_rows(rows_to_append, value_input_option="USER_ENTERED")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed writing uploaded data to sheet: {e}")

    global _BENCHMARK_CACHE
    _BENCHMARK_CACHE = None

    return {
        "status": "ok",
        "uploaded_at_utc": uploaded_at_utc,
        "incorrect_item_count": incorrect_item_count,
        "doi_count_with_incorrect": len(doi_incorrect_counts),
        "chunk_count": chunk_count,
    }
