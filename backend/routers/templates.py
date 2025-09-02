import json
import re
import os
from fastapi import APIRouter, HTTPException, Request, UploadFile, File

from config import TEMPLATES_DIR
from utils import open_folder

router = APIRouter()

@router.get("/api/templates")
def get_templates():
    if not TEMPLATES_DIR.exists(): return []
    return sorted([f.name for f in TEMPLATES_DIR.glob("*.json")])

@router.get("/api/templates/{template_name}")
def get_template(template_name: str):
    if not re.match(r"^[a-zA-Z0-9_-]+\.json$", template_name):
        raise HTTPException(status_code=400, detail="Invalid template name.")
    file_path = TEMPLATES_DIR / template_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Template not found.")
    with open(file_path, 'r', encoding='utf-8') as f:
        return json.load(f)

@router.post("/api/templates/{template_name}")
async def save_template(template_name: str, request: Request):
    if not re.match(r"^[a-zA-Z0-9_-]+\.json$", template_name):
        raise HTTPException(status_code=400, detail="Invalid template name.")
    file_path = TEMPLATES_DIR / template_name
    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(await request.json(), f, indent=4)
        return {"status": "success", "filename": template_name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error saving template file: {e}")

@router.delete("/api/templates/{template_name}")
def delete_template(template_name: str):
    if not re.match(r"^[a-zA-Z0-9_-]+\.json$", template_name):
        raise HTTPException(status_code=400, detail="Invalid template name.")
    file_path = TEMPLATES_DIR / template_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Template not found.")
    os.remove(file_path)
    return {"status": "success", "filename": template_name}

@router.post("/open-templates-folder")
def open_templates_folder():
    return open_folder(TEMPLATES_DIR)

@router.post("/upload-template")
async def upload_template(file: UploadFile = File(...)):
    if not file.filename.endswith(".json"):
        raise HTTPException(status_code=400, detail="Invalid file type. Please upload a .json file.")
    file_path = TEMPLATES_DIR / file.filename
    try:
        contents = await file.read()
        json.loads(contents) # Validate JSON
        with open(file_path, "wb") as f: f.write(contents)
        return {"status": "success", "filename": file.filename}
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON format.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error saving file: {e}")