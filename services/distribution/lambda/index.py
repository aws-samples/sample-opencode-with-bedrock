import json
import logging
import os
import base64
import boto3
from botocore.config import Config

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

s3 = boto3.client("s3", config=Config(signature_version="s3v4"))
BUCKET = os.environ.get("ASSETS_BUCKET", "")
ENVIRONMENT = os.environ.get("ENVIRONMENT", "dev")


def get_user_from_oidc_data(headers):
    """Extract user info from ALB OIDC data header."""
    oidc_data = headers.get("x-amzn-oidc-data", "")
    if not oidc_data:
        return None

    try:
        parts = oidc_data.split(".")
        if len(parts) < 2:
            return None

        payload = parts[1]
        padding = 4 - len(payload) % 4
        if padding != 4:
            payload += "=" * padding

        decoded = base64.urlsafe_b64decode(payload)
        claims = json.loads(decoded)

        return {
            "email": claims.get("email", "Unknown"),
            "name": claims.get("name", claims.get("given_name", "User")),
            "sub": claims.get("sub", ""),
        }
    except Exception as e:
        logger.error("Error decoding OIDC data: %s", e)
        return None


def generate_presigned_url(key, expiration=3600):
    """Generate a presigned URL for an S3 object."""
    try:
        url = s3.generate_presigned_url(
            "get_object", Params={"Bucket": BUCKET, "Key": key}, ExpiresIn=expiration
        )
        return url
    except Exception as e:
        logger.error("Error generating presigned URL: %s", e)
        return None


def handler(event, context):
    """Lambda handler for distribution landing page."""
    path = event.get("rawPath", event.get("path", "/"))
    headers = event.get("headers", {})

    # Health check endpoint
    if path == "/health":
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"status": "healthy", "service": "distribution"}),
        }

    # Get user info from OIDC
    user = get_user_from_oidc_data(headers)

    # Generate presigned URL for installer
    installer_url = generate_presigned_url("downloads/opencode-installer.zip")

    # Build HTML landing page
    user_section = ""
    if user:
        user_section = (
            f'<div class="user-info">Welcome, <strong>{user["name"]}</strong></div>'
        )

    download_section = ""
    if installer_url:
        download_section = f'''
        <div class="download-section">
            <a href="{installer_url}" class="download-button">Download opencode-installer.zip</a>
            <p class="download-help">Click to download the installer package</p>
        </div>'''
    else:
        download_section = (
            '<p class="no-installer">Installer package not yet available.</p>'
        )

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bedrock Inference - Downloads</title>
    <style>
        :root {{
            --bg: #0a0a0a;
            --card-bg: #1a1a1a;
            --text: #e0e0e0;
            --text-muted: #888;
            --accent: #4a9eff;
            --accent-hover: #6ab0ff;
            --border: #333;
        }}
        * {{ box-sizing: border-box; margin: 0; padding: 0; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg);
            color: var(--text);
            line-height: 1.6;
            min-height: 100vh;
        }}
        .container {{
            max-width: 800px;
            margin: 0 auto;
            padding: 2rem;
        }}
        header {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
            padding-bottom: 1rem;
            border-bottom: 1px solid var(--border);
        }}
        h1 {{
            font-size: 1.5rem;
            font-weight: 600;
        }}
        .user-info {{
            color: var(--text-muted);
            font-size: 0.9rem;
        }}
        .card {{
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 2rem;
            margin-bottom: 1.5rem;
        }}
        .card h2 {{
            font-size: 1.1rem;
            margin-bottom: 1rem;
            color: var(--accent);
        }}
        .download-section {{
            text-align: center;
            padding: 2rem 0;
        }}
        .download-button {{
            display: inline-block;
            background: var(--accent);
            color: white;
            padding: 1rem 2rem;
            border-radius: 6px;
            text-decoration: none;
            font-size: 1.1rem;
            font-weight: 600;
            transition: background 0.2s;
        }}
        .download-button:hover {{
            background: var(--accent-hover);
        }}
        .download-help {{
            margin-top: 0.5rem;
            color: var(--text-muted);
            font-size: 0.9rem;
        }}
        .no-installer {{
            color: var(--text-muted);
            font-style: italic;
        }}
        .code-block {{
            position: relative;
            margin: 0.5rem 0;
        }}
        pre {{
            background: #0d1117;
            padding: 1rem;
            border-radius: 4px;
            overflow-x: auto;
            font-size: 0.85rem;
            font-family: 'SF Mono', Monaco, monospace;
            color: var(--accent);
            padding-right: 3rem;
        }}
        code {{
            font-family: 'SF Mono', Monaco, monospace;
            color: var(--accent);
        }}
        .copy-btn {{
            position: absolute;
            top: 0.5rem;
            right: 0.5rem;
            background: transparent;
            border: 1px solid var(--border);
            color: var(--text-muted);
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.75rem;
            transition: all 0.2s;
        }}
        .copy-btn:hover {{
            background: var(--border);
            color: var(--text);
        }}
        .copy-btn.copied {{
            background: var(--accent);
            color: white;
            border-color: var(--accent);
        }}
        .steps {{
            counter-reset: step;
        }}
        .step {{
            position: relative;
            padding-left: 2.5rem;
            margin-bottom: 1rem;
        }}
        .step::before {{
            counter-increment: step;
            content: counter(step);
            position: absolute;
            left: 0;
            width: 1.75rem;
            height: 1.75rem;
            background: var(--accent);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.8rem;
            font-weight: 600;
        }}
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Bedrock Inference Distribution</h1>
            {user_section}
        </header>
        
        <div class="card">
            <h2>Download</h2>
            {download_section}
        </div>
        
        <div class="card">
            <h2>Setup Instructions</h2>
            <div class="steps">
                <div class="step">
                    Extract the downloaded zip file
                    <div class="code-block">
                        <pre><code id="cmd1">unzip opencode-installer.zip -d opencode-installer
