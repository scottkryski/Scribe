# backend/app_state.py
import gspread
from pathlib import Path
from typing import Optional, List, Dict, Set, Any

class AppState:
    """A class to hold the global, mutable state of the application."""
    def __init__(self):
        self.DATASET_QUEUES: Dict[str, List[dict]] = {}
        self.AVAILABLE_DATASETS: Dict[str, Path] = {}
        self.ANNOTATED_ITEMS: Set[str] = set()
        self.INCOMPLETE_ANNOTATIONS: Dict[str, dict] = {}
        self.gspread_client: Optional[gspread.Client] = None
        self.worksheet: Optional[gspread.Worksheet] = None
        self.ACTIVE_FILTERS: Dict[str, Dict[str, Any]] = {}
        self.ACTIVE_LOCKS: Dict[str, Dict[str, Any]] = {} 
        self.currentDataset: Optional[str] = None

# Create a single, importable instance of the application state.
state = AppState()