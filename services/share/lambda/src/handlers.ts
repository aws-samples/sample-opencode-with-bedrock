import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { gzipSync } from "zlib";
import { Share } from "./share.js";

// Configurable CORS origin — defaults to restrictive in production
const ALLOWED_ORIGIN = process.env.CORS_ALLOWED_ORIGIN || "*";

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Share-Secret",
};

// Helper to create response
function createResponse(statusCode: number, body: any): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
    body: JSON.stringify(body),
  };
}

// Helper to parse request body
function parseBody(event: APIGatewayProxyEventV2): any {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

// Escape string for safe insertion into HTML/JS context
function escapeForHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;");
}

// Health check handler
export async function healthHandler(): Promise<APIGatewayProxyResultV2> {
  return createResponse(200, {
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "opencode-share-api",
  });
}

// Create share handler
export async function createShareHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const body = parseBody(event);

    if (!body.sessionID) {
      return createResponse(400, { error: "sessionID is required" });
    }

    const share = await Share.create({ sessionID: body.sessionID });

    // Use configured base URL if available, otherwise derive from request headers
    const baseUrl = process.env.SHARE_VIEWER_BASE_URL
      || `${event.headers["x-forwarded-proto"] || "https"}://${event.headers["x-forwarded-host"] || event.headers.host || "localhost"}`;

    return createResponse(200, {
      id: share.id,
      secret: share.secret,
      url: `${baseUrl}/share/${share.id}`,
    });
  } catch (error) {
    if (error instanceof Share.Errors.AlreadyExists) {
      return createResponse(409, { error: "Share already exists" });
    }
    console.error("Error creating share:", error);
    return createResponse(500, { error: "Failed to create share" });
  }
}

// Sync share data handler
export async function syncShareHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const shareID = event.pathParameters?.shareID;
    if (!shareID) {
      return createResponse(400, { error: "shareID is required" });
    }

    const body = parseBody(event);

    if (!body.secret) {
      return createResponse(400, { error: "secret is required" });
    }

    if (!body.data || !Array.isArray(body.data)) {
      return createResponse(400, { error: "data array is required" });
    }

    await Share.sync({
      share: { id: shareID, secret: body.secret },
      data: body.data as Share.Data[],
    });

    // Trigger WebSocket broadcast (single call — not duplicated in Share.sync)
    await Share.broadcastUpdate(shareID);

    return createResponse(200, { success: true });
  } catch (error) {
    if (error instanceof Share.Errors.NotFound) {
      return createResponse(404, { error: "Share not found" });
    }
    if (error instanceof Share.Errors.InvalidSecret) {
      return createResponse(403, { error: "Invalid secret" });
    }
    if (error instanceof Share.Errors.PayloadTooLarge) {
      return createResponse(413, { error: error.message });
    }
    console.error("Error syncing share:", error);
    return createResponse(500, { error: "Failed to sync share" });
  }
}

// Get share data handler
// Returns gzip-compressed response to stay under ALB's 1MB Lambda response limit.
// A long session can produce >1MB of JSON; gzip typically achieves 5-10x compression
// on repetitive JSON/code content.
export async function getShareDataHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const shareID = event.pathParameters?.shareID;
    if (!shareID) {
      return createResponse(400, { error: "shareID is required" });
    }

    const data = await Share.data(shareID);
    const jsonBody = JSON.stringify(data);

    // Check if client accepts gzip and response is large enough to benefit
    const acceptEncoding = (event.headers?.["accept-encoding"] || "").toLowerCase();
    const shouldGzip = acceptEncoding.includes("gzip") && jsonBody.length > 1024;

    if (shouldGzip) {
      const compressed = gzipSync(Buffer.from(jsonBody));
      console.log(`Response compressed: ${jsonBody.length} -> ${compressed.length} bytes (${Math.round(compressed.length / jsonBody.length * 100)}%)`);
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          ...corsHeaders,
        },
        body: compressed.toString("base64"),
        isBase64Encoded: true,
      };
    }

    return createResponse(200, data);
  } catch (error) {
    console.error("Error getting share data:", error);
    return createResponse(500, { error: "Failed to get share data" });
  }
}

// Delete share handler
export async function deleteShareHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const shareID = event.pathParameters?.shareID;
    if (!shareID) {
      return createResponse(400, { error: "shareID is required" });
    }

    const body = parseBody(event);

    if (!body.secret) {
      return createResponse(400, { error: "secret is required" });
    }

    await Share.remove({ id: shareID, secret: body.secret });
    return createResponse(200, { success: true });
  } catch (error) {
    if (error instanceof Share.Errors.NotFound) {
      return createResponse(404, { error: "Share not found" });
    }
    if (error instanceof Share.Errors.InvalidSecret) {
      return createResponse(403, { error: "Invalid secret" });
    }
    console.error("Error removing share:", error);
    return createResponse(500, { error: "Failed to remove share" });
  }
}