cd opencode-installer</code></pre>
                        <button class="copy-btn" onclick="copyToClipboard('cmd1', this)">Copy</button>
                    </div>
                </div>
                <div class="step">
                    Run the installer
                    <div class="code-block">
                        <pre><code id="cmd2">./install.sh</code></pre>
                        <button class="copy-btn" onclick="copyToClipboard('cmd2', this)">Copy</button>
                    </div>
                </div>
                <div class="step">
                    Restart your shell or source your profile
                    <div class="code-block">
                        <pre><code id="cmd3">source ~/.bashrc  # or ~/.zshrc</code></pre>
                        <button class="copy-btn" onclick="copyToClipboard('cmd3', this)">Copy</button>
                    </div>
                </div>
                <div class="step">
                    Launch OpenCode
                    <div class="code-block">
                        <pre><code id="cmd4">oc</code></pre>
                        <button class="copy-btn" onclick="copyToClipboard('cmd4', this)">Copy</button>
                    </div>
                </div>
            </div>
            <p style="margin-top: 1rem; color: var(--text-muted);">
                The first time you run <code>oc</code>, it will open your browser to authenticate.
            </p>
        </div>

        <div class="card">
            <h2>Model Selection</h2>
            <p style="margin-bottom: 1rem; color: var(--text-muted);">
                OpenCode supports multiple AI models. You can change models at any time using the <code>/models</code> command.
            </p>

            <h3 style="font-size: 1rem; margin: 1.5rem 0 0.75rem; color: var(--text);">Available Models</h3>
            <p style="margin-bottom: 1rem; color: var(--text-muted);">
                This distribution includes three Bedrock models:
            </p>
            <ul style="margin: 0 0 1rem 1.5rem; color: var(--text-muted);">
                <li><strong>Claude Opus 4.6</strong> (<code>bedrock/claude-opus</code>)</li>
                <li><strong>Claude Sonnet 4.6</strong> (<code>bedrock/claude-sonnet</code>)</li>
                <li><strong>Kimi K2.5</strong> (<code>bedrock/kimi-k25</code>)</li>
            </ul>

            <h3 style="font-size: 1rem; margin: 1.5rem 0 0.75rem; color: var(--text);">Default Model</h3>
            <p style="margin-bottom: 1rem; color: var(--text-muted);">
                The default model is <strong>Claude Opus 4.6</strong>. OpenCode selects the default based on:
            </p>
            <ol style="margin: 0 0 1rem 1.5rem; color: var(--text-muted);">
                <li>Config file: <code>model</code> key in <code>opencode.json</code></li>
                <li>Last used model from previous session</li>
                <li>Distribution default (Claude Opus 4.6)</li>
            </ol>

            <h3 style="font-size: 1rem; margin: 1.5rem 0 0.75rem; color: var(--text);">Changing Models</h3>
            <div class="steps">
                <div class="step">
                    Type <code>/models</code> in the chat to see available models
                </div>
                <div class="step">
                    Select a model from the list, or type the model ID directly
                </div>
                <div class="step">
                    The new model will be used for subsequent messages
                </div>
            </div>

            <h3 style="font-size: 1rem; margin: 1.5rem 0 0.75rem; color: var(--text);">Set Your Default</h3>
            <p style="margin-bottom: 1rem; color: var(--text-muted);">
                To change your default model, edit <code>~/.opencode/opencode.json</code> and update the <code>model</code> field. For example, to set Kimi K2.5 as default:
            </p>
            <div class="code-block">
                <pre><code id="model-config-kimi">{{
  "$schema": "https://opencode.ai/config.json",
  "model": "bedrock/kimi-k25"
}}</code></pre>
                <button class="copy-btn" onclick="copyToClipboard('model-config-kimi', this)">Copy</button>
            </div>

            <p style="margin-top: 1rem; color: var(--text-muted);">
                For more details, visit <a href="https://opencode.ai/docs/models/" target="_blank" style="color: var(--accent);">opencode.ai/docs/models</a>
            </p>
        </div>
    </div>
    
    <script>
        function copyToClipboard(elementId, button) {{
            const text = document.getElementById(elementId).textContent;
            navigator.clipboard.writeText(text).then(() => {{
                const originalText = button.textContent;
                button.textContent = 'Copied!';
                button.classList.add('copied');
                setTimeout(() => {{
                    button.textContent = originalText;
                    button.classList.remove('copied');
                }}, 2000);
            }}).catch(err => {{
                console.error('Failed to copy:', err);
            }});
        }}
    </script>
</body>
</html>"""

    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "text/html",
            "Cache-Control": "no-cache",
        },
        "body": html,
    }
