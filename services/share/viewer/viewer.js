// Share Viewer - Fetches and renders share data from Lambda API

const API_BASE = window.SHARE_API_BASE || '';

// Get share ID from URL path
function getShareId() {
    const path = window.location.pathname;
    const match = path.match(/\/share\/([^\/]+)/);
    return match ? match[1] : null;
}

// Format timestamp
function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Render markdown-like content
function renderContent(text) {
    if (!text) return '';

    // Escape HTML first
    let html = escapeHtml(text);

    // Code blocks
    html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre><code class="language-${lang || 'text'}">${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    return html;
}

// Render a part
function renderPart(part) {
    switch (part.type) {
        case 'text':
            return `<div class="part part-text">${renderContent(part.text)}</div>`;

        case 'code':
            return `<pre><code class="language-${part.language || 'text'}">${escapeHtml(part.code)}</code></pre>`;

        case 'tool_call':
            return `
                <details class="part part-tool_call">
                    <summary>Tool: ${escapeHtml(part.name)}</summary>
                    <pre><code>${escapeHtml(JSON.stringify(part.arguments, null, 2))}</code></pre>
                </details>
            `;

        case 'tool_result':
            return `
                <details class="part part-tool_result">
                    <summary>Result</summary>
                    <pre><code>${escapeHtml(part.result)}</code></pre>
                </details>
            `;

        case 'reasoning':
            return `<div class="part part-reasoning">Thinking: ${renderContent(part.text)}</div>`;

        case 'file':
            return `
                <div class="file-attachment">
                    <div class="file-icon">File</div>
                    <div class="file-info">
                        <div class="file-name">${escapeHtml(part.fileName || 'File')}</div>
                        <div class="file-size">${part.size || ''}</div>
                    </div>
                </div>
            `;

        case 'image':
            return `<img src="${part.url}" alt="${escapeHtml(part.alt || '')}" style="max-width: 100%; border-radius: 8px; margin: 8px 0;">`;

        default:
            return `<div class="part">${escapeHtml(JSON.stringify(part))}</div>`;
    }
}

// Render a message
function renderMessage(message, parts) {
    const role = message.role;
    const roleLabel = role === 'user' ? 'You' : 'Assistant';
    const roleClass = role;

    let content = '';

    // Render parts if available
    if (parts && parts.length > 0) {
        content = parts.map(renderPart).join('');
    } else if (message.content) {
        content = renderContent(message.content);
    }

    return `
        <div class="message">
            <div class="message-header">
                <span class="message-role ${roleClass}">${roleLabel}</span>
            </div>
            <div class="message-content">
                ${content}
            </div>
        </div>
    `;
}

// Process share data
function processShareData(data) {
    const result = {
        session: null,
        messages: [],
        parts: {},
        models: [],
        diffs: []
    };

    for (const item of data) {
        switch (item.type) {
            case 'session':
                result.session = item.data;
                break;
            case 'message':
                result.messages.push(item.data);
                break;
            case 'part':
                if (!result.parts[item.data.messageID]) {
                    result.parts[item.data.messageID] = [];
                }
                result.parts[item.data.messageID].push(item.data);
                break;
            case 'model':
                result.models = item.data;
                break;
            case 'session_diff':
                result.diffs = item.data;
                break;
        }
    }

    // Sort messages by time
    result.messages.sort((a, b) => a.time.created - b.time.created);

    return result;
}

// Render diffs
function renderDiffs(diffs) {
    if (!diffs || diffs.length === 0) return '';

    return diffs.map(diff => {
        const lines = [];

        // Simple diff rendering
        if (diff.before && diff.after) {
            const beforeLines = diff.before.split('\n');
            const afterLines = diff.after.split('\n');

            // Very basic diff - just show changed lines
            for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
                const before = beforeLines[i] || '';
                const after = afterLines[i] || '';

                if (before !== after) {
                    if (before) lines.push(`<div class="diff-line remove">- ${escapeHtml(before)}</div>`);
                    if (after) lines.push(`<div class="diff-line add">+ ${escapeHtml(after)}</div>`);
                } else {
                    lines.push(`<div class="diff-line context">  ${escapeHtml(after)}</div>`);
                }
            }
        }

        return `
            <div class="diff">
                <div class="diff-header">${escapeHtml(diff.file)}</div>
                <div class="diff-content">
                    ${lines.join('')}
                </div>
            </div>
        `;
    }).join('');
}

// Main load function
async function loadShare() {
    const shareId = getShareId();

    if (!shareId) {
        showError();
        return;
    }

    try {
        // Fetch share data
        const response = await fetch(`${API_BASE}/api/share/${shareId}/data`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!data || data.length === 0) {
            showError();
            return;
        }

        // Process data
        const processed = processShareData(data);

        if (!processed.session) {
            showError();
            return;
        }

        // Render
        renderShare(processed);

    } catch (error) {
        console.error('Failed to load share:', error);
        showError();
    }
}

// Render the share
function renderShare(data) {
    const session = data.session;

    // Hide loading, show content
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('content').classList.remove('hidden');

    // Set metadata
    document.getElementById('version').textContent = `v${session.version}`;
    document.getElementById('timestamp').textContent = formatTimestamp(session.time.created);
    document.getElementById('title').textContent = session.title || 'Untitled Session';

    // Set model info
    const model = data.models[0];
    if (model) {
        document.getElementById('model-info').innerHTML = `
            <span>Model:</span>
            <span>${escapeHtml(model.name || model.id)}</span>
        `;
    }

    // Render messages
    const messagesHtml = data.messages.map(msg => {
        const msgParts = data.parts[msg.id] || [];
        return renderMessage(msg, msgParts);
    }).join('');

    // Add diffs if present
    const diffsHtml = renderDiffs(data.diffs);

    document.getElementById('messages').innerHTML = messagesHtml + diffsHtml;

    // Update page title
    document.title = `${session.title || 'Share'} | OpenCode`;
}

// Show error state
function showError() {
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('error').classList.remove('hidden');
}

// Load on page load
document.addEventListener('DOMContentLoaded', loadShare);