// View share handler - returns HTML directly
export async function viewShareHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const shareID = event.pathParameters?.shareID;
    if (!shareID) {
      return createResponse(400, { error: "shareID is required" });
    }

    const share = await Share.get(shareID);
    if (!share) {
      return createResponse(404, { error: "Share not found" });
    }

    // Escape shareID to prevent XSS injection
    const safeShareId = escapeForHtml(shareID);
    // For JavaScript string values inside <script>, use JSON.stringify
    // (escapeForHtml would turn / into &#x2F; which breaks URLs in JS context)
    const jsShareId = JSON.stringify(shareID);
    const jsApiBaseUrl = JSON.stringify(process.env.API_GATEWAY_URL || '');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenCode Share</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        :root {
            --bg-base: #fafafa; --bg-stronger: #f5f5f5; --bg-strong: #fff;
            --text-base: #171717; --text-strong: #000; --text-weak: #737373;
            --border-weak: #e5e5e5; --accent: #171717; --accent-text: #fff;
        }
        @media (prefers-color-scheme: dark) {
            :root {
                --bg-base: #0a0a0a; --bg-stronger: #171717; --bg-strong: #262626;
                --text-base: #e5e5e5; --text-strong: #fff; --text-weak: #a3a3a3;
                --border-weak: #262626; --accent: #fff; --accent-text: #000;
            }
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg-base); color: var(--text-base); line-height: 1.6;
        }
        .header {
            background: var(--bg-strong); border-bottom: 1px solid var(--border-weak);
            padding: 12px 24px; display: flex; justify-content: space-between; align-items: center;
        }
        .logo { display: flex; align-items: center; gap: 12px; text-decoration: none; color: var(--text-strong); font-weight: 600; }
        .main { max-width: 900px; margin: 0 auto; padding: 24px; }
        .loading { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 400px; gap: 16px; }
        .spinner { width: 40px; height: 40px; border: 3px solid var(--border-weak); border-top-color: var(--accent); border-radius: 50%; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .error { text-align: center; padding: 80px 24px; }
        .session-header { margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid var(--border-weak); }
        .session-meta { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
        .badge { background: var(--accent); color: var(--accent-text); padding: 4px 10px; border-radius: 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
        .session-title { font-size: 28px; font-weight: 700; color: var(--text-strong); margin-bottom: 12px; }
        .message { margin-bottom: 24px; }
        .message-header { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
        .message-role { padding: 4px 10px; border-radius: 4px; font-size: 12px; text-transform: uppercase; }
        .message-role.user { background: var(--accent); color: var(--accent-text); }
        .message-role.assistant { background: var(--bg-stronger); }
        .message-content { background: var(--bg-strong); border: 1px solid var(--border-weak); border-radius: 8px; padding: 16px 20px; }
        pre { background: #1e1e1e; color: #d4d4d4; padding: 16px; border-radius: 8px; overflow-x: auto; font-family: monospace; font-size: 13px; margin: 12px 0; }
        code { font-family: monospace; font-size: 0.9em; background: var(--bg-stronger); padding: 2px 6px; border-radius: 4px; }
        .hidden { display: none !important; }
        .part-reasoning { background: var(--bg-stronger); border-left: 3px solid var(--text-weak); border-radius: 0 8px 8px 0; margin: 12px 0; overflow: hidden; }
        .part-reasoning summary { padding: 12px 16px; cursor: pointer; font-style: italic; color: var(--text-weak); display: flex; align-items: center; gap: 8px; }
        .part-reasoning summary:hover { background: var(--bg-base); }
        .part-reasoning-content { padding: 12px 16px; font-style: italic; color: var(--text-weak); border-top: 1px solid var(--border-weak); }
        .part-tool { background: var(--bg-stronger); border: 1px solid var(--border-weak); border-radius: 8px; margin: 12px 0; overflow: hidden; }
        .part-tool summary { padding: 12px 16px; cursor: pointer; font-weight: 500; display: flex; align-items: center; gap: 8px; }
        .part-tool summary:hover { background: var(--bg-base); }
        .part-tool-content { padding: 16px; border-top: 1px solid var(--border-weak); }
        .part-file { display: flex; align-items: center; gap: 12px; background: var(--bg-stronger); border: 1px solid var(--border-weak); border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
        .part-image { max-width: 100%; border-radius: 8px; margin: 12px 0; }
        .message-content h1, .message-content h2, .message-content h3 { margin: 16px 0 12px; color: var(--text-strong); }
        .message-content p { margin: 12px 0; }
        .message-content ul, .message-content ol { margin: 12px 0; padding-left: 24px; }
        .message-content li { margin: 4px 0; }
        .message-content a { color: var(--accent); text-decoration: underline; }
        .message-content blockquote { border-left: 3px solid var(--text-weak); padding-left: 16px; margin: 12px 0; color: var(--text-weak); font-style: italic; }
        .message-content strong { font-weight: 600; }
        .message-content em { font-style: italic; }
    </style>
</head>
<body>
    <header class="header">
        <a href="https://opencode.ai" class="logo">
            <svg width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#000"/><path d="M8 8h6v6H8zm10 0h6v6h-6zM8 18h6v6H8zm10 0h6v6h-6z" fill="#fff"/></svg>
            <span>OpenCode</span>
        </a>
    </header>
    <main class="main">
        <div id="loading" class="loading">
            <div class="spinner"></div>
            <p>Loading share...</p>
        </div>
        <div id="error" class="error hidden">
            <h2>Share Not Found</h2>
            <p>This share may have expired or been deleted.</p>
        </div>
        <div id="content" class="hidden">
            <div class="session-header">
                <div class="session-meta">
                    <span class="badge">OpenCode</span>
                    <span id="version"></span>
                    <span id="timestamp"></span>
                </div>
                <h1 class="session-title" id="title"></h1>
            </div>
            <div id="messages"></div>
        </div>
    </main>
    <script>
        const shareId = ${jsShareId};
        const API_BASE = ${jsApiBaseUrl};

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function parseMarkdown(text) {
            let html = escapeHtml(text);
            html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
            html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
            html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
            html = html.replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>');
            html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');
            html = html.replace(/\\*(.*?)\\*/g, '<em>$1</em>');
            html = html.replace(/_(.*?)_/g, '<em>$1</em>');
            html = html.replace(new RegExp(String.fromCharCode(96) + '([^' + String.fromCharCode(96) + ']+)' + String.fromCharCode(96), 'g'), '<code>$1</code>');
            html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
            html = html.replace(/\\n\\n/g, '</p><p>');
            html = html.replace(/\\n/g, '<br>');
            if (!html.startsWith('<')) html = '<p>' + html + '</p>';
            return html;
        }

        async function loadShare() {
            try {
                const response = await fetch(API_BASE + '/api/share/' + shareId + '/data');
                if (!response.ok) throw new Error('Failed to load');
                const data = await response.json();
                renderShare(data);
            } catch (error) {
                document.getElementById('loading').classList.add('hidden');
                document.getElementById('error').classList.remove('hidden');
            }
        }

        function renderShare(data) {
            const session = data.find(function(d) { return d.type === 'session'; });
            if (!session) throw new Error('No session data');
            var sd = session.data;

            document.getElementById('loading').classList.add('hidden');
            document.getElementById('content').classList.remove('hidden');
            document.getElementById('version').textContent = 'v' + (sd.version || '');
            document.getElementById('timestamp').textContent = sd.time ? new Date(sd.time.created).toLocaleString() : '';
            document.getElementById('title').textContent = sd.title || 'Untitled Session';
            document.title = (sd.title || 'Share') + ' | OpenCode';

            var messages = data.filter(function(d) { return d.type === 'message'; }).map(function(d) { return d.data; });
            var parts = {};
            data.filter(function(d) { return d.type === 'part'; }).forEach(function(d) {
                if (!parts[d.data.messageID]) parts[d.data.messageID] = [];
                parts[d.data.messageID].push(d.data);
            });

            var html = messages.map(function(msg) {
                var role = msg.role === 'user' ? 'You' : 'Assistant';
                var msgParts = parts[msg.id] || [];
                var content = msgParts.map(function(p) {
                    switch (p.type) {
                        case 'text': return parseMarkdown(p.text);
                        case 'code': return '<pre><code>' + escapeHtml(p.code) + '</code></pre>';
                        case 'reasoning': return '<details class="part part-reasoning"><summary>Thinking</summary><div class="part-reasoning-content">' + parseMarkdown(p.text) + '</div></details>';
                        case 'tool':
                            var ts = p.state || {};
                            return '<details class="part part-tool"><summary>Tool: ' + escapeHtml(ts.title || p.tool || 'Tool') + '</summary><div class="part-tool-content"><div style="margin-bottom:8px;font-weight:500">Input:</div><pre><code>' + escapeHtml(JSON.stringify(ts.input || {}, null, 2)) + '</code></pre><div style="margin:12px 0 8px;font-weight:500">Output:</div><pre><code>' + escapeHtml(ts.output || '') + '</code></pre></div></details>';
                        case 'file':
                            return '<div class="part-file"><div>' + escapeHtml(p.fileName || 'File') + '</div></div>';
                        case 'image':
                            return '<img src="' + escapeHtml(p.url || '') + '" alt="' + escapeHtml(p.alt || '') + '" class="part-image">';
                        default: return '';
                    }
                }).join('');
                return '<div class="message"><div class="message-header"><span class="message-role ' + msg.role + '">' + role + '</span></div><div class="message-content">' + (content || '<p>No content</p>') + '</div></div>';
            }).join('');

            document.getElementById('messages').innerHTML = html;
        }

        loadShare();
    </script>
</body>
</html>`;

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        ...corsHeaders,
      },
      body: html,
    };
  } catch (error) {
    console.error("Error getting share:", error);
    return createResponse(500, { error: "Failed to get share" });
  }
}

// Landing page handler - informational page at root
export async function landingPageHandler(): Promise<APIGatewayProxyResultV2> {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenCode Share</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        :root {
            --bg-base: #fafafa; --bg-stronger: #f5f5f5; --bg-strong: #fff;
            --text-base: #171717; --text-strong: #000; --text-weak: #737373;
            --border-weak: #e5e5e5; --accent: #171717; --accent-text: #fff;
        }
        @media (prefers-color-scheme: dark) {
            :root {
                --bg-base: #0a0a0a; --bg-stronger: #171717; --bg-strong: #262626;
                --text-base: #e5e5e5; --text-strong: #fff; --text-weak: #a3a3a3;
                --border-weak: #262626; --accent: #fff; --accent-text: #000;
            }
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg-base); color: var(--text-base); line-height: 1.6;
            min-height: 100vh; display: flex; flex-direction: column;
        }
        .header {
            background: var(--bg-strong); border-bottom: 1px solid var(--border-weak);
            padding: 12px 24px; display: flex; justify-content: space-between; align-items: center;
        }
        .logo { display: flex; align-items: center; gap: 12px; text-decoration: none; color: var(--text-strong); font-weight: 600; }
        .main { max-width: 640px; margin: 0 auto; padding: 80px 24px; flex: 1; display: flex; flex-direction: column; align-items: center; text-align: center; }
        h1 { font-size: 32px; font-weight: 700; color: var(--text-strong); margin-bottom: 16px; }
        .subtitle { font-size: 18px; color: var(--text-weak); margin-bottom: 48px; max-width: 480px; }
        .how-to { text-align: left; width: 100%; background: var(--bg-strong); border: 1px solid var(--border-weak); border-radius: 12px; padding: 32px; margin-bottom: 32px; }
        .how-to h2 { font-size: 18px; font-weight: 600; color: var(--text-strong); margin-bottom: 20px; }
        .step { display: flex; gap: 16px; margin-bottom: 20px; }
        .step:last-child { margin-bottom: 0; }
        .step-num { flex-shrink: 0; width: 28px; height: 28px; background: var(--accent); color: var(--accent-text); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; margin-top: 1px; }
        .step-text { font-size: 15px; }
        .step-text code { font-family: 'SF Mono', 'Fira Code', 'Fira Mono', Menlo, monospace; font-size: 13px; background: var(--bg-stronger); padding: 2px 8px; border-radius: 4px; border: 1px solid var(--border-weak); }
        .links { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; }
        .links a { color: var(--text-weak); text-decoration: none; font-size: 14px; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border-weak); transition: all 0.15s; }
        .links a:hover { color: var(--text-strong); border-color: var(--text-weak); }
        .footer { text-align: center; padding: 24px; color: var(--text-weak); font-size: 13px; border-top: 1px solid var(--border-weak); }
    </style>
</head>
<body>
    <header class="header">
        <a href="/" class="logo">
            <svg width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#000"/><path d="M8 8h6v6H8zm10 0h6v6h-6zM8 18h6v6H8zm10 0h6v6h-6z" fill="#fff"/></svg>
            <span>OpenCode Share</span>
        </a>
    </header>
    <main class="main">
        <h1>OpenCode Share</h1>
        <p class="subtitle">Share your OpenCode coding sessions with your team. Shared sessions are read-only snapshots that anyone with the link can view.</p>
        <div class="how-to">
            <h2>How to share a session</h2>
            <div class="step">
                <div class="step-num">1</div>
                <div class="step-text">Open a coding session in <strong>OpenCode</strong></div>
            </div>
            <div class="step">
                <div class="step-num">2</div>
                <div class="step-text">Type <code>/share</code> to create a shareable link</div>
            </div>
            <div class="step">
                <div class="step-num">3</div>
                <div class="step-text">The link is copied to your clipboard &mdash; send it to anyone on the team</div>
            </div>
            <div class="step">
                <div class="step-num">4</div>
                <div class="step-text">To remove a share, type <code>/unshare</code></div>
            </div>
        </div>
        <div class="links">
            <a href="https://opencode.ai">OpenCode</a>
            <a href="https://opencode.ai/docs">Documentation</a>
        </div>
    </main>
    <footer class="footer">
        Powered by OpenCode &middot; Self-hosted share service
    </footer>
</body>
</html>`;

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/html",
      "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: https:",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      ...corsHeaders,
    },
    body: html,
  };
}
