// src/extension.ts
// Complete VS Code extension file — inlines panel HTML/JS and streams chat from backend

import * as vscode from "vscode";
import * as http from "http";
import * as https from "https";

// --- Types from backend
type ExplainResponse = {
  ok: boolean;
  summary?: string;
  detail?: string;
  error?: string;
};

// --- Simple in-memory cache
const explanationCache = new Map<string, string>();
const MAX_CACHE = 1000;

// --- Globals
let selectionTimeout: NodeJS.Timeout | undefined;
let lastSelectionKey = "";
let currentPanel: vscode.WebviewPanel | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

// -----------------------------
// Activate
// -----------------------------
export function activate(context: vscode.ExtensionContext) {
  console.log("🚀 AI Dev Mentor Activated");

  // status bar entry
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = "$(mortar-board) AI Mentor";
  statusBarItem.tooltip = "Open AI Dev Mentor";
  statusBarItem.command = "ai-dev-mentor.openPanel";
  statusBarItem.show();

  // Command: manual explain
  const manual = vscode.commands.registerCommand(
    "ai-dev-mentor.explainSelection",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection).trim();
      if (!selection) {
        vscode.window.showInformationMessage("Select a word or phrase first.");
        return;
      }
      await handleExplain(selection, editor.document.languageId || "plaintext");
    }
  );

  // Event: selection watcher (double-click etc.)
  const onSel = vscode.window.onDidChangeTextEditorSelection(async (event) => {
    if (selectionTimeout) clearTimeout(selectionTimeout);

    selectionTimeout = setTimeout(async () => {
      const editor = event.textEditor;
      if (!editor) return;

      const sel = editor.selection;
      const word = editor.document.getText(sel).trim();
      if (!word || word.length > 80 || word.includes("\n")) return;

      const lang = editor.document.languageId || "plaintext";
      const key = `${word}::${lang}`;
      if (key === lastSelectionKey) return;
      lastSelectionKey = key;

      await handleExplain(word, lang);
    }, 160);
  });

  // Command: open panel
  const openPanel = vscode.commands.registerCommand(
    "ai-dev-mentor.openPanel",
    () => openOrRevealPanel(context)
  );

  context.subscriptions.push(statusBarItem, manual, onSel, openPanel);
}

// -----------------------------
// Deactivate
// -----------------------------
export function deactivate() {
  if (statusBarItem) statusBarItem.dispose();
  if (currentPanel) currentPanel.dispose();
}

