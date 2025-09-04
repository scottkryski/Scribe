# backend/routers/sheets.py
import gspread
import json
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Any, Dict

from app_state import state
from models import ConnectSheetRequest, SheetUrlRequest
from config import SHEETS_CONFIG_FILE

router = APIRouter()

class TemplateUpdateRequest(BaseModel):
    template_data: Dict[str, Any] = Field(..., alias="templateData")

def _load_sheets_config():
    if not SHEETS_CONFIG_FILE.exists():
        return []
    with open(SHEETS_CONFIG_FILE, 'r') as f:
        return json.load(f)

def _save_sheets_config(config):
    with open(SHEETS_CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=2)

@router.get("/api/sheets", response_model=list)
async def get_sheets():
    return _load_sheets_config()

@router.post("/api/sheets")
async def add_sheet(request: SheetUrlRequest):
    config = _load_sheets_config()
    try:
        if "spreadsheets/d/" in request.url:
            sheet_id = request.url.split('spreadsheets/d/')[1].split('/')[0]
        else:
            raise ValueError("Invalid URL")
    except (ValueError, IndexError):
        raise HTTPException(status_code=400, detail="Invalid Google Sheet URL provided.")

    if any(s['id'] == sheet_id for s in config):
        raise HTTPException(status_code=409, detail="This sheet has already been added.")
    
    config.append({"id": sheet_id, "name": request.name})
    _save_sheets_config(config)
    return {"status": "success", "id": sheet_id}

@router.delete("/api/sheets/{sheet_id}")
async def delete_sheet(sheet_id: str):
    config = _load_sheets_config()
    new_config = [s for s in config if s['id'] != sheet_id]
    if len(new_config) == len(config):
        raise HTTPException(status_code=404, detail="Sheet configuration not found.")
    _save_sheets_config(new_config)
    return {"status": "success"}

@router.post("/connect-to-sheet")
async def connect_to_sheet(request: ConnectSheetRequest):
    if not state.gspread_client:
        raise HTTPException(status_code=503, detail="Google Sheets client not initialized.")
    
    sheet_id = request.sheet_id
    has_sheet_template = False
    template_timestamp = None

    try:
        spreadsheet = state.gspread_client.open_by_key(sheet_id)
        state.worksheet = spreadsheet.sheet1
        print(f"LOG: Successfully connected to sheet '{spreadsheet.title}'")

        try:
            template_worksheet = spreadsheet.worksheet("_template")
            template_json_str = template_worksheet.acell('A1').value
            if template_json_str:
                parsed_template = json.loads(template_json_str)
                if 'fields' in parsed_template and isinstance(parsed_template['fields'], list):
                    state.SHEET_TEMPLATES[sheet_id] = parsed_template
                    has_sheet_template = True
                    # --- FIX: Get the last updated time from the SPREADSHEET, not the worksheet ---
                    template_timestamp = spreadsheet.updated
                    print(f"LOG: Found and loaded a valid template from worksheet '_template' in sheet '{spreadsheet.title}'.")
                else:
                    print(f"WARN: Content in '_template' sheet is not a valid template format (missing 'fields' list).")
            else:
                 print(f"LOG: Found '_template' worksheet but cell A1 is empty.")
        except gspread.WorksheetNotFound:
            print(f"LOG: No '_template' worksheet found in sheet '{spreadsheet.title}'. Using local templates.")
            if sheet_id in state.SHEET_TEMPLATES:
                del state.SHEET_TEMPLATES[sheet_id]
        except json.JSONDecodeError:
            print(f"WARN: Could not parse JSON from '_template' worksheet cell A1.")
        except Exception as e:
            # This is where the original error was logged
            print(f"ERROR: An unexpected error occurred while loading sheet template: {e}")

        return {
            "message": "Successfully connected to sheet.",
            "has_sheet_template": has_sheet_template,
            "template_timestamp": template_timestamp
        }

    except gspread.exceptions.SpreadsheetNotFound:
        raise HTTPException(status_code=404, detail="Spreadsheet not found. Check the ID and permissions.")
    except Exception as e:
        print(f"ERROR: Failed to connect to sheet: {e}")
        raise HTTPException(status_code=500, detail=f"An internal error occurred: {e}")

