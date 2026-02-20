import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Share } from "./share.js";

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Share-Secret",
};

// Helper to create response
function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
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
function parseBody(event: APIGatewayProxyEvent): any {
  if (!event.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    return {};
  }
}

// Health check handler
export async function healthHandler(): Promise<APIGatewayProxyResult> {
  return createResponse(200, {
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "opencode-share-api",
  });
}

// Create share handler
export async function createShareHandler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const body = parseBody(event);

    if (!body.sessionID) {
      return createResponse(400, { error: "sessionID is required" });
    }

    const share = await Share.create({ sessionID: body.sessionID });

    const protocol = event.headers["x-forwarded-proto"] || "https";
    const host = event.headers["x-forwarded-host"] || event.headers.host || "localhost";

    return createResponse(200, {
      id: share.id,
      secret: share.secret,
      url: `${protocol}://${host}/share/${share.id}`,
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
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
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

    // Trigger WebSocket broadcast
    await broadcastUpdate(shareID);

    return createResponse(200, { success: true });
  } catch (error) {
    if (error instanceof Share.Errors.NotFound) {
      return createResponse(404, { error: "Share not found" });
    }
    if (error instanceof Share.Errors.InvalidSecret) {
      return createResponse(403, { error: "Invalid secret" });
    }
    console.error("Error syncing share:", error);
    return createResponse(500, { error: "Failed to sync share" });
  }
}

// Get share data handler
export async function getShareDataHandler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const shareID = event.pathParameters?.shareID;
    if (!shareID) {
      return createResponse(400, { error: "shareID is required" });
    }

    const data = await Share.data(shareID);
    return createResponse(200, data);
  } catch (error) {
    console.error("Error getting share data:", error);
    return createResponse(500, { error: "Failed to get share data" });
  }
}