// -----------------------------
// Feature 1: explain selection
// -----------------------------
async function handleExplain(term: string, languageId: string) {
  const cfg = vscode.workspace.getConfiguration("aiMentor");
  const enabled = cfg.get<boolean>("enabled", true);
  if (!enabled) return;

  const backendUrl = cfg.get<string>("backendUrl", "http://localhost:8787");

  const cacheKey = `${term}::${languageId}`;
  if (explanationCache.has(cacheKey)) {
    const md = explanationCache.get(cacheKey)!;
    showResult(term, languageId, md);
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Explaining "${term}"`,
      },
      async () => {
        const data = await postJson<ExplainResponse>(
          `${backendUrl}/v1/explain`,
          { query: term, languageId }
        );

        if (!data?.ok || !data.detail) {
          const msg = data?.error || "No explanation available.";
          vscode.window.showWarningMessage(`AI Mentor: ${msg}`);
          return;
        }

        explanationCache.set(cacheKey, data.detail);
        if (explanationCache.size > MAX_CACHE) {
          const first = explanationCache.keys().next().value;
          if (first !== undefined) explanationCache.delete(first);
        }

        showResult(term, languageId, data.detail);
      }
    );
  } catch (err: any) {
    vscode.window.showErrorMessage(
      `❌ Backend error: ${err?.message || String(err)}`
    );
    console.error("Backend fetch error:", err);
  }
}

// -----------------------------
// Popup w/ "Read more" → seed panel
// -----------------------------
async function showResult(
  term: string,
  languageId: string,
  markdown: string
) {
  const firstLine =
    markdown.split("\n").find((l) => l.trim().length > 0) || term;

  const sel = await vscode.window.showInformationMessage(
    `${term}: ${firstLine}`,
    "Read more"
  );
  if (sel !== "Read more") return;

  // 1) open or reveal the AI panel
  const panel = openOrRevealPanel();

  // 2) compute a short summary line (safe)
  const summaryLine = firstLine;

  // 3) send a "seedFromExplain" message to the webview
  panel.webview.postMessage({
    type: "seedFromExplain",
    term,
    languageId,
    summaryLine,
  });

  // Also ensure panel is visible
  panel.reveal(vscode.ViewColumn.Two);
}

// -----------------------------
// Panel create / wiring
// -----------------------------
function openOrRevealPanel(context?: vscode.ExtensionContext): vscode.WebviewPanel {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Two);
    return currentPanel;
  }

  currentPanel = vscode.window.createWebviewPanel(
    "aiDevMentor",
    "AI Dev Mentor",
    { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  currentPanel.webview.html = getPanelHtml();

  // bridge: panel -> extension
  currentPanel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg !== "object") return;

    // user typed a message OR auto-seeded message
    if (msg.type === "userMessage" && typeof msg.message === "string") {
      // msg.id may be present (webview assigns IDs to match streaming placeholders)
      const id = msg.id || null;
      const cfg = vscode.workspace.getConfiguration("aiMentor");
      const backendUrl = cfg.get<string>("backendUrl", "http://localhost:8787");

      // stream the chat from backend and forward chunks to webview
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "AI Mentor is thinking...",
        },
        async () => {
          try {
            await streamChatToWebview(`${backendUrl}/v1/chat-stream`, msg.message, id);
          } catch (err: any) {
            currentPanel?.webview.postMessage({
              type: "aiDelta",
              id,
              delta: `❌ Backend error: ${err?.message || String(err)}`,
            });
            currentPanel?.webview.postMessage({ type: "aiDone", id, text: null });
          }
        }
      );
    } else if (msg.type === "insertCode" && typeof msg.code === "string") {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        editor.edit((editBuilder) => {
          editBuilder.insert(editor.selection.active, msg.code);
        });
      }
      return;
    }
  });

  currentPanel.onDidDispose(() => {
    currentPanel = undefined;
  });

  return currentPanel;
}

// -----------------------------
// Stream helper: connects to backend /v1/chat-stream and forwards NDJSON chunks to webview
// -----------------------------
function streamChatToWebview(streamUrl: string, message: string, id: string | null) {
  return new Promise<void>((resolve, reject) => {
    try {
      const urlObj = new URL(streamUrl);
      const isHttps = urlObj.protocol === "https:";
      const client = isHttps ? https : http;

      const payload = Buffer.from(JSON.stringify({ message }));

      const options: http.RequestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + (urlObj.search || ""),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          Accept: "application/x-ndjson",
        },
      };

      const req = client.request(options, (res) => {
        res.setEncoding("utf8");
        let buf = "";

        res.on("data", (chunk: string) => {
          buf += chunk;
          const parts = buf.split("\n");
          buf = parts.pop() || "";

          for (const line of parts) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.delta !== undefined) {
                currentPanel?.webview.postMessage({
                  type: "aiDelta",
                  id,
                  delta: obj.delta,
                });
              } else if (obj.done) {
                // obj.text may contain full text
                currentPanel?.webview.postMessage({
                  type: "aiDone",
                  id,
                  text: obj.text || null,
                });
              } else {
                // unknown structure — forward raw as delta
                currentPanel?.webview.postMessage({
                  type: "aiDelta",
                  id,
                  delta: String(obj),
                });
              }
            } catch (e) {
              // if JSON.parse fails — forward raw fragment
              currentPanel?.webview.postMessage({
                type: "aiDelta",
                id,
                delta: line,
              });
            }
          }
        });

        res.on("end", () => {
          // if any trailing buffer left, try send it
          if (buf.trim()) {
            try {
              const obj = JSON.parse(buf);
              if (obj.delta !== undefined) {
                currentPanel?.webview.postMessage({ type: "aiDelta", id, delta: obj.delta });
              } else if (obj.done) {
                currentPanel?.webview.postMessage({ type: "aiDone", id, text: obj.text || null });
              }
            } catch {
              currentPanel?.webview.postMessage({ type: "aiDelta", id, delta: buf });
            }
          }
          resolve();
        });
      });

      req.on("error", (e) => {
        reject(e);
      });

      req.write(payload);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// -----------------------------
// POST JSON util (non-streaming)
function postJson<T = unknown>(urlStr: string, payload: any, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    let urlObj: URL;
    try {
      urlObj = new URL(urlStr);
    } catch {
      reject(new Error("Invalid backend URL"));
      return;
    }

    const dataBuf = Buffer.from(JSON.stringify(payload));
    const isHttps = urlObj.protocol === "https:";
    const client = isHttps ? https : http;

    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + (urlObj.search || ""),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": dataBuf.length,
      },
    };

    const req = client.request(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body}`)); 
        }
        try {
          const json = JSON.parse(body);
          resolve(json as T);
        } catch (e) {
          reject(new Error("Invalid JSON from server"));
        }
      });
    });

    req.on("error", (e) => reject(e));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Request timeout"));
    });

    req.write(dataBuf);
    req.end();
  });
}

