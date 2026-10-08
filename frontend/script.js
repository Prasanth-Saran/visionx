// VISIONX - AI Video Intelligence Frontend Script

(function () {
  // DOM Elements
  const videoInput = document.getElementById("videoInput");
  const sampleVideoBtn = document.getElementById("sampleVideoBtn");
  const fileNameDisplay = document.getElementById("fileNameDisplay");
  const analyzeBtn = document.getElementById("analyzeBtn");
  const statusBanner = document.getElementById("statusBanner");
  const statusText = document.getElementById("statusText");
  const sysStatusDot = document.getElementById("sysStatusDot");
  const sysStatusText = document.getElementById("sysStatusText");

  const videoPlayer = document.getElementById("videoPlayer");
  const videoPlaceholder = document.getElementById("videoPlaceholder");
  const videoDurationDisplay = document.getElementById("videoDurationDisplay");
  const videoCurrentTimeDisplay = document.getElementById("videoCurrentTimeDisplay");

  const summaryContent = document.getElementById("summaryContent");
  const timelineList = document.getElementById("timelineList");

  const chatMessages = document.getElementById("chatMessages");
  const chatInput = document.getElementById("chatInput");
  const sendChatBtn = document.getElementById("sendChatBtn");
  const quickBtns = document.querySelectorAll(".quick-btn");

  // State
  let currentVideoUrl = null;
  let isUploading = false;
  let isAnalyzing = false;
  let isChatting = false;

  // Helpers
  function setStatus(message, type = "info", isLoading = false) {
    if (!message) {
      statusBanner.className = "status-banner";
      statusBanner.style.display = "none";
      return;
    }
    statusBanner.className = `status-banner visible ${type}`;
    const spinnerHtml = isLoading ? '<div class="spinner"></div>' : "";
    statusText.innerHTML = `${spinnerHtml} <span>${message}</span>`;
  }

  async function parseJsonResponse(res) {
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return await res.json();
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      if (!res.ok) {
        throw new Error(`Server returned HTTP ${res.status}`);
      }
      throw new Error(text.slice(0, 120) || "Invalid server response");
    }
  }

  function formatSecondsToMMSS(seconds) {
    if (isNaN(seconds) || seconds < 0) return "00:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function parseTimestampToSeconds(tsStr) {
    if (!tsStr) return 0;
    // Clean brackets or punctuation
    const clean = tsStr.replace(/[\[\]\(\),]/g, "").trim();
    const parts = clean.split(":").map((p) => parseInt(p, 10));
    if (parts.some(isNaN)) return 0;

    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    } else if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
  }

  // Global seek function attached to window for inline onclick handlers
  window.seekVideo = function (timestamp) {
    const seconds = parseTimestampToSeconds(timestamp);
    if (!videoPlayer || isNaN(seconds)) return;

    videoPlayer.currentTime = seconds;
    videoPlayer.play().catch(() => {});

    // Visual feedback
    videoPlayer.style.outline = "2px solid #06b6d4";
    setTimeout(() => {
      videoPlayer.style.outline = "none";
    }, 600);

    // Scroll player into view smoothly if on small screens
    if (window.innerWidth < 1024) {
      videoPlayer.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  function convertTimestampsToClickable(text) {
    if (!text) return "";
    // Regex for [MM:SS] or MM:SS or HH:MM:SS
    const tsRegex = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g;
    return text.replace(tsRegex, (match) => {
      return `<button type="button" class="ts-chip" onclick="seekVideo('${match}')">▶ ${match}</button>`;
    });
  }

  // Update time display on video playback
  videoPlayer.addEventListener("timeupdate", () => {
    videoCurrentTimeDisplay.textContent = formatSecondsToMMSS(videoPlayer.currentTime);
  });

  videoPlayer.addEventListener("loadedmetadata", () => {
    videoDurationDisplay.textContent = ` / ${formatSecondsToMMSS(videoPlayer.duration)}`;
  });

  // Check initial backend status
  async function checkInitialStatus(retries = 3) {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) {
        if (retries > 0) {
          setTimeout(() => checkInitialStatus(retries - 1), 1500);
        }
        return;
      }
      const data = await parseJsonResponse(res);

      if (!data.api_key_configured) {
        setStatus(
          "Warning: GEMINI_API_KEY is not configured. Please check your .env file.",
          "error"
        );
        sysStatusDot.className = "status-dot idle";
        sysStatusText.textContent = "API Key Missing";
      } else {
        sysStatusDot.className = "status-dot";
        sysStatusText.textContent = "System Ready";
      }

      if (data.has_active_video && data.video.video_url) {
        loadVideoPlayer(data.video.video_url, data.video.filename);
        if (data.video.is_analyzed) {
          renderAnalysis(data.analysis.summary, data.analysis.timeline);
        } else {
          analyzeBtn.disabled = false;
          setStatus("Previous video loaded. Ready to analyze.", "info");
        }
      }
    } catch (err) {
      console.warn("Could not fetch status:", err);
      if (retries > 0) {
        setTimeout(() => checkInitialStatus(retries - 1), 1500);
      }
    }
  }

  function loadVideoPlayer(url, filename) {
    currentVideoUrl = url;
    videoPlayer.src = url;
    videoPlayer.style.display = "block";
    videoPlaceholder.style.display = "none";
    fileNameDisplay.textContent = filename || "video.mp4";
    fileNameDisplay.title = filename || "video.mp4";
  }

  // Video Upload Handler
  videoInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!file.type.includes("video") && !file.name.match(/\.(mp4|webm|mov|mkv|avi)$/i)) {
      setStatus("Please select a valid video file (MP4, WebM, MOV, AVI).", "error");
      return;
    }

    fileNameDisplay.textContent = file.name;
    const localBlobUrl = URL.createObjectURL(file);
    loadVideoPlayer(localBlobUrl, file.name);

    // Disable analyze button until upload finishes
    analyzeBtn.disabled = true;
    isUploading = true;
    setStatus(`Uploading "${file.name}" to Gemini Files API...`, "info", true);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });

      const data = await parseJsonResponse(res);
      if (!res.ok) {
        throw new Error(data.detail || "Upload failed");
      }

      // Switch to server URL
      if (data.video_url) {
        currentVideoUrl = data.video_url;
        videoPlayer.src = data.video_url;
      }

      setStatus("Video uploaded & ready for analysis. Click 'Analyze Video'.", "info");
      analyzeBtn.disabled = false;

      // Clear previous analysis
      summaryContent.innerHTML = `<span class="empty-state">Click "Analyze Video" above to generate AI summary and timeline.</span>`;
      timelineList.innerHTML = `<div class="empty-state">Event timeline will appear after analysis.</div>`;
    } catch (err) {
      console.error(err);
      setStatus(`Upload error: ${err.message}`, "error");
    } finally {
      isUploading = false;
    }
  });

  // Load Demo Video Handler
  if (sampleVideoBtn) {
    sampleVideoBtn.addEventListener("click", async () => {
      if (isUploading || isAnalyzing) return;

      isUploading = true;
      analyzeBtn.disabled = true;
      sampleVideoBtn.disabled = true;
      setStatus("Uploading built-in demo video to Gemini Files API...", "info", true);

      try {
        const res = await fetch("/api/load-sample", { method: "POST" });
        const data = await parseJsonResponse(res);
        if (!res.ok) {
          throw new Error(data.detail || "Failed to load sample video");
        }

        loadVideoPlayer(data.video_url, data.filename);
        setStatus("Sample video loaded & ready for analysis. Click 'Analyze Video'.", "info");
        analyzeBtn.disabled = false;

        summaryContent.innerHTML = `<span class="empty-state">Click "Analyze Video" above to generate AI summary and timeline.</span>`;
        timelineList.innerHTML = `<div class="empty-state">Event timeline will appear after analysis.</div>`;
      } catch (err) {
        console.error(err);
        setStatus(`Error loading sample: ${err.message}`, "error");
      } finally {
        isUploading = false;
        sampleVideoBtn.disabled = false;
      }
    });
  }

  // Video Analysis Handler
  analyzeBtn.addEventListener("click", async () => {
    if (isAnalyzing || isUploading) return;

    isAnalyzing = true;
    analyzeBtn.disabled = true;
    setStatus("Gemini is analyzing the video events, actions, and timestamps...", "info", true);

    summaryContent.innerHTML = `<div style="display:flex;align-items:center;gap:0.75rem;color:var(--cyan-accent);"><div class="spinner"></div> Examining video frames with Gemini...</div>`;
    timelineList.innerHTML = `<div style="display:flex;align-items:center;gap:0.75rem;color:var(--cyan-accent);"><div class="spinner"></div> Generating timestamped event timeline...</div>`;

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
      });

      const data = await parseJsonResponse(res);
      if (!res.ok) {
        throw new Error(data.detail || "Analysis failed");
      }

      renderAnalysis(data.summary, data.timeline);
      setStatus("Analysis completed successfully! You can now explore the timeline or chat below.", "info");

      // Add welcoming chatbot note
      appendChatMessage(
        "assistant",
        "Video analysis complete! I'm ready to answer any questions about the events, movements, people, or timestamps in this video."
      );
    } catch (err) {
      console.error(err);
      setStatus(`Analysis error: ${err.message}`, "error");
      summaryContent.innerHTML = `<span class="empty-state" style="color:var(--rose-accent);">Failed to analyze video: ${err.message}</span>`;
      timelineList.innerHTML = `<div class="empty-state" style="color:var(--rose-accent);">Analysis failed. Please try again.</div>`;
    } finally {
      isAnalyzing = false;
      analyzeBtn.disabled = false;
    }
  });

  function renderAnalysis(summary, timeline) {
    // Render Summary with clickable timestamps
    if (summary) {
      summaryContent.innerHTML = convertTimestampsToClickable(escapeHtml(summary));
    } else {
      summaryContent.innerHTML = `<span class="empty-state">No summary available.</span>`;
    }

    // Render Timeline
    if (timeline && timeline.length > 0) {
      timelineList.innerHTML = "";
      timeline.forEach((item) => {
        const itemEl = document.createElement("div");
        itemEl.className = "timeline-item";

        const ts = item.timestamp || "00:00";
        const title = item.event || "Event";
        const desc = item.description || "";

        itemEl.innerHTML = `
          <button type="button" class="ts-chip" onclick="seekVideo('${ts}')">▶ ${ts}</button>
          <div class="timeline-text">
            <div class="timeline-event-name">${escapeHtml(title)}</div>
            <div class="timeline-desc">${convertTimestampsToClickable(escapeHtml(desc))}</div>
          </div>
        `;
        timelineList.appendChild(itemEl);
      });
    } else {
      timelineList.innerHTML = `<div class="empty-state">No specific events detected in timeline.</div>`;
    }
  }

  // Chat Handler
  async function sendQuestion(text) {
    const question = text || chatInput.value.trim();
    if (!question || isChatting) return;

    if (!currentVideoUrl) {
      setStatus("Please upload and analyze a video before asking questions.", "error");
      return;
    }

    chatInput.value = "";
    isChatting = true;
    sendChatBtn.disabled = true;

    // Display User Bubble
    appendChatMessage("user", question);

    // Display Loading Bubble
    const loadingId = "loading-" + Date.now();
    appendLoadingBubble(loadingId);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });

      const data = await parseJsonResponse(res);
      removeLoadingBubble(loadingId);

      if (!res.ok) {
        throw new Error(data.detail || "Failed to get response");
      }

      appendChatMessage("assistant", data.answer);
    } catch (err) {
      console.error(err);
      removeLoadingBubble(loadingId);
      appendChatMessage(
        "assistant",
        `Sorry, I encountered an error answering your question: ${err.message}`
      );
    } finally {
      isChatting = false;
      sendChatBtn.disabled = false;
      chatInput.focus();
    }
  }

  function appendChatMessage(sender, text) {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${sender}`;

    const author = sender === "user" ? "You" : "VISIONX AI";
    const formattedText = convertTimestampsToClickable(escapeHtml(text));

    bubble.innerHTML = `
      <div class="chat-author">${author}</div>
      <div class="chat-text">${formattedText}</div>
    `;

    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function appendLoadingBubble(id) {
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble assistant";
    bubble.id = id;
    bubble.innerHTML = `
      <div class="chat-author">VISIONX AI</div>
      <div style="display:flex;align-items:center;gap:0.5rem;color:var(--text-muted);font-size:0.85rem;">
        <div class="spinner"></div> Consulting Gemini video model...
      </div>
    `;
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function removeLoadingBubble(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  // Quick questions
  quickBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const q = btn.getAttribute("data-q");
      if (q) sendQuestion(q);
    });
  });

  // Submit on Enter
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendQuestion();
    }
  });

  sendChatBtn.addEventListener("click", () => sendQuestion());

  // Escape HTML helper
  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Initialize
  checkInitialStatus();
})();