@router.get("/api/sheets/{sheet_id}/template-status")
async def get_sheet_template_status(sheet_id: str):
    if not state.gspread_client:
        raise HTTPException(status_code=503, detail="Google Sheets client not initialized.")
    try:
        spreadsheet = state.gspread_client.open_by_key(sheet_id)
        spreadsheet.fetch_sheet_metadata() 
        # --- FIX: Get the last updated time from the SPREADSHEET, not the worksheet ---
        # Also ensure the _template sheet exists before returning a timestamp for it.
        spreadsheet.worksheet("_template") # This will raise WorksheetNotFound if it doesn't exist
        return {"last_updated": spreadsheet.updated}
    except gspread.WorksheetNotFound:
        raise HTTPException(status_code=404, detail="No template worksheet found for this sheet.")
    except gspread.exceptions.SpreadsheetNotFound:
        raise HTTPException(status_code=404, detail="Spreadsheet not found.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/api/sheets/{sheet_id}/template")
async def get_sheet_template(sheet_id: str):
    print(f"LOG: Live-fetching template for sheet {sheet_id}.")
    if not state.gspread_client:
        raise HTTPException(status_code=503, detail="Google Sheets client not initialized.")
    try:
        spreadsheet = state.gspread_client.open_by_key(sheet_id)
        template_worksheet = spreadsheet.worksheet("_template")
        template_json_str = template_worksheet.acell('A1').value
        if template_json_str:
            parsed_template = json.loads(template_json_str)
            state.SHEET_TEMPLATES[sheet_id] = parsed_template
            return parsed_template
        else:
            raise HTTPException(status_code=404, detail="Template worksheet is empty.")
    except gspread.WorksheetNotFound:
        raise HTTPException(status_code=404, detail="No template worksheet found for this sheet.")
    except Exception as e:
         raise HTTPException(status_code=500, detail=f"Failed to live-fetch template: {e}")


@router.post("/api/sheets/{sheet_id}/template")
async def save_sheet_template(sheet_id: str, request: TemplateUpdateRequest):
    if not state.gspread_client:
        raise HTTPException(status_code=503, detail="Google Sheets client not initialized.")

    try:
        spreadsheet = state.gspread_client.open_by_key(sheet_id)
        
        try:
            template_worksheet = spreadsheet.worksheet("_template")
        except gspread.WorksheetNotFound:
            print("LOG: '_template' worksheet not found. Creating it now.")
            template_worksheet = spreadsheet.add_worksheet(title="_template", rows=1, cols=1)

        template_json_str = json.dumps(request.template_data, indent=4)
        
        template_worksheet.update_cell(1, 1, template_json_str)
        state.SHEET_TEMPLATES[sheet_id] = request.template_data
        
        print(f"LOG: Successfully saved template to sheet '{spreadsheet.title}'.")
        return {"status": "success", "message": "Template saved to Google Sheet successfully."}

    except gspread.exceptions.SpreadsheetNotFound:
        raise HTTPException(status_code=404, detail="Spreadsheet not found. Cannot save template.")
    except gspread.exceptions.APIError as e:
        error_details = "Unknown Google API Error"
        try:
            error_payload = json.loads(e.response.text)
            error_details = error_payload.get("error", {}).get("message", e.response.text)
        except (json.JSONDecodeError, AttributeError):
            error_details = str(e)

        print(f"ERROR: Google API error while saving template: {error_details}")
        raise HTTPException(status_code=403, detail="Permission denied. The service account needs 'Editor' access to the Google Sheet to save templates.")
    except Exception as e:
        print(f"ERROR: An unexpected error occurred while saving sheet template: {e}")
        raise HTTPException(status_code=500, detail=f"An internal error occurred: {e}")