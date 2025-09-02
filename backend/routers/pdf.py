# backend/routers/pdf.py
import re
import requests
from bs4 import BeautifulSoup
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import Response

from models import PdfRequest
from config import PDF_DIR

router = APIRouter()

@router.post("/download-pdf")
async def download_pdf_proxy(request: PdfRequest):
    print(f"LOG: Received request to download PDF from URL: {request.url}")

    author = re.sub(r'[^\w-]', '', (request.author or "UnknownAuthor").encode('ascii', 'ignore').decode('ascii'))
    title_fragment = "_".join(re.sub(r'[^\w\s-]', '', request.title or "untitled").strip().lower().split()[:4])
    filename = f"{author}{request.year or 'UnknownYear'}-{title_fragment}.pdf"
    filepath = PDF_DIR / filename

    if filepath.exists():
        with open(filepath, "rb") as f:
            return Response(content=f.read(), media_type="application/pdf", headers={"X-Saved-Filename": filename})

    try:
        headers = {'User-Agent': 'Mozilla/5.0'}
        response = requests.get(str(request.url), headers=headers, timeout=20, allow_redirects=True)
        response.raise_for_status()
        content_type = response.headers.get('Content-Type', '')

        pdf_content = None
        if 'application/pdf' in content_type:
            pdf_content = response.content
        elif 'text/html' in content_type:
            soup = BeautifulSoup(response.text, 'lxml')
            pdf_link = soup.find('a', href=re.compile(r'\.pdf$', re.I))
            if pdf_link:
                from urllib.parse import urljoin
                pdf_url = urljoin(str(request.url), pdf_link['href'])
                pdf_response = requests.get(pdf_url, headers=headers, timeout=20)
                pdf_response.raise_for_status()
                if 'application/pdf' in pdf_response.headers.get('Content-Type', ''):
                    pdf_content = pdf_response.content
                else:
                    raise HTTPException(status_code=415, detail=f"Found link, but it did not point to a PDF.")
            else:
                raise HTTPException(status_code=415, detail="HTML page found, but no PDF link could be automatically discovered.")

        if pdf_content:
            with open(filepath, "wb") as f: f.write(pdf_content)
            return Response(content=pdf_content, media_type="application/pdf", headers={"X-Saved-Filename": filename})
        else:
             raise HTTPException(status_code=415, detail=f"URL did not point to a PDF. Content-Type: {content_type}")
    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=400, detail=f"Failed to download PDF. Reason: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"An unexpected error occurred: {e}")

@router.post("/upload-pdf")
async def upload_pdf(file: UploadFile = File(...), expected_filename: str = Form(...)):
    if not expected_filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Invalid expected filename. Must end with .pdf.")
    file_path = PDF_DIR / expected_filename
    try:
        with open(file_path, "wb") as f:
            f.write(await file.read())
        return {"status": "success", "filename": expected_filename, "url": f"/pdfs/{expected_filename}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error saving uploaded PDF file: {e}")