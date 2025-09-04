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
    import io
    from urllib.parse import urljoin, urlparse, parse_qs

    print(f"LOG: Received request to download PDF from URL: {request.url}")

    # ---------- Filename as you had ----------
    author = re.sub(r'[^\w-]', '', (request.author or "UnknownAuthor").encode('ascii', 'ignore').decode('ascii'))
    title_fragment = "_".join(re.sub(r'[^\w\s-]', '', request.title or "untitled").strip().lower().split()[:4])
    filename = f"{author}{request.year or 'UnknownYear'}-{title_fragment}.pdf"
    filepath = PDF_DIR / filename

    if filepath.exists():
        with open(filepath, "rb") as f:
            return Response(content=f.read(), media_type="application/pdf", headers={"X-Saved-Filename": filename})

    # ---------- Helpers ----------
    def looks_like_pdf_url(u: str) -> bool:
        u_lower = u.lower()
        return (
            u_lower.endswith(".pdf")
            or "/pdf" in u_lower
            or "format=pdf" in u_lower
            or "type=pdf" in u_lower
            or "pdf=" in u_lower
        )

    def uniq(seq):
        seen = set()
        for x in seq:
            if x not in seen:
                seen.add(x)
                yield x

    def is_pdf_bytes(b: bytes) -> bool:
        # PDF magic header
        return b.startswith(b"%PDF-")

    def is_pdf_response(resp: requests.Response, sniff_bytes: bytes = b"") -> bool:
        ctype = (resp.headers.get("Content-Type") or "").lower()
        if "application/pdf" in ctype:
            return True
        # Some sites use octet-stream but it's still a PDF; sniff content if provided
        if "application/octet-stream" in ctype:
            if sniff_bytes:
                return is_pdf_bytes(sniff_bytes)
            # If we didn't sniff yet, allow as potential PDF; a later read will confirm
            return True
        return False

    def fetch_and_confirm_pdf(session: requests.Session, url: str, referer: str) -> bytes | None:
        # Try HEAD first when server allows it, then GET
        try:
            h = session.head(url, allow_redirects=True, timeout=30)
            if h.status_code == 405:  # method not allowed
                h = None
        except requests.RequestException:
            h = None

        if h is not None:
            if "application/pdf" in (h.headers.get("Content-Type") or "").lower():
                try:
                    g = session.get(url, allow_redirects=True, timeout=60, headers={"Referer": referer})
                    g.raise_for_status()
                    # No need to re-check headers; we trust HEAD
                    return g.content
                except requests.RequestException:
                    return None

        try:
            g = session.get(url, allow_redirects=True, timeout=60, headers={"Referer": referer})
            g.raise_for_status()
        except requests.RequestException:
            return None

        # Sniff a few bytes to confirm PDF even if ctype is odd
        content = g.content
        if is_pdf_response(g, sniff_bytes=content[:5]) and (is_pdf_bytes(content[:5]) or "application/pdf" in (g.headers.get("Content-Type") or "").lower()):
            return content
        return None

    # ---------- Session with browser-ish headers ----------
    url = str(request.url)
    parsed = urlparse(url)
    default_referer = f"{parsed.scheme}://{parsed.netloc}/"

    session = requests.Session()
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/122.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.8",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Referer": url,  # helps when the input is already a PDF URL (e.g., OUP)
    })

    try:
        # 1) First request
        r = session.get(url, allow_redirects=True, timeout=45)
        r.raise_for_status()
        ctype = (r.headers.get("Content-Type") or "").lower()

        # 2) If it is already a PDF, save it
        if "application/pdf" in ctype or (is_pdf_bytes(r.content[:5]) and "application/octet-stream" in ctype):
            pdf_content = r.content
            with open(filepath, "wb") as f:
                f.write(pdf_content)
            return Response(content=pdf_content, media_type="application/pdf", headers={"X-Saved-Filename": filename})

        # 3) If HTML, mine for candidates
        if "text/html" in ctype:
            soup = BeautifulSoup(r.text, "lxml")
            candidates = []

            # (a) <link rel="alternate" type="application/pdf" href=...>
            for link in soup.find_all("link", href=True):
                if (link.get("type") or "").lower() == "application/pdf":
                    candidates.append(urljoin(r.url, link["href"]))

            # (b) <a href=...> if href or text indicates PDF
            for a in soup.find_all("a", href=True):
                href = a["href"]
                text = (a.get_text() or "").strip().lower()
                if looks_like_pdf_url(href) or "pdf" in text:
                    candidates.append(urljoin(r.url, href))

            # (c) Embedded viewers
            for tag in soup.find_all(["iframe", "embed", "object"]):
                for attr in ("src", "data"):
                    val = tag.get(attr)
                    if val and looks_like_pdf_url(val):
                        candidates.append(urljoin(r.url, val))

            # (d) Meta refresh → URL
            meta = soup.find("meta", attrs={"http-equiv": re.compile(r"refresh", re.I)})
            if meta and meta.get("content"):
                m = re.search(r"url=([^;]+)", meta["content"], flags=re.I)
                if m:
                    candidates.append(urljoin(r.url, m.group(1).strip()))

            # (e) Data attributes commonly used for PDF URLs
            for tag in soup.find_all(attrs=True):
                for k, v in list(tag.attrs.items()):
                    if isinstance(v, str) and "pdf" in v.lower():
                        candidates.append(urljoin(r.url, v))

            # (f) JS literals with PDF-ish URLs
            script_text = " ".join(s.get_text(" ", strip=True) for s in soup.find_all("script"))
            for m in re.finditer(r"""["'](.*?)["']""", script_text):
                s = m.group(1)
                if looks_like_pdf_url(s):
                    candidates.append(urljoin(r.url, s))

            # (g) DOI-style helpers (common publisher patterns)
            for a in soup.find_all("a", href=True):
                href = a["href"]
                if "/doi/" in href and "pdf" not in href.lower():
                    # try common variants
                    base = urljoin(r.url, href)
                    for suffix in ("/pdf", "/pdf?download=1", "/epdf"):
                        candidates.append(base.rstrip("/") + suffix)

            # Deduplicate while preserving order
            candidates = list(uniq(candidates))

            # Try each candidate
            last_error = None
            for cand in candidates:
                try:
                    pdf_bytes = fetch_and_confirm_pdf(session, cand, referer=r.url or default_referer)
                    if pdf_bytes:
                        with open(filepath, "wb") as f:
                            f.write(pdf_bytes)
                        return Response(content=pdf_bytes, media_type="application/pdf", headers={"X-Saved-Filename": filename})
                except Exception as e:
                    last_error = e
                    continue

            # If we got here, we failed to auto-discover a working PDF
            detail = "HTML page found, but no working PDF link could be confirmed."
            if candidates:
                sample = "\n".join(candidates[:5])
                detail += f" Tried {len(candidates)} candidate(s). First few:\n{sample}"
            if last_error:
                detail += f"\nLast error: {last_error}"
            raise HTTPException(status_code=415, detail=detail)

        # 4) Unknown content type: still try to see if it’s a PDF by sniffing
        if is_pdf_bytes(r.content[:5]):
            pdf_content = r.content
            with open(filepath, "wb") as f:
                f.write(pdf_content)
            return Response(content=pdf_content, media_type="application/pdf", headers={"X-Saved-Filename": filename})

        raise HTTPException(status_code=415, detail=f"URL did not point to a PDF. Content-Type: {ctype}")

    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=400, detail=f"Failed to download PDF. Reason: {e}")
    except HTTPException:
        raise
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