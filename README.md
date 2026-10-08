# VISIONX - AI Video Understanding System

VISIONX is a lightweight, high-performance AI Video Intelligence platform powered by the **Google Gemini Video Understanding API** using the official `google-genai` Python SDK.

It provides end-to-end video analysis without complex vector databases, YOLO models, or OpenCV tracking:
1. **Video Upload**: Streams MP4/WebM videos to FastAPI and synchronizes them with the Gemini Files API.
2. **AI Video Understanding**: Analyzes actions, people, movements, and scene transitions using Google Gemini multimodal vision.
3. **Structured Timeline & Summary**: Generates factual chronological events with `MM:SS` timestamps and a concise summary.
4. **Interactive Video Chat**: Contextual question-answering with clickable timestamps that jump directly to exact moments in the HTML5 video player.

---

## Project Structure

```
VISIONX/
│
├── backend/
│   ├── __init__.py
│   ├── main.py              # FastAPI endpoints (upload, analyze, chat, status)
│   └── gemini_service.py    # Google GenAI SDK integration & video understanding
│
├── frontend/
│   ├── index.html           # Modern Vanilla HTML5 dashboard
│   ├── style.css            # Dark mode vision UI & responsive layout
│   └── script.js            # Vanilla JavaScript controller & timestamp seeking
│
├── uploads/                 # Storage for local video files & playback streaming
├── .env                     # Local environment configuration
├── .env.example             # Template for environment variables
├── requirements.txt         # Minimal Python dependencies
└── README.md
```

---

## Prerequisites

- **Python 3.10+**
- A **Gemini API Key** from [Google AI Studio](https://aistudio.google.com/)

---

## Environment Variable Configuration

1. Copy the example environment template:
   ```bash
   cp .env.example .env
   ```

2. Open `.env` and set your `GEMINI_API_KEY`:
   ```ini
   GEMINI_API_KEY="your-gemini-api-key-here"
   ```

*Note: The backend loads `GEMINI_API_KEY` securely on the server side; keys are never sent to or exposed in the frontend.*

---

## Installation

Install the required Python dependencies:

```bash
pip install -r requirements.txt
```

Only minimal, essential packages are installed:
- `fastapi`
- `uvicorn`
- `python-multipart`
- `python-dotenv`
- `google-genai`
- `pydantic`

---

## Running the Application

Start the FastAPI application with Uvicorn:

```bash
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8001
```

Then open your browser at:

👉 **[http://127.0.0.1:8001](http://127.0.0.1:8001)**

---

## Database Migrations

**No database migrations are needed.**

By design, VISIONX uses an in-memory session architecture to keep the system fast, stateless, and minimal:
- No SQLite, PostgreSQL, MongoDB, or vector databases are required.
- The currently uploaded video reference and analysis results are managed directly in backend memory.
- Uploaded videos are served directly from the `/uploads` directory for smooth HTML5 video player seeking with HTTP range requests.

---

## Core Features & Workflow

1. **Upload Video**:
   - Click **Choose Video** to select an MP4, WebM, or MOV file, or click **Load Demo Video** to test immediately with the built-in test video.
   - The video is saved locally in `uploads/` and uploaded to the Gemini Files API.
   - The backend polls until the file status transitions to `ACTIVE`.

2. **Analyze Video**:
   - Click **Analyze Video** to trigger multimodal video analysis.
   - Gemini detects actions, movements, people entering/leaving, and scene changes.
   - Outputs a concise overall summary and an event timeline formatted strictly in `MM:SS`.

3. **Clickable Timestamps**:
   - Every timestamp in the summary, timeline cards, and chatbot answers is interactive.
   - Clicking any `[MM:SS]` chip immediately seeks the HTML5 player to that second and plays.

4. **Interactive Video Chat**:
   - Ask specific natural language questions (e.g., *"When did the person enter?"*, *"Did anyone fall?"*, *"What happened around 00:05?"*).
   - Responses cite exact observed timestamps from the video.
