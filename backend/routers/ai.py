# backend/routers/ai.py
import json
from fastapi import APIRouter, HTTPException

from models import GeminiRequest, AugmentationRequest
from ai_requests import get_gemini_response, get_gemini_models, get_augmentation_response
from config import PDF_DIR
from app_state import state
from . import sheets

router = APIRouter()

@router.get("/get-gemini-models")
def get_available_gemini_models():
    print("LOG: Requesting list of available Gemini models.")
    return get_gemini_models()

@router.post("/get-gemini-suggestions")
async def get_gemini_suggestions(request: GeminiRequest):
    pdf_path = PDF_DIR / request.pdf_filename
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail=f"PDF file '{request.pdf_filename}' not found on server.")
    
    try:
        print(f"LOG: Requesting Gemini suggestions for '{request.pdf_filename}' using model '{request.model_name}'...")
        gemini_result = await get_gemini_response(
            gemini_model=request.model_name,
            pdf_filepath=pdf_path,
            template=request.template
        )
        response_data = json.loads(gemini_result.text)
        print("LOG: Successfully received and parsed suggestions from Gemini.")
        return response_data
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        print(f"ERROR: An unexpected error occurred while getting Gemini suggestions: {e}")
        raise HTTPException(status_code=500, detail=f"An error occurred while communicating with the AI model: {e}")

@router.post("/augment-data")
async def augment_data(request: AugmentationRequest):
    if not state.worksheet:
        raise HTTPException(status_code=400, detail="No active Google Sheet connection.")
    
    try:
        # 1. Get synthetic data from the AI model
        print(f"LOG: Requesting data augmentation for '{request.title}'...")
        ai_result = await get_augmentation_response(
            model_name=request.model_name,
            title=request.title,
            abstract=request.abstract,
            annotations=request.annotations,
            template=request.template,
            sample_count=request.sample_count
        )
        
        synthetic_papers = ai_result.get("synthetic_papers", [])
        if not synthetic_papers:
            print("WARN: AI did not return any synthetic papers.")
            return {"status": "success", "message": "Annotation submitted, but AI returned no synthetic data."}

        # 2. Prepare the data for storage
        data_to_store = []
        augmented_annotator = f"{request.annotator} + {request.model_name}"
        
        for paper in synthetic_papers:
            record = {
                "doi": request.doi, # FIX: Use the DOI from the request body
                "title": paper.get("title"),
                "abstract": paper.get("abstract"),
                "annotator": augmented_annotator,
                "dataset": request.dataset,
                "annotations": request.annotations
            }
            data_to_store.append(record)

        # 3. Get the spreadsheet and write the data
        spreadsheet = state.worksheet.spreadsheet
        sheets.write_synthetic_data(spreadsheet, data_to_store)
        
        print(f"LOG: Successfully generated and stored {len(data_to_store)} synthetic records.")
        return {"status": "success", "message": f"Successfully augmented data with {len(data_to_store)} samples."}

    except RuntimeError as e:
        print(f"ERROR: A recoverable error occurred during data augmentation: {e}")
        return {"status": "warning", "message": f"Annotation submitted, but augmentation failed: {e}"}
    except Exception as e:
        print(f"ERROR: An unexpected error occurred during data augmentation: {e}")
        return {"status": "warning", "message": f"Annotation submitted, but an unexpected augmentation error occurred: {e}"}