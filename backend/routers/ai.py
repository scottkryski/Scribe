# backend/routers/ai.py
import json
from fastapi import APIRouter, HTTPException

from models import GeminiRequest
from ai_requests import get_gemini_response, get_gemini_models
from config import PDF_DIR

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