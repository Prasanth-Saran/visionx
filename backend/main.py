"""VISIONX - AI Video Understanding System Backend.

FastAPI application providing:
- Video upload & Gemini Files API synchronization
- Video analysis (summary & timestamped timeline events)
- Video contextual chatbot with timestamp tracking
- Video streaming and static frontend hosting
"""

import os
import shutil
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.gemini_service import GeminiVideoService

# Load environment variables
load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent
UPLOADS_DIR = BASE_DIR / "uploads"
FRONTEND_DIR = BASE_DIR / "frontend"

UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
FRONTEND_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="VISIONX - AI Video Intelligence",
    description="Video understanding system powered by Google Gemini",
    version="1.0.0",
)

# CORS setup
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory storage for active video and analysis
video_state: Dict[str, Any] = {
    "filename": None,
    "file_path": None,
    "video_url": None,
    "gemini_file": None,
    "summary": None,
    "timeline": [],
    "chat_history": [],
    "is_analyzed": False,
}

gemini_service = GeminiVideoService()


class ChatRequest(BaseModel):
    question: str


@app.get("/api/status")
def get_status():
    """Get the current system status and active video state."""
    has_api_key = bool(os.environ.get("GEMINI_API_KEY"))
    return {
        "api_key_configured": has_api_key,
        "has_active_video": video_state["filename"] is not None,
        "video": {
            "filename": video_state["filename"],
            "video_url": video_state["video_url"],
            "is_analyzed": video_state["is_analyzed"],
        },
        "analysis": {
            "summary": video_state["summary"],
            "timeline": video_state["timeline"],
        },
        "chat_count": len(video_state["chat_history"]),
    }


@app.post("/api/upload")
def upload_video(file: UploadFile = File(...)):
    """Upload a video file, save locally, and upload to Gemini Files API."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file selected")

    # Validate video format
    allowed_extensions = {".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v"}
    file_ext = Path(file.filename).suffix.lower()
    if file_ext not in allowed_extensions and not (file.content_type and "video" in file.content_type):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file format '{file_ext}'. Please upload an MP4, WebM, MOV, or AVI video.",
        )

    # Generate unique safe local filename
    safe_basename = Path(file.filename).stem[:30].replace(" ", "_")
    unique_filename = f"{uuid.uuid4().hex[:8]}_{safe_basename}{file_ext}"
    local_path = UPLOADS_DIR / unique_filename

    try:
        with open(local_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save video: {str(e)}")

    # Verify file is not empty
    if local_path.stat().st_size == 0:
        local_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    # Upload to Gemini Files API
    try:
        gemini_file_ref = gemini_service.upload_video(
            file_path=str(local_path),
            display_name=file.filename,
        )
    except Exception as e:
        local_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to upload video to Gemini: {str(e)}",
        )

    # Update in-memory state
    video_state["filename"] = file.filename
    video_state["file_path"] = str(local_path)
    video_state["video_url"] = f"/uploads/{unique_filename}"
    video_state["gemini_file"] = gemini_file_ref
    video_state["summary"] = None
    video_state["timeline"] = []
    video_state["chat_history"] = []
    video_state["is_analyzed"] = False

    return {
        "status": "success",
        "message": "Video successfully uploaded and ready for analysis.",
        "filename": file.filename,
        "video_url": video_state["video_url"],
    }


@app.post("/api/load-sample")
def load_sample_video():
    """Load the built-in sample demo video for rapid testing."""
    sample_file = UPLOADS_DIR / "sample_test_video.mp4"
    if not sample_file.exists():
        raise HTTPException(status_code=404, detail="Sample video not found.")

    try:
        gemini_file_ref = gemini_service.upload_video(
            file_path=str(sample_file),
            display_name="sample_test_video.mp4",
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to upload sample video to Gemini: {str(e)}",
        )

    video_state["filename"] = "sample_test_video.mp4"
    video_state["file_path"] = str(sample_file)
    video_state["video_url"] = "/uploads/sample_test_video.mp4"
    video_state["gemini_file"] = gemini_file_ref
    video_state["summary"] = None
    video_state["timeline"] = []
    video_state["chat_history"] = []
    video_state["is_analyzed"] = False

    return {
        "status": "success",
        "message": "Sample video loaded and ready for analysis.",
        "filename": "sample_test_video.mp4",
        "video_url": "/uploads/sample_test_video.mp4",
    }


@app.post("/api/analyze")
def analyze_video():
    """Trigger video understanding analysis using Gemini."""
    if not video_state.get("gemini_file"):
        raise HTTPException(
            status_code=400,
            detail="No video has been uploaded yet. Please upload a video first.",
        )

    try:
        analysis_data = gemini_service.analyze_video(video_state["gemini_file"])
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Video analysis failed: {str(e)}",
        )

    summary = analysis_data.get("summary", "Analysis completed without a summary.")
    timeline = analysis_data.get("timeline", [])

    video_state["summary"] = summary
    video_state["timeline"] = timeline
    video_state["is_analyzed"] = True

    return {
        "status": "success",
        "summary": summary,
        "timeline": timeline,
    }


@app.post("/api/chat")
def chat_with_video(req: ChatRequest):
    """Ask a question about the video and receive an answer with timestamps."""
    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    if not video_state.get("gemini_file"):
        raise HTTPException(
            status_code=400,
            detail="No video uploaded. Please upload and analyze a video first.",
        )

    try:
        answer = gemini_service.chat_about_video(
            file_ref=video_state["gemini_file"],
            question=question,
            summary=video_state.get("summary"),
            timeline=video_state.get("timeline"),
            chat_history=video_state.get("chat_history"),
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to answer question: {str(e)}",
        )

    # Save to history
    entry = {"question": question, "answer": answer}
    video_state["chat_history"].append(entry)

    return {
        "status": "success",
        "question": question,
        "answer": answer,
    }


# Serve uploaded files for HTML5 video playback
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

# Serve frontend static assets under both /static and /frontend
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")
    app.mount("/frontend", StaticFiles(directory=str(FRONTEND_DIR)), name="frontend")


@app.get("/")
def serve_index():
    """Serve the Vanilla HTML frontend."""
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"message": "VISIONX Backend is active. Place frontend/index.html to view UI."}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("backend.main:app", host="127.0.0.1", port=8001, reload=True)