// Delete share handler
export async function deleteShareHandler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
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
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    const shareID = event.pathParameters?.shareID;
    if (!shareID) {
      return createResponse(400, { error: "shareID is required" });
    }

    const share = await Share.get(shareID);
    if (!share) {
      return createResponse(404, { error: "Share not found" });
    }

    // Return HTML with embedded viewer
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

        /* Thinking/Reasoning */
        .part-reasoning {
            background: var(--bg-stronger);
            border-left: 3px solid var(--text-weak);
            border-radius: 0 8px 8px 0;
            margin: 12px 0;
            overflow: hidden;
        }
        .part-reasoning summary {
            padding: 12px 16px;
            cursor: pointer;
            font-style: italic;
            color: var(--text-weak);
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .part-reasoning summary:hover {
            background: var(--bg-base);
        }
        .part-reasoning-content {
            padding: 12px 16px;
            font-style: italic;
            color: var(--text-weak);
            border-top: 1px solid var(--border-weak);
        }
        .part-reasoning-content ul, .part-reasoning-content ol {
            margin: 8px 0;
            padding-left: 20px;
        }
        .part-reasoning-content li {
            margin: 2px 0;
        }

        /* Tool calls */
        .part-tool {
            background: var(--bg-stronger);
            border: 1px solid var(--border-weak);
            border-radius: 8px;
            margin: 12px 0;
            overflow: hidden;
        }
        .part-tool summary {
            padding: 12px 16px;
            cursor: pointer;
            font-weight: 500;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .part-tool summary:hover {
            background: var(--bg-base);
        }
        .part-tool-content {
            padding: 16px;
            border-top: 1px solid var(--border-weak);
        }

        /* File attachments */
        .part-file {
            display: flex;
            align-items: center;
            gap: 12px;
            background: var(--bg-stronger);
            border: 1px solid var(--border-weak);
            border-radius: 8px;
            padding: 12px 16px;
            margin: 12px 0;
        }
        .part-file-icon {
            font-size: 24px;
        }
        .part-file-info {
            flex: 1;
        }
        .part-file-name {
            font-weight: 500;
            color: var(--text-strong);
        }
        .part-file-size {
            font-size: 12px;
            color: var(--text-weak);
        }

        /* Images */
        .part-image {
            max-width: 100%;
            border-radius: 8px;
            margin: 12px 0;
        }

        /* Markdown styles */
        .message-content h1, .message-content h2, .message-content h3 {
            margin: 16px 0 12px;
            color: var(--text-strong);
        }
        .message-content h1 { font-size: 24px; font-weight: 700; }
        .message-content h2 { font-size: 20px; font-weight: 600; }
        .message-content h3 { font-size: 18px; font-weight: 600; }
        .message-content p { margin: 12px 0; }
        .message-content ul, .message-content ol {
            margin: 12px 0;
            padding-left: 24px;
        }
        .message-content li { margin: 4px 0; }
        .message-content code {
            background: var(--bg-stronger);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: monospace;
            font-size: 0.9em;
        }
        .message-content a {
            color: var(--accent);
            text-decoration: underline;
        }
        .message-content a:hover {
            opacity: 0.8;
        }
        .message-content blockquote {
            border-left: 3px solid var(--text-weak);
            padding-left: 16px;
            margin: 12px 0;
            color: var(--text-weak);
            font-style: italic;
        }
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
        const shareId = '${shareID}';
        const API_BASE = '${process.env.API_GATEWAY_URL || ''}';

        async function loadShare() {
            try {
                const response = await fetch(\`\${API_BASE}/api/share/\${shareId}/data\`);
                if (!response.ok) throw new Error('Failed to load');
                const data = await response.json();
                renderShare(data);
            } catch (error) {
                document.getElementById('loading').classList.add('hidden');
                document.getElementById('error').classList.remove('hidden');
            }
        }

        function renderShare(data) {
            const session = data.find(d => d.type === 'session')?.data;
            if (!session) throw new Error('No session data');

            document.getElementById('loading').classList.add('hidden');
            document.getElementById('content').classList.remove('hidden');

            document.getElementById('version').textContent = 'v' + session.version;
            document.getElementById('timestamp').textContent = new Date(session.time.created).toLocaleString();
            document.getElementById('title').textContent = session.title || 'Untitled Session';
            document.title = (session.title || 'Share') + ' | OpenCode';

            const messages = data.filter(d => d.type === 'message').map(d => d.data);
            const parts = {};
            data.filter(d => d.type === 'part').forEach(d => {
                if (!parts[d.data.messageID]) parts[d.data.messageID] = [];
                parts[d.data.messageID].push(d.data);
            });

            const messagesHtml = messages.map(msg => {
                const role = msg.role === 'user' ? 'You' : 'Assistant';
                const msgParts = parts[msg.id] || [];
                const content = msgParts.map(p => {
                    switch (p.type) {
                        case 'text':
                            return parseMarkdown(p.text);
                        case 'code':
                            return '<pre><code>' + escapeHtml(p.code) + '</code></pre>';
                        case 'reasoning':
                            return '<details class="part part-reasoning"><summary>Thinking</summary><div class="part-reasoning-content">' + parseMarkdown(p.text) + '</div></details>';
                        case 'tool':
                            const toolState = p.state || {};
                            const toolStatus = toolState.status || 'unknown';
                            const toolInput = toolState.input || {};
                            const toolOutput = toolState.output || '';
                            const toolTitle = toolState.title || p.tool || 'Tool';
                            const statusIcon = 'Tool';
                            return '<details class="part part-tool"><summary>' + statusIcon + ': ' + escapeHtml(toolTitle) + '</summary><div class="part-tool-content"><div style="margin-bottom: 8px; font-weight: 500;">Input:</div><pre><code>' + escapeHtml(JSON.stringify(toolInput, null, 2)) + '</code></pre><div style="margin: 12px 0 8px; font-weight: 500;">Output:</div><pre><code>' + escapeHtml(toolOutput) + '</code></pre></div></details>';
                        case 'file':
                            return '<div class="part-file"><div class="part-file-icon">File</div><div class="part-file-info"><div class="part-file-name">' + escapeHtml(p.fileName || 'File') + '</div><div class="part-file-size">' + (p.size || '') + '</div></div></div>';
                        case 'image':
                            return '<img src="' + escapeHtml(p.url) + '" alt="' + escapeHtml(p.alt || '') + '" class="part-image">';
                        default:
                            return '';
                    }
                }).join('');

                return \`<div class="message">
                    <div class="message-header"><span class="message-role \${msg.role}">\${role}</span></div>
                    <div class="message-content">\${content || '<p>No content</p>'}</div>
                </div>\`;
            }).join('');

            document.getElementById('messages').innerHTML = messagesHtml;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // Simple markdown parser
        function parseMarkdown(text) {
            let html = escapeHtml(text);

            // Headers
            html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
            html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
            html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

            // Bold
            html = html.replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>');
            html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');

            // Italic
            html = html.replace(/\\*(.*?)\\*/g, '<em>$1</em>');
            html = html.replace(/_(.*?)_/g, '<em>$1</em>');

            // Code inline - use escaped backtick
            html = html.replace(new RegExp(String.fromCharCode(96) + '([^' + String.fromCharCode(96) + ']+)' + String.fromCharCode(96), 'g'), '<code>$1</code>');

            // Links
            html = html.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

            // Unordered lists
            html = html.replace(/^\\s*[-*+]\\s+(.+)$/gim, '<li>$1</li>');
            html = html.replace(/(<li>.*<\\/li>\\n?)+/g, '<ul>$&</ul>');
            html = html.replace(/<\\/ul>\\s*<ul>/g, '');

            // Ordered lists
            html = html.replace(/^\\s*\\d+\\.\\s+(.+)$/gim, '<li>$1</li>');

            // Blockquotes
            html = html.replace(/^>\\s*(.+)$/gim, '<blockquote>$1</blockquote>');

            // Line breaks (preserve paragraphs)
            html = html.replace(/\\n\\n/g, '</p><p>');
            html = html.replace(/\\n/g, '<br>');

            // Wrap in paragraph if not already wrapped
            if (!html.startsWith('<')) {
                html = '<p>' + html + '</p>';
            }

            return html;
        }

        loadShare();
    </script>
</body>
</html>`;

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "text/html",
        "Access-Control-Allow-Origin": "*",
      },
      body: html,
    };
  } catch (error) {
    console.error("Error getting share:", error);
    return createResponse(500, { error: "Failed to get share" });
  }
}

// Broadcast update via WebSocket Lambda
async function broadcastUpdate(shareId: string): Promise<void> {
  try {
    const { LambdaClient, InvokeCommand } = await import("@aws-sdk/client-lambda");
    const lambda = new LambdaClient({ region: process.env.AWS_REGION || "us-east-1" });

    const broadcastLambdaArn = process.env.BROADCAST_LAMBDA_ARN;
    if (!broadcastLambdaArn) {
      console.log("Broadcast Lambda ARN not configured, skipping broadcast");
      return;
    }

    await lambda.send(new InvokeCommand({
      FunctionName: broadcastLambdaArn,
      InvocationType: "Event",
      Payload: JSON.stringify({
        shareId,
        message: { type: "sync", timestamp: Date.now() }
      }),
    }));
  } catch (error) {
    console.error("Failed to broadcast update:", error);
    // Don't throw - broadcast failures shouldn't break sync
  }
}
