# backend/models.py
from pydantic import BaseModel, HttpUrl
from typing import Optional, List, Dict, Any

class AnnotationSubmission(BaseModel):
    doi: str
    title: str
    dataset: str
    annotator: str
    annotations: Dict[str, Any]

class PdfRequest(BaseModel):
    url: HttpUrl
    title: Optional[str] = "untitled_paper"
    author: Optional[str] = "UnknownAuthor"
    year: Optional[int] = 0

class SkipRequest(BaseModel):
    dataset: str
    doi: str

class LoadRequest(BaseModel):
    dataset: str
    prioritize_incomplete: bool = True

class ApiKeyRequest(BaseModel):
    key: str

class GeminiRequest(BaseModel):
    pdf_filename: str
    model_name: str
    template: Dict[str, Any]

class FilterRequest(BaseModel):
    dataset: str
    query: str
    template: Optional[Dict[str, Any]] = None
    
class SheetUrlRequest(BaseModel):
    name: str
    url: str

class ConnectSheetRequest(BaseModel):
    sheet_id: str