// backend/server.js
// Express backend with explain, chat (non-streaming), and chat-stream (NDJSON chunked streaming fallback)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 8787;

// --- middleware
app.use(cors({ origin: "*", maxAge: 600 }));
app.use(express.json({ limit: "2mb" }));

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// health
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "ai-dev-mentor-backend", uptime: process.uptime() });
});

// core endpoint: explain (as before)
app.post("/v1/explain", async (req, res) => {
  try {
    const { query, languageId } = req.body || {};
    if (!query || typeof query !== "string" || query.length > 120) {
      return res.status(400).json({ ok: false, error: "Invalid 'query'." });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "Server missing GEMINI_API_KEY." });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
      generationConfig: { maxOutputTokens: 500 },
    });

    const prompt = `
You are "AI Dev Mentor", a concise programming tutor.

Term: "${query}"
Language/Context: ${languageId || "general"}

Write Markdown with this structure:

- First line: **one bold sentence** definition of the term in this context.
- Then exactly one short ${languageId || "language"} code example in a fenced block.
- One short tip line.
- If not programming-related, say: "Not a programming term."

Keep it < 180 words total.
`;

    const resp = await model.generateContent(prompt);
    const detail = (await resp.response.text()).trim();

    const firstLine = (detail.split("\n").find(l => l.trim().length > 0) || "").trim();
    const summary = firstLine.slice(0, 200);

    res.json({ ok: true, summary, detail });
  } catch (err) {
    console.error("Explain error:", err);
    res.status(500).json({ ok: false, error: "Model error" });
  }
});

// non-streaming chat (fallback / convenience)
app.post("/v1/chat", async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== "string" || message.length > 20000) {
      return res.status(400).json({ ok: false, error: "Invalid 'message'." });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "Server missing GEMINI_API_KEY." });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
      generationConfig: { maxOutputTokens: 1200 }
    });

    const sys = `
You are "AI Dev Mentor", a helpful coding assistant inside VS Code.
- Answer concisely but completely.
- Prefer Markdown with code fences.
- When code is provided, explain before suggesting changes.
- If asked to write code, include a brief rationale and a runnable snippet.
`;
    const prompt = `${sys}\n\nUser:\n${message}\n\nAssistant:`;

    const resp = await model.generateContent(prompt);
    const text = (await resp.response.text()).trim();

    res.json({ ok: true, text });
  } catch (err) {
    console.error("Chat error:", err);
    res.status(500).json({ ok: false, error: "Model error" });
  }
});

// streaming chat endpoint (NDJSON chunks).
// NOTE: This implementation uses the non-streaming model.generateContent() result and
// then emits it in small chunks so the client (extension) can show incremental text.
// If you have SDK streaming available, replace the inner logic to stream from Gemini directly.
app.post("/v1/chat-stream", async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== "string" || message.length > 20000) {
      return res.status(400).json({ ok: false, error: "Invalid 'message'." });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "Server missing GEMINI_API_KEY." });
    }

    // Build prompt
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
      generationConfig: { maxOutputTokens: 1200 }
    });

    const sys = `
You are a cheerful AI coding mentor who teaches step by step, like a supportive senior dev.
Your goals:
- Start with a friendly greeting or encouragement.
- Always break explanations into clear steps (1, 2, 3…) or bullet points.
- Format responses in Markdown for readability:
  - Use **bold** for key terms.
  - Use bullet points for lists.
  - Use numbered steps for processes.
  - Always wrap code in triple backticks with the correct language tag.
  - When showing code:
  - First explain the concept.
  - Then show a small runnable snippet.
  - Finally, explain what the snippet does.
- Keep tone conversational, light, and motivating (use emojis sparingly 🚀 💡 ✅).
- Always end with a reflective or guiding question to keep the learner engaged.
- Be concise, but never robotic — add some personality.
`;


    const prompt = `${sys}\n\nUser:\n${message}\n\nAssistant:`;

    // Call model (non-streaming here)
    const resp = await model.generateContent(prompt);
    const text = (await resp.response.text()).trim();

    // Prepare ndjson streaming
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Split text into reasonable chunks for streaming feel.
    const maxChunk = 120; // characters per chunk
    for (let i = 0; i < text.length; i += maxChunk) {
      const chunk = text.slice(i, i + maxChunk);
      res.write(JSON.stringify({ delta: chunk }) + "\n");
      // small pause to improve "streaming" feel (non-blocking)
      await new Promise((r) => setTimeout(r, 20));
    }

    // final sentinel with whole text too
    res.write(JSON.stringify({ done: true, text }) + "\n");
    res.end();
  } catch (err) {
    console.error("Chat-stream error:", err);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "Model error" });
    } else {
      try {
        res.write(JSON.stringify({ delta: `❌ Server error: ${String(err)}` }) + "\n");
        res.write(JSON.stringify({ done: true, text: null }) + "\n");
      } catch (e) {}
      try { res.end(); } catch (e) {}
    }
  }
});

app.listen(PORT, () => {
  console.log(`✅ AI Dev Mentor backend listening on http://localhost:${PORT}`);
});
