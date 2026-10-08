"""Gemini Video Understanding Service for VISIONX.

Uses the official google-genai Python SDK.
"""

import json
import logging
import os
import time
from typing import Any, Dict, List, Optional
from dotenv import load_dotenv
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

# Load environment variables
load_dotenv()

logger = logging.getLogger("visionx.gemini")
logging.basicConfig(level=logging.INFO)


class TimelineEvent(BaseModel):
    timestamp: str = Field(
        description="Timestamp of the event strictly in MM:SS format (e.g. 00:08, 01:32)"
    )
    event: str = Field(description="Short concise title of the event")
    description: str = Field(
        description="Clear factual description of the observed action or event"
    )


class VideoAnalysisResult(BaseModel):
    summary: str = Field(
        description="Concise overall summary of what occurs in the video"
    )
    timeline: List[TimelineEvent] = Field(
        description="Chronological timeline of all observed events"
    )


class GeminiVideoService:
    def __init__(self):
        self.api_key = os.environ.get("GEMINI_API_KEY")
        if not self.api_key:
            logger.warning(
                "GEMINI_API_KEY environment variable is not set. Gemini calls will fail until it is configured."
            )
            self.client = None
        else:
            self.client = genai.Client(api_key=self.api_key)

    def _ensure_client(self):
        """Re-check environment variable if client was not initialized."""
        if self.client is None:
            self.api_key = os.environ.get("GEMINI_API_KEY")
            if not self.api_key:
                raise ValueError(
                    "GEMINI_API_KEY is missing. Please set GEMINI_API_KEY in your .env file or environment."
                )
            self.client = genai.Client(api_key=self.api_key)
        return self.client

    def upload_video(self, file_path: str, display_name: str) -> types.File:
        """Upload a video file to the Gemini Files API and wait for processing."""
        client = self._ensure_client()
        logger.info(f"Uploading video {file_path} to Gemini Files API...")

        file_ref = client.files.upload(
            file=file_path,
            config=types.UploadFileConfig(display_name=display_name),
        )
        logger.info(f"Uploaded file name: {file_ref.name}, state: {file_ref.state}")

        # Wait until file is processed and active
        max_wait = 120  # seconds
        start_time = time.time()
        while getattr(file_ref, "state", None) in (
            types.FileState.PROCESSING,
            "PROCESSING",
        ):
            if time.time() - start_time > max_wait:
                raise TimeoutError(
                    "Timed out waiting for Gemini to process the uploaded video file."
                )
            time.sleep(2)
            logger.info(f"Checking Gemini file processing status for {file_ref.name}...")
            file_ref = client.files.get(name=file_ref.name)

        if getattr(file_ref, "state", None) in (
            types.FileState.FAILED,
            "FAILED",
        ):
            error_msg = getattr(file_ref, "error", "Unknown error")
            raise RuntimeError(f"Gemini video processing failed: {error_msg}")

        logger.info(f"Video file is ready with state: {file_ref.state}")
        return file_ref

    def analyze_video(self, file_ref: types.File) -> Dict[str, Any]:
        """Analyze video using Gemini and produce structured timeline & summary."""
        client = self._ensure_client()

        prompt = (
            "Analyze this entire video carefully. Identify important events, people, actions, "
            "movements, interactions, unusual events, people entering/leaving, running, falling, "
            "and major scene changes. "
            "For every important event provide an accurate timestamp strictly in MM:SS format (e.g. 00:08, 01:25). "
            "Never invent timestamps or events. Only report events that can be clearly observed. "
            "Create a chronological timeline of events and a concise overall summary of the entire video."
        )

        logger.info(f"Sending video analysis request to Gemini for {file_ref.name}...")
        models_to_try = ["gemini-3.5-flash", "gemini-3.8-flash"]
        last_error = None

        for model_name in models_to_try:
            try:
                logger.info(f"Attempting analysis with model {model_name}...")
                response = client.models.generate_content(
                    model=model_name,
                    contents=[file_ref, prompt],
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        response_schema=VideoAnalysisResult,
                        temperature=0.2,
                    ),
                )

                # Parse JSON
                raw_text = response.text or "{}"
                data = json.loads(raw_text)
                logger.info(f"Successfully analyzed video with {model_name}.")
                return data
            except Exception as e:
                logger.warning(f"Analysis with {model_name} failed: {e}")
                last_error = e

        # Fallback to standard prompt without structured schema if needed
        for model_name in models_to_try:
            try:
                fallback_prompt = (
                    prompt
                    + "\nRespond ONLY with a valid JSON object with keys 'summary' (string) and 'timeline' (list of objects with 'timestamp', 'event', 'description')."
                )
                response = client.models.generate_content(
                    model=model_name,
                    contents=[file_ref, fallback_prompt],
                    config=types.GenerateContentConfig(
                        temperature=0.2,
                    ),
                )
                text = response.text.strip()
                if "```json" in text:
                    text = text.split("```json")[1].split("```")[0].strip()
                elif "```" in text:
                    text = text.split("```")[1].split("```")[0].strip()
                return json.loads(text)
            except Exception as e2:
                logger.warning(f"Fallback analysis with {model_name} failed: {e2}")
                last_error = e2

        raise RuntimeError(f"Failed to analyze video with Gemini: {last_error}")

    def chat_about_video(
        self,
        file_ref: types.File,
        question: str,
        summary: Optional[str] = None,
        timeline: Optional[List[Dict[str, Any]]] = None,
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> str:
        """Answer user questions about the video, always providing MM:SS timestamps when relevant."""
        client = self._ensure_client()

        context_parts = []
        if summary:
            context_parts.append(f"Video Summary:\n{summary}")
        if timeline:
            formatted_timeline = "\n".join(
                [
                    f"- [{item.get('timestamp', '00:00')}] {item.get('event')}: {item.get('description')}"
                    for item in timeline
                ]
            )
            context_parts.append(f"Chronological Event Timeline:\n{formatted_timeline}")

        context_str = "\n\n".join(context_parts)

        system_instruction = (
            "You are VISIONX, an expert AI video intelligence assistant. "
            "You are answering questions about the provided video. "
            "RULES:\n"
            "1. Whenever the answer involves an event, action, movement, person, or occurrence, ALWAYS include the exact timestamp in MM:SS format, e.g., [00:31] or at 00:31.\n"
            "2. Never invent or hallucinate timestamps. Only state timestamps you can observe directly in the video.\n"
            "3. If the video does not contain enough information to answer the question, say so clearly.\n"
            "4. Be direct, concise, and helpful."
        )

        user_content_text = f"Context:\n{context_str}\n\nUser Question: {question}"

        contents = [
            file_ref,
            user_content_text,
        ]

        logger.info(f"Generating chat answer for question: '{question}'...")
        models_to_try = ["gemini-3.5-flash", "gemini-3.8-flash"]
        last_error = None

        for model_name in models_to_try:
            try:
                response = client.models.generate_content(
                    model=model_name,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        system_instruction=system_instruction,
                        temperature=0.3,
                    ),
                )
                return response.text or "I could not find an answer in the video."
            except Exception as e:
                logger.warning(f"Chat generation with {model_name} failed: {e}")
                last_error = e

        raise RuntimeError(f"Chat failed with Gemini: {last_error}")
