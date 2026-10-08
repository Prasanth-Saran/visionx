import express from 'express';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const UPLOADS_DIR = path.resolve(__dirname, 'uploads');
const FRONTEND_DIR = path.resolve(__dirname, 'frontend');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
    const uniqueName = `${Date.now()}_${safeName}${ext}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 250 * 1024 * 1024 }, // 250MB limit
});

app.use(express.json());

// In-memory state
interface TimelineItem {
  timestamp: string;
  event: string;
  description: string;
}

interface ChatEntry {
  question: string;
  answer: string;
}

interface VideoState {
  filename: string | null;
  filePath: string | null;
  videoUrl: string | null;
  geminiFile: any | null;
  summary: string | null;
  timeline: TimelineItem[];
  chatHistory: ChatEntry[];
  isAnalyzed: boolean;
}

const videoState: VideoState = {
  filename: null,
  filePath: null,
  videoUrl: null,
  geminiFile: null,
  summary: null,
  timeline: [],
  chatHistory: [],
  isAnalyzed: false,
};

// Initialize Gemini SDK
function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in environment or .env');
  }
  return new GoogleGenAI({ apiKey });
}

// Helper to wait until video is active
async function waitForGeminiFileActive(ai: GoogleGenAI, fileName: string, maxWaitSeconds = 120): Promise<any> {
  const start = Date.now();
  let file = await ai.files.get({ name: fileName });

  while (file.state === 'PROCESSING') {
    if ((Date.now() - start) / 1000 > maxWaitSeconds) {
      throw new Error('Timed out waiting for Gemini to process video file.');
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    file = await ai.files.get({ name: fileName });
  }

  if (file.state === 'FAILED') {
    throw new Error(`Gemini video processing failed: ${file.error?.message || 'Unknown error'}`);
  }

  return file;
}

// Helper to generate content with model fallback and automatic retry on spikes
async function generateWithRetry(ai: GoogleGenAI, contents: any[], config: any = {}, maxAttempts = 3): Promise<any> {
  const models = ['gemini-3.5-flash', 'gemini-3.8-flash'];
  let lastErr: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    for (const model of models) {
      try {
        console.log(`[Attempt ${attempt}] Calling model ${model}...`);
        const resp = await ai.models.generateContent({
          model,
          contents,
          config,
        });
        return resp;
      } catch (err: any) {
        lastErr = err;
        console.warn(`[Attempt ${attempt}] Model ${model} returned error:`, err?.message || err);
      }
    }
    if (attempt < maxAttempts) {
      console.log(`Waiting 2s before retry attempt ${attempt + 1}...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  throw lastErr || new Error('All model attempts failed');
}

// API Routes
app.get('/api/status', (_req, res) => {
  const hasKey = Boolean(process.env.GEMINI_API_KEY);
  res.json({
    api_key_configured: hasKey,
    has_active_video: Boolean(videoState.filename),
    video: {
      filename: videoState.filename,
      video_url: videoState.videoUrl,
      is_analyzed: videoState.isAnalyzed,
    },
    analysis: {
      summary: videoState.summary,
      timeline: videoState.timeline,
    },
    chat_count: videoState.chatHistory.length,
  });
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ detail: 'No video file provided.' });
    }

    const ai = getGeminiClient();
    const localPath = req.file.path;
    const originalName = req.file.originalname;

    // Upload to Gemini Files API
    const uploaded = await ai.files.upload({
      file: localPath,
      config: {
        mimeType: req.file.mimetype || 'video/mp4',
      },
    });

    // Wait until file is active
    const activeFile = await waitForGeminiFileActive(ai, uploaded.name || '');

    videoState.filename = originalName;
    videoState.filePath = localPath;
    videoState.videoUrl = `/uploads/${req.file.filename}`;
    videoState.geminiFile = activeFile;
    videoState.summary = null;
    videoState.timeline = [];
    videoState.chatHistory = [];
    videoState.isAnalyzed = false;

    res.json({
      status: 'success',
      message: 'Video successfully uploaded and ready for analysis.',
      filename: originalName,
      video_url: videoState.videoUrl,
    });
  } catch (err: any) {
    console.error('Upload error:', err);
    res.status(500).json({ detail: err.message || 'Video upload failed' });
  }
});

app.post('/api/load-sample', async (_req, res) => {
  try {
    const samplePath = path.resolve(UPLOADS_DIR, 'sample_test_video.mp4');
    if (!fs.existsSync(samplePath)) {
      return res.status(404).json({ detail: 'Sample demo video file not found.' });
    }

    const ai = getGeminiClient();
    const uploaded = await ai.files.upload({
      file: samplePath,
      config: {
        mimeType: 'video/mp4',
      },
    });

    const activeFile = await waitForGeminiFileActive(ai, uploaded.name || '');

    videoState.filename = 'sample_test_video.mp4';
    videoState.filePath = samplePath;
    videoState.videoUrl = '/uploads/sample_test_video.mp4';
    videoState.geminiFile = activeFile;
    videoState.summary = null;
    videoState.timeline = [];
    videoState.chatHistory = [];
    videoState.isAnalyzed = false;

    res.json({
      status: 'success',
      message: 'Sample video loaded and ready for analysis.',
      filename: 'sample_test_video.mp4',
      video_url: '/uploads/sample_test_video.mp4',
    });
  } catch (err: any) {
    console.error('Load sample error:', err);
    res.status(500).json({ detail: err.message || 'Failed to load sample video' });
  }
});

app.post('/api/analyze', async (_req, res) => {
  try {
    if (!videoState.geminiFile) {
      return res.status(400).json({ detail: 'No video uploaded yet. Please upload a video first.' });
    }

    const ai = getGeminiClient();
    const prompt = `Analyze this entire video carefully. Identify important events, people, actions, movements, interactions, unusual events, people entering/leaving, running, falling, and major scene changes.
For every important event provide an accurate timestamp strictly in MM:SS format (e.g. 00:08, 01:25).
Never invent timestamps or events. Only report events that can be clearly observed.
Create a chronological timeline of events and a concise overall summary of the entire video.
Return a valid JSON object with:
"summary": string (concise overall summary)
"timeline": array of objects, each containing:
  "timestamp": string in MM:SS format
  "event": string (short event name)
  "description": string (clear event description)`;

    const contents = [
      {
        fileData: {
          fileUri: videoState.geminiFile.uri,
          mimeType: videoState.geminiFile.mimeType,
        },
      },
      prompt,
    ];

    const resp = await generateWithRetry(ai, contents, {
      responseMimeType: 'application/json',
      temperature: 0.2,
    });

    const text = resp.text || '{}';
    const parsedData = JSON.parse(text);

    const summary = parsedData.summary || 'Video analysis completed.';
    const timeline = Array.isArray(parsedData.timeline) ? parsedData.timeline : [];

    videoState.summary = summary;
    videoState.timeline = timeline;
    videoState.isAnalyzed = true;

    res.json({
      status: 'success',
      summary,
      timeline,
    });
  } catch (err: any) {
    console.error('Analyze error:', err);
    res.status(500).json({ detail: err.message || 'Video analysis failed' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const question = req.body?.question?.trim();
    if (!question) {
      return res.status(400).json({ detail: 'Question cannot be empty.' });
    }

    if (!videoState.geminiFile) {
      return res.status(400).json({ detail: 'No video uploaded. Please upload a video first.' });
    }

    const ai = getGeminiClient();

    let context = '';
    if (videoState.summary) {
      context += `Video Summary:\n${videoState.summary}\n\n`;
    }
    if (videoState.timeline && videoState.timeline.length > 0) {
      context += `Event Timeline:\n${videoState.timeline.map((t) => `- [${t.timestamp}] ${t.event}: ${t.description}`).join('\n')}\n\n`;
    }

    const systemInstruction = `You are VISIONX, an expert AI video intelligence assistant.
You are answering questions about the provided video.
RULES:
1. Whenever the answer involves an event, action, movement, person, or occurrence, ALWAYS include the exact timestamp in MM:SS format, e.g., [00:31] or at 00:31.
2. Never invent or hallucinate timestamps. Only state timestamps you can observe directly in the video.
3. If the video does not contain enough information to answer the question, say so clearly.
4. Be direct, concise, and helpful.`;

    const userMessage = `${context}User Question: ${question}`;

    const contents = [
      {
        fileData: {
          fileUri: videoState.geminiFile.uri,
          mimeType: videoState.geminiFile.mimeType,
        },
      },
      userMessage,
    ];

    const resp = await generateWithRetry(ai, contents, {
      systemInstruction,
      temperature: 0.3,
    });

    const answerText = resp.text || 'I could not find an answer in the video.';

    videoState.chatHistory.push({ question, answer: answerText });

    res.json({
      status: 'success',
      question,
      answer: answerText,
    });
  } catch (err: any) {
    console.error('Chat error:', err);
    res.status(500).json({ detail: err.message || 'Failed to answer chat question' });
  }
});

// Static assets
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/static', express.static(FRONTEND_DIR));
app.use('/frontend', express.static(FRONTEND_DIR));

// Start server with Vite middleware in dev or static files in production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist/index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[VISIONX] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
