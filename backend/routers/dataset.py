# backend/routers/dataset.py
import random
from fastapi import APIRouter, HTTPException

from models import LoadRequest, FilterRequest
from app_state import state
from config import DATA_DIR
from database import index_dataset_if_needed, get_papers_index, search_papers_by_keyword

router = APIRouter()

@router.post("/load-dataset")
def load_dataset(request: LoadRequest):
    dataset_name = request.dataset
    if dataset_name not in state.AVAILABLE_DATASETS:
        raise HTTPException(status_code=404, detail=f"Dataset file '{dataset_name}' not found on server.")

    if dataset_name in state.ACTIVE_FILTERS:
        del state.ACTIVE_FILTERS[dataset_name]

    try:
        all_papers_from_index = get_papers_index(dataset_name)
        total_in_file = len(all_papers_from_index)

        if total_in_file == 0:
            state.DATASET_QUEUES[dataset_name] = []
            return {"status": "success", "dataset": dataset_name, "queued_count": 0, "total_in_file": 0}

        incomplete_queue = [p for p in all_papers_from_index if p.get('doi') in state.INCOMPLETE_ANNOTATIONS]
        new_paper_queue = [p for p in all_papers_from_index if p.get('doi') and p.get('doi') not in state.INCOMPLETE_ANNOTATIONS and p.get('doi') not in state.ANNOTATED_ITEMS]
        
        random.shuffle(new_paper_queue)
        
        final_queue = (incomplete_queue + new_paper_queue) if request.prioritize_incomplete else random.sample(incomplete_queue + new_paper_queue, k=len(incomplete_queue) + len(new_paper_queue))
        
        state.DATASET_QUEUES[dataset_name] = final_queue
        return {"status": "success", "dataset": dataset_name, "queued_count": len(final_queue), "total_in_file": total_in_file}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process dataset from index: {e}")

@router.get("/get-datasets")
def get_datasets():
    current_datasets = {f.name for f in DATA_DIR.glob("*.jsonl")}
    for name in current_datasets:
        if name not in state.AVAILABLE_DATASETS:
            filepath = DATA_DIR / name
            state.AVAILABLE_DATASETS[name] = filepath
            index_dataset_if_needed(filepath)
    
    for name in list(state.AVAILABLE_DATASETS.keys()):
        if name not in current_datasets:
            del state.AVAILABLE_DATASETS[name]
            if name in state.ACTIVE_FILTERS:
                del state.ACTIVE_FILTERS[name]

    return sorted(list(state.AVAILABLE_DATASETS.keys()))

@router.post("/api/filter/set")
def set_filter(request: FilterRequest):
    if request.dataset not in state.AVAILABLE_DATASETS:
        raise HTTPException(status_code=404, detail=f"Dataset '{request.dataset}' not found.")
    
    if not request.query.strip():
        if request.dataset in state.ACTIVE_FILTERS:
            del state.ACTIVE_FILTERS[request.dataset]
        return {"status": "cleared", "message": "Filter cleared due to empty query.", "match_count": 0}

    final_fts_query = request.query.strip()
    if request.template and request.template.get("fields"):
        for field in request.template["fields"]:
            if request.query.lower().strip() in field.get("label", "").lower() and field.get("keywords"):
                final_fts_query = " OR ".join(f'"{keyword}"' for keyword in field["keywords"])
                break

    matching_dois = search_papers_by_keyword(request.dataset, final_fts_query)
    state.ACTIVE_FILTERS[request.dataset] = {"query": request.query.strip(), "dois": matching_dois}
    return {"status": "success", "match_count": len(matching_dois), "query": request.query.strip()}

@router.post("/api/filter/clear")
def clear_filter(request: LoadRequest):
    if request.dataset in state.ACTIVE_FILTERS:
        del state.ACTIVE_FILTERS[request.dataset]
        return {"status": "success", "message": "Filter cleared."}
    return {"status": "noop", "message": "No active filter to clear."}

@router.get("/api/filter/status")
def get_filter_status(dataset: str):
    if dataset in state.ACTIVE_FILTERS:
        filter_data = state.ACTIVE_FILTERS[dataset]
        return {"is_active": True, "query": filter_data["query"], "match_count": len(filter_data["dois"])}
    return {"is_active": False}