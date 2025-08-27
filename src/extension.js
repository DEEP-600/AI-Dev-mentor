"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
/* src/extension.ts */
const vscode = __importStar(require("vscode"));
// Use existing fetch if available, otherwise fallback to node-fetch (v2).
// This hybrid pattern avoids ESM/CJS import issues in extension bundles.
let fetchFn;
try {
    // @ts-ignore
    fetchFn = globalThis.fetch;
    if (!fetchFn)
        fetchFn = require("node-fetch");
}
catch (e) {
    // final fallback
    // @ts-ignore
    fetchFn = require("node-fetch");
}
// Simple in-memory cache: key = `${term}::${lang}`, value = markdown string
const explanationCache = new Map();
const MAX_CACHE = 1000; // keep it bounded
let selectionTimeout;
let lastSelectionKey = "";
function activate(context) {
    console.log("🚀 AI Dev Mentor Activated");
    // Listen to selection change (double-click triggers selection)
    const disposable = vscode.window.onDidChangeTextEditorSelection(async (event) => {
        // debounce to avoid double firing / intermediate states
        if (selectionTimeout)
            clearTimeout(selectionTimeout);
        selectionTimeout = setTimeout(async () => {
            const editor = event.textEditor;
            if (!editor)
                return;
            const selection = editor.selection;
            const word = editor.document.getText(selection).trim();
            // minimal sanity checks for word
            if (!word || word.length > 50 || word.includes("\n"))
                return;
            const lang = editor.document.languageId || "plaintext";
            const key = `${word}::${lang}`;
            // Avoid repeating for same selection rapidly
            if (key === lastSelectionKey)
                return;
            lastSelectionKey = key;
            // If cached, show cached result
            if (explanationCache.has(key)) {
                const cachedMd = explanationCache.get(key);
                showResult(word, cachedMd);
                return;
            }
            // Show a small thinking message
            vscode.window.showInformationMessage(`⏳ Explaining "${word}"...`);
            // Read settings
            const cfg = vscode.workspace.getConfiguration("aiMentor");
            const apiKey = cfg.get("apiKey") || "";
            const apiEndpoint = cfg.get("apiEndpoint") ||
                "https://api.openai.com/v1/chat/completions";
            const modelName = cfg.get("modelName") || "gpt-3.5-turbo";
            // If no API key, prompt user (fast path: you can set in settings)
            if (!apiKey) {
                vscode.window.showWarningMessage("AI Mentor: No API key set. Go to Settings → AI Mentor to add your OpenAI API key.");
                return;
            }
            try {
                const md = await fetchExplanation(word, lang, apiEndpoint, apiKey, modelName);
                // Cache (bounded)
                explanationCache.set(key, md);
                if (explanationCache.size > MAX_CACHE) {
                    // remove oldest entry safely
                    const iter = explanationCache.keys();
                    const firstKey = iter.next().value;
                    if (firstKey !== undefined) {
                        explanationCache.delete(firstKey);
                    }
                }
                showResult(word, md);
            }
            catch (err) {
                vscode.window.showErrorMessage(`❌ Failed to fetch explanation: ${err?.message || err}`);
                console.error("AI Mentor fetch error:", err);
            }
        }, 160); // 160ms debounce
    });
    context.subscriptions.push(disposable);
}
function deactivate() { }
/* Helpers */
/**
 * Call the model and return formatted Markdown string.
 * Keeps the prompt small and deterministic.
 */
async function fetchExplanation(term, languageId, apiEndpoint, apiKey, modelName) {
    // Build a short system prompt that forces "programming sense" output
    const systemPrompt = `You are CodeMentor, a concise programming tutor. Always interpret terms in a programming context if relevant. Return a short Markdown answer with:
- A bold one-line Definition,
- A single code block example (use the user's language),
- A one-line Tip,
- A Sources: line with a canonical URL if applicable.
If the term is not programming-related, respond "Not a programming term." Keep output <= 120 words.`;
    // Map some VS Code languageId to friendly language names
    const langMap = {
        javascript: "javascript",
        typescript: "javascript",
        html: "html",
        css: "css",
        python: "python",
        java: "java"
    };
    const userLang = langMap[languageId] || "plaintext";
    const userPrompt = `TERM: "${term}"
LANGUAGE: "${userLang}"
Instruction: Explain the term in programming context (Definition, Example, Tip). Return only Markdown text.`;
    // Call OpenAI chat completions (Chat API)
    const body = {
        model: modelName,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ],
        max_tokens: 140,
        temperature: 0.0
    };
    const res = await fetchFn(apiEndpoint, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
    }
    const data = await res.json();
    // OpenAI shape: choices[0].message.content
    const content = data?.choices?.[0]?.message?.content;
    if (!content)
        throw new Error("No content returned from model.");
    // Simple sanitation: trim and ensure markdown
    const md = content.trim();
    return md;
}
/**
 * Show a toast with short first line and a Read More action that opens a markdown webview.
 */
function showResult(term, markdown) {
    // get first line to display briefly
    const firstLine = markdown.split("\n").find((l) => l.trim().length > 0) || term;
    vscode.window.showInformationMessage(`${term}: ${firstLine}`, "Read more")
        .then((selection) => {
        if (selection === "Read more") {
            const panel = vscode.window.createWebviewPanel("aiMentorDetails", `AI Mentor: ${term}`, vscode.ViewColumn.Beside, { enableScripts: false });
            // Render markdown into HTML (simple)
            panel.webview.html = renderMarkdownToHtml(markdown);
        }
    });
}
/** Minimal markdown to HTML rendering (safe). */
function renderMarkdownToHtml(md) {
    // Use built-in vscode MarkdownString if we wanted to render inside editor;
    // For a webview we'll include simple HTML and let the browser show it.
    // Keep it minimal to avoid XSS (we control content).
    const escaped = md
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    // replace code blocks ```lang ... ```
    const html = escaped
        .replace(/```([\s\S]*?)```/g, (match, p1) => `<pre><code>${p1}</code></pre>`)
        .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br/>");
    return `<!doctype html><html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial; padding:12px;">${html}</body></html>`;
}
//# sourceMappingURL=extension.js.map