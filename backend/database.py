import sqlite3
import json
import os
from pathlib import Path
import time

# --- Configuration ---
DATA_DIR = Path("data")
CACHE_DIR = DATA_DIR / "cache"


def get_db_path(dataset_name: str) -> Path:
    """Gets the SQLite database path for a given dataset name."""
    safe_dataset_name = Path(dataset_name).stem
    return CACHE_DIR / f"{safe_dataset_name}.db"

def _index_rowcount(db_path: Path) -> int:
    """Checks if the main index table exists and returns its row count."""
    if not db_path.exists():
        return 0
    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='papers_index'")
        has_table = cur.fetchone()[0] == 1
        if not has_table:
            return 0
        cur.execute("SELECT COUNT(*) FROM papers_index")
        count = cur.fetchone()[0] or 0
        return count
    except sqlite3.Error as e:
        print(f"WARN: Could not read rowcount from {db_path}: {e}")
        return 0
    finally:
        if 'conn' in locals() and conn:
            conn.close()

def init_dataset_db(db_path: Path):
    """Initializes an SQLite database with the required tables and FTS5 virtual table."""
    print(f"LOG: Initializing new database at {db_path}")
    CACHE_DIR.mkdir(exist_ok=True)
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS papers_index (
            doi TEXT PRIMARY KEY,
            title TEXT,
            open_access_pdf TEXT,
            byte_offset INTEGER NOT NULL
        )
    ''')
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS doi_offsets (
            doi TEXT PRIMARY KEY,
            byte_offset INTEGER NOT NULL
        )
    ''')
    
    cursor.execute("DROP TABLE IF EXISTS paper_text_fts")
    cursor.execute('''
        CREATE VIRTUAL TABLE paper_text_fts USING fts5(
            doi UNINDEXED,
            title,
            abstract
        )
    ''')

    conn.commit()
    conn.close()

# --- MODIFIED: The main indexing function with duplicate handling ---
def index_dataset_if_needed(dataset_path: Path):
    """
    Creates or updates an SQLite index for a dataset, safely ignoring duplicate DOIs.
    """
    dataset_name = dataset_path.name
    db_path = get_db_path(dataset_name)
    
    if db_path.exists():
        db_mtime = db_path.stat().st_mtime
        dataset_mtime = dataset_path.stat().st_mtime
        rowcount = _index_rowcount(db_path)

        if db_mtime > dataset_mtime and rowcount > 0:
            print(f"LOG: Index for '{dataset_name}' is up to date (rows: {rowcount}).")
            return
        else:
            print(f"LOG: Rebuilding index for '{dataset_name}' (Reason: file changed or index empty/invalid. Rows: {rowcount})")

    start_time = time.time()
    print(f"LOG: Building index for '{dataset_name}'. This may take a moment...")
    
    init_dataset_db(db_path)
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("BEGIN TRANSACTION")
    
    cursor.execute("DELETE FROM paper_text_fts")
    cursor.execute("DELETE FROM papers_index")
    cursor.execute("DELETE FROM doi_offsets")
    
    # FIX: Initialize counters for comprehensive logging
    count = 0
    duplicates = 0
    skipped_no_doi = 0
    
    try:
        with open(dataset_path, 'rb') as f:
            while True:
                offset = f.tell()
                line = f.readline()
                if not line:
                    break
                
                try:
                    paper = json.loads(line)
                    doi = paper.get('doi')
                    
                    if not doi:
                        skipped_no_doi += 1
                        continue
                    
                    title = paper.get('title', 'No Title')
                    abstract = paper.get('abstract', '')
                    
                    oa_pdf_info = paper.get('open_access_pdf', {})
                    pdf_url = oa_pdf_info.get('url') if isinstance(oa_pdf_info, dict) else oa_pdf_info
                    
                    # FIX: Use INSERT OR IGNORE to safely skip duplicates without crashing.
                    cursor.execute(
                        'INSERT OR IGNORE INTO papers_index (doi, title, open_access_pdf, byte_offset) VALUES (?, ?, ?, ?)',
                        (doi, title, pdf_url, offset)
                    )

                    # Check if a new row was actually inserted. rowcount is 1 for a new row, 0 for an ignored duplicate.
                    if cursor.rowcount == 0:
                        duplicates += 1
                        continue # Skip to the next line if it was a duplicate

                    # If we are here, it was a new DOI. Proceed with other tables.
                    count += 1
                    
                    cursor.execute(
                        'INSERT OR IGNORE INTO doi_offsets (doi, byte_offset) VALUES (?, ?)',
                        (doi, offset)
                    )
                    
                    cursor.execute(
                        'INSERT INTO paper_text_fts (doi, title, abstract) VALUES (?, ?, ?)',
                        (doi, title, abstract)
                    )
                    
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
        
        conn.commit()
    except Exception as e:
        conn.rollback()
        print(f"ERROR: An unexpected error occurred during indexing for '{dataset_name}': {e}")
    finally:
        conn.close()
        
    end_time = time.time()
    # FIX: Update logging to show a summary of the indexing process
    print(f"LOG: Indexing complete for '{dataset_name}' in {end_time - start_time:.2f} seconds.")
    print(f"     -> Indexed {count} new papers.")
    print(f"     -> Ignored {duplicates} duplicate DOIs.")
    print(f"     -> Skipped {skipped_no_doi} lines with no DOI.")