// -----------------------------
// Webview HTML (session-only chat state)
// -----------------------------

function getPanelHtml() {
  return `<!DOCTYPE html>
<html lang="en">  
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Dev Mentor</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --panel: var(--vscode-sideBar-background);
      --border: var(--vscode-panel-border);
      --accent: var(--vscode-button-background);
      --accent-contrast: var(--vscode-button-foreground);
      --chip-bg: rgba(127,127,127,0.12);
      --chip-hover: rgba(127,127,127,0.20);
      --bubble-user: rgba(0,0,0,0.2);
      --bubble-ai: rgba(0,128,64,0.22);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border);
      --kbd-bg: rgba(127,127,127,0.2);
      --shadow: 0 6px 24px rgba(0,0,0,0.15);
      --radius: 12px;
    }
    html, body { height: 100%; }
    body {
      margin: 0; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Inter, Arial, sans-serif;
      background-color: #0C0D0C; color: var(--fg); display: flex; flex-direction: column; 
    }
    .header { display:flex; align-items:center; justify-content:space-between; padding:4px 4px; border-bottom:1px solid var(--border);border-radius:1px; position:sticky; top:0; z-index:2;background-image: linear-gradient( 109.6deg,  rgba(0,0,0,1) 11.2%, rgba(11,132,145,1) 91.1% );}

    .brand { display:flex; align-items:center; gap:10px; font-weight:800; letter-spacing:.2px;  }

    .wrap { display:flex; flex-direction:column; gap:12px; padding-top:14px; height:100%; background: radial-gradient(1200px 400px at 0% 0%, rgba(16,185,129,.05), transparent 60%), radial-gradient(1200px 400px at 100% 0%, rgba(59,130,246,.05), transparent 60%); }

    .chat { position:relative; flex:1 1 auto; min-height:180px; padding:1px; overflow:auto; }

    .msg { display:flex; gap:10px; margin-bottom:14px; align-items:flex-start;font-size: 14px; }
    .avatar { width:28px; height:28px; border-radius:50%;  border:1px solid var(--border); display:inline-flex; align-items:center; justify-content:center; font-size:12px; flex:0 0 auto; user-select:none; }

    .bubble { max-width:100%; padding:10px 12px; box-shadow:var(--shadow); line-height:1.85; white-space:pre-wrap; word-break:break-word; }

    .user { flex-direction: row-reverse; }
    
    .user .bubble { background: #3b82f6; color: #fff; margin-left:auto; max-width:80%;  border-radius:12px; border:1px solid var(--border); }
    
    .composer { display:flex; align-items:center; gap:8px; border:1px solid var(--border); border-radius:var(--radius); padding:8px; background: var(--input-bg); }
    textarea { flex:1 1 auto; resize:none; border:none; outline:none; background:transparent; color:var(--input-fg); max-height:140px; min-height:40px; padding:6px 8px; font-family:inherit; font-size:13px; line-height:1.4; }

    .send { border:none; outline:none; cursor:pointer; background:var(--accent); color:var(--accent-contrast); padding:8px 12px; border-radius:10px; font-weight:600; }

    .send:disabled { opacity:.6; cursor:not-allowed; }

    .hints { display:flex; gap:10px; align-items:center; color:var(--muted); font-size:12px; margin-top:6px; }
    kbd { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; background:var(--kbd-bg); border:1px solid var(--border); padding:2px 6px; border-radius:6px; font-size:11px; }

    .code-block {
      background: #07111a;
      border-radius: 8px;
      border: 1px solid var(--border);
      margin: 8px 0;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .code-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 10px;
      background: rgba(255,255,255,0.05);
      font-size: 12px;
      color: var(--muted);
    }
    .code-lang {
      font-weight: 600;
      color:#4FB037;
    }
    .copy-btn {
      background: transparent;
      border: 1px solid var(--border);
      padding: 4px 8px;
      border-radius: 6px;
      color: var(--fg);
      cursor: pointer;
      font-size: 12px;
      margin-left: 6px;
    }
    .copy-btn:hover {
      background: rgba(255,255,255,0.05);
    }
    pre {
      margin: 0;
      padding: 12px 14px;
      overflow: auto;
      font-family: ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 13px;
      color: blue;
      line-height: 1.5;
    }
    code.inline {
      background:  rgba(255,255,255,0.07);;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
      font-size: 0.9em;
    }
    code {
      font-family: var(--monaco-monospace-font, ui-monospace, Menlo, Monaco, Consolas, monospace);
      color: var(--vscode-textPreformat-foreground, inherit);
      background-color: #4e4a4a00;
      padding: 1px 3px;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">
      <div style="width:22px;height:22px;border-radius:6px;background:linear-gradient(145deg,#10b981,#3b82f6)"></div>
      <div>AI Dev Mentor <span style="color:var(--muted);font-weight:400;margin-left:8px">/ Chat</span></div>
    </div>
    <div style="display:flex;gap:8px">
      <button id="btn-new" title="New chat" class="iconbtn" style="padding:6px;border-radius:6px">+</button>
      <button id="btn-refresh" title="Refresh" class="iconbtn" style="padding:6px;border-radius:6px">⟳</button>
      <button id="btn-settings" title="Settings" class="iconbtn" style="padding:6px;border-radius:6px">⚙</button>
    </div>
  </div>

  <div class="wrap">
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px">
      <div class="chip" id="chip-explain">Explain this code</div>
      <div class="chip" id="chip-bugs">Find bugs</div>
      <div class="chip" id="chip-opt">Optimize performance</div>
      <div class="chip" id="chip-tests">Write tests</div>
    </div>

    <div id="chat" class="chat" role="log" aria-live="polite">
      <div class="msg ai">
        <div class="avatar">🤖</div>
        <div class="bubble">Welcome! Ask about your code, or paste a snippet and ask for analysis.</div>
      </div>
    </div>

    <div>
      <div class="composer">
        <textarea id="input" placeholder="Ask me anything about your code…"></textarea>
        <button class="send" id="send">Send</button>
      </div>
      <div class="hints" style="color:var(--muted)">
        <span style="margin-right:12px"><kbd>⏎</kbd> Send</span>
        <span><kbd>⇧ ⏎</kbd> New line</span>
      </div>
    </div>
  </div>

  <script>
  const vscode = acquireVsCodeApi();
  const chat = document.getElementById('chat');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');

  // pending map: id -> bubble element (for streaming updates)
  const pending = new Map();
  let counter = 0;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderMarkdown(md) {
    if (!md) return "";
    // first escape entire input to avoid injection
    const safeAll = escapeHtml(md);

    // Replace code fences with HTML blocks
    let html = safeAll.replace(/\`\`\`(\\w+)?\\n([\\s\\S]*?)\`\`\`/g, (match, lang, code) => {
      const safeCode = code.trim();
      const dataCode = safeCode.replace(/"/g, "&quot;");
      
      return '<div class="code-block">' +
        '<div class="code-toolbar">' +
          '<span class="code-lang">' + (lang || "code") + '</span>' +
          '<div>' +
            '<button class="copy-btn" data-action="copy">Copy</button>' +
            '<button class="copy-btn" data-action="insert">Insert</button>' +
          '</div>' +
        '</div>' +
        '<pre><code data-code="' + dataCode + '">' + safeCode + '</code></pre>' +
      '</div>';
    });

    // Inline code
    html = html.replace(/\`([^\`\\n]+)\`/g, '<code class="inline">$1</code>');

    // Paragraphs and line breaks
    html = html.replace(/\\n{2,}/g, "</p><p>");
    html = "<p>" + html.replace(/\\n/g, "<br>") + "</p>";

    return html;
  }

  function addMessage(role, text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text || '';

    wrap.appendChild(bubble);
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    return bubble;
  }

  function handleSend(explicitText) {
    const val = typeof explicitText === 'string'
      ? explicitText
      : (input.value || '').trim();
    if (!val) return;

    addMessage('user', val);
    input.value = '';

    // create an AI placeholder bubble and register pending id
    const id = 'm' + (++counter);
    const placeholder = addMessage('ai', '…');
    pending.set(id, placeholder);

    vscode.postMessage({ type: 'userMessage', id, message: val });
  }

  // UI events
  sendBtn.addEventListener('click', () => handleSend());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  document.getElementById('btn-new').addEventListener('click', () => {
    chat.innerHTML = '';
    addMessage('ai', 'New chat started. How can I help?');
    input.focus();
  });

  document.getElementById('btn-refresh').addEventListener('click', () => {
    addMessage('ai', 'Refreshed. (No editor context wired yet)');
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    addMessage('ai', 'Settings UI coming later.');
  });

  // quick chips
  Array.from(document.querySelectorAll('.chip')).forEach(c => {
    c.addEventListener('click', () => {
      input.value = c.textContent.trim();
      input.focus();
    });
  });

  // Handle code block button clicks (copy/insert) using event delegation
  document.addEventListener('click', (e) => {
    const button = e.target;
    if (!button.classList.contains('copy-btn')) return;
    
    const action = button.getAttribute('data-action');
    const codeBlock = button.closest('.code-block');
    if (!codeBlock) return;
    
    const codeEl = codeBlock.querySelector('code');
    if (!codeEl) return;
    
    const codeText = codeEl.getAttribute('data-code') || codeEl.textContent;
    
    if (action === 'copy') {
      navigator.clipboard.writeText(codeText).then(() => {
        const originalText = button.textContent;
        button.textContent = 'Copied!';
        setTimeout(() => { button.textContent = originalText; }, 1200);
      });
    } else if (action === 'insert') {
      vscode.postMessage({ type: 'insertCode', code: codeText });
    }
  });

  // Bridge: extension -> webview
  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    
    // ai incremental chunk
    if (msg.type === 'aiDelta') {
      const id = msg.id;
      const delta = msg.delta || '';
      if (id && pending.has(id)) {
        const bubble = pending.get(id);
        // append delta to placeholder
        bubble.textContent = (bubble.textContent || '') + delta;
        chat.scrollTop = chat.scrollHeight;
      } else {
        // just append as a fresh AI message
        addMessage('ai', delta);
      }
    }

    // ai done — finalize or show final text
    if (msg.type === 'aiDone') {
      const id = msg.id;
      const finalText = msg.text;
      if (id && pending.has(id)) {
        const bubble = pending.get(id);
        if (finalText !== null && typeof finalText === 'string') {
          bubble.innerHTML = renderMarkdown(finalText);
        }
        pending.delete(id);
        chat.scrollTop = chat.scrollHeight;
      } else if (finalText) {
        const bubble = addMessage('ai', '');
        bubble.innerHTML = renderMarkdown(finalText);
      }
    }

    // seed: selection -> auto-send a "deep explain" prompt
    if (msg.type === 'seedFromExplain' && typeof msg.term === 'string') {
      addMessage('user', 'Explain: ' + msg.term);
      const id = 'm' + (++counter);
      const placeholder = addMessage('ai', '…');
      pending.set(id, placeholder);

      const lang = msg.languageId || 'general';
      const seedPrompt =
        'Deeply explain the term "' + msg.term + '" in the context of ' + lang +
        '. Provide a clear definition, multiple short examples, typical pitfalls, and a quick tip. Keep practical.';

      vscode.postMessage({ type: 'userMessage', id, message: seedPrompt });
    }
  });
  </script>
</body>
</html>`;
}

