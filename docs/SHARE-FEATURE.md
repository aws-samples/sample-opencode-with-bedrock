# OpenCode Share Feature (POC)

## Overview

The share feature allows users to create public, shareable links to their OpenCode coding sessions. It enables collaboration and sharing of AI coding sessions via a simple URL.

## Architecture

```
                         Internet
                            |
                   +--------v--------+
                   |  API Gateway    |
                   |  (HTTP API)     |
                   +--------+--------+
                            |
                   +--------v--------+
                   |  Lambda         |
                   |  (Share API)    |
                   +--------+--------+
                            |
              +-------------+-------------+
              |                           |
     +--------v--------+        +--------v--------+
     |  S3 Bucket      |        |  Lambda         |
     |  (Event Store)  |        |  (Broadcast)    |
     +--------+--------+        +--------+--------+
              |                           |
              |                  +--------v--------+
              |                  |  API Gateway    |
              |                  |  (WebSocket)    |
              |                  +--------+--------+
              |                           |
              |                  +--------v--------+
              |                  |  DynamoDB       |
              |                  |  (Connections)  |
              |                  +-----------------+
```

### Components

#### 1. Share Lambda API (`services/share/lambda/`)
- **Router** (`index.ts`): Routes requests based on path and HTTP method
- **Handlers** (`handlers.ts`): 6 Lambda handlers for CRUD operations + inline HTML viewer
- **Business Logic** (`share.ts`): Event-sourcing with compaction for efficient retrieval
- **Storage** (`storage.ts`): S3 storage adapter

#### 2. Standalone Viewer (`services/share/viewer/`)
- `index.html` - Viewer page shell
- `viewer.js` - Client-side rendering logic
- `styles.css` - Responsive styling with dark mode support

#### 3. CloudFormation (`cloudformation/`)
- `share-lambda-stack.yaml` - Lambda + API Gateway + S3
- `share-websocket-stack.yaml` - WebSocket API + DynamoDB + Lambda

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/api/share` | Create a new share |
| `POST` | `/api/share/{id}/sync` | Sync session data to share |
| `GET` | `/api/share/{id}/data` | Get share data |
| `DELETE` | `/api/share/{id}` | Delete a share |
| `GET` | `/share/{id}` | View shared session (HTML) |

## Data Model

The share feature uses an **event-sourcing** pattern with S3:

- **`share/{id}.json`** - Share metadata (id, secret, sessionID)
- **`share_event/{id}/{ulid}.json`** - Append-only event log
- **`share_compaction/{id}.json`** - Compacted snapshot for fast reads

### Data Types

| Type | Description |
|------|-------------|
| `session` | Session metadata (title, version, timestamps) |
| `message` | Chat messages (user/assistant) |
| `part` | Message parts (text, code, tool calls, reasoning) |
| `model` | Model information |
| `session_diff` | Code diffs |

## Deployment

### Prerequisites

- AWS account with CloudFormation access
- Node.js 20+ for Lambda runtime
- AWS CLI configured

### Deploy Infrastructure

```bash
# Deploy Lambda + API Gateway + S3
aws cloudformation deploy \
  --template-file cloudformation/share-lambda-stack.yaml \
  --stack-name opencode-share-lambda-stack \
  --capabilities CAPABILITY_IAM

# Deploy WebSocket support
aws cloudformation deploy \
  --template-file cloudformation/share-websocket-stack.yaml \
  --stack-name opencode-share-websocket-stack \
  --capabilities CAPABILITY_IAM
```

### Deploy Lambda Code

```bash
cd services/share/lambda
npm install
npm run build
npm run package
aws lambda update-function-code \
  --function-name opencode-share-lambda-stack-api \
  --zip-file fileb://share-api.zip
```

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENCODE_STORAGE_BUCKET` | S3 bucket name for share data |
| `OPENCODE_STORAGE_REGION` | AWS region for S3 |
| `BROADCAST_LAMBDA_ARN` | ARN of the WebSocket broadcast Lambda |
| `API_GATEWAY_URL` | Base URL for the API Gateway (used in inline viewer) |
| `NODE_ENV` | Environment (`production` / `test`) |

### Viewer Configuration

The standalone viewer (`services/share/viewer/`) uses `window.SHARE_API_BASE` to configure the API endpoint. Set this before loading `viewer.js`:

```html
<script>window.SHARE_API_BASE = 'https://your-api-gateway-url.execute-api.us-east-1.amazonaws.com/prod';</script>
<script src="viewer.js"></script>
```

## Security

- **Share Creation**: Public (no auth required in POC)
- **Share Write (sync)**: Requires share secret (UUID generated at creation)
- **Share Read**: Publicly accessible (by design for sharing)
- **S3**: Encrypted at rest (AES-256), deny insecure transport
- **DynamoDB**: Encrypted at rest (KMS), point-in-time recovery enabled

## Status

This is a **proof of concept** (POC). Future work includes:
- Authentication integration (JWT/Cognito)
- Share expiration and automatic cleanup
- Access controls (password protection, domain restrictions)
- CDK integration with the main OpenCode stack