def get_papers_index(dataset_name: str) -> list[dict]:
    """
    Retrieves the lightweight paper index from the SQLite database.
    """
    db_path = get_db_path(dataset_name)
    if not db_path.exists():
        return []
        
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute('SELECT doi, title, open_access_pdf FROM papers_index')
    papers = [dict(row) for row in cursor.fetchall()]
    
    conn.close()

    if not papers:
        print(f"WARN: get_papers_index returned 0 rows for '{dataset_name}'. The index might be empty or the dataset file is invalid.")
        
    return papers

def get_paper_by_doi_from_file(dataset_path: Path, doi: str) -> dict | None:
    """
    Retrieves the full JSON data for a single paper by its DOI using the byte offset.
    """
    dataset_name = dataset_path.name
    db_path = get_db_path(dataset_name)
    if not db_path.exists():
        return None

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    cursor.execute("SELECT byte_offset FROM doi_offsets WHERE doi = ?", (doi,))
    result = cursor.fetchone()
    conn.close()
    
    if not result:
        return None
        
    offset = result[0]
    
    try:
        with open(dataset_path, 'rb') as f:
            f.seek(offset)
            line = f.readline()
            return json.loads(line)
    except (IOError, json.JSONDecodeError, UnicodeDecodeError) as e:
        print(f"ERROR: Could not retrieve paper '{doi}' from file at offset {offset}: {e}")
        return None

def search_papers_by_keyword(dataset_name: str, query: str) -> list[str]:
    """
    Performs a full-text search on the dataset and returns a list of matching DOIs.
    """
    db_path = get_db_path(dataset_name)
    if not db_path.exists():
        print(f"WARN: Cannot search, database for '{dataset_name}' does not exist.")
        return []

    dois = []
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Use FTS5 MATCH syntax. The query will be sanitized by the parameter binding.
        cursor.execute(
            "SELECT doi FROM paper_text_fts WHERE paper_text_fts MATCH ?",
            (query,)
        )
        
        results = cursor.fetchall()
        dois = [row[0] for row in results]
        print(f"LOG: FTS5 search for '{query}' in '{dataset_name}' found {len(dois)} results.")
        
    except sqlite3.Error as e:
        print(f"ERROR: FTS5 search failed for '{dataset_name}': {e}")
        # This can happen if the FTS5 query syntax is invalid.
        # We can return an empty list to prevent a crash.
        return []
    finally:
        if 'conn' in locals() and conn:
            conn.close()
            
    return dois