# OpenCode Share Feature

## Overview

The share feature allows authenticated users to create shareable links to their OpenCode coding sessions, with real-time WebSocket updates. It integrates with the existing ALB infrastructure for authentication (JWT and OIDC).

## Architecture

```
CLI (opencode)
    |
    v
opencode-auth proxy (localhost:18080)
    |-- /api/share/* --> API ALB (JWT auth) --> Share Lambda --> S3
    |-- /share/*     --> Distribution ALB (OIDC) --> Share Lambda --> S3
    |
    +-- Share Lambda --> Broadcast Lambda --> WebSocket API GW
                                                |
                                           DynamoDB (connections)
                                                |
                                           Connected viewers
```

### Components

#### 1. Share Lambda API (`services/share/lambda/`)
- **Router** (`index.ts`): Routes requests based on path and HTTP method (API Gateway v2 format)
- **Handlers** (`handlers.ts`): CRUD operations + inline HTML viewer with XSS protection and CSP headers
- **Business Logic** (`share.ts`): Event-sourcing with compaction, timing-safe secret comparison, input validation
- **Storage** (`storage.ts`): S3 storage adapter with pagination support

#### 2. WebSocket Handlers (`services/share/websocket/`)
- **connect.ts**: Stores WebSocket connection in DynamoDB with 24h TTL and shareId validation
- **disconnect.ts**: Removes connection from DynamoDB
- **default.ts**: Handles `subscribe` and `ping` actions
- **broadcast.ts**: Fans out sync notifications to all connections for a share

#### 3. Standalone Viewer (`services/share/viewer/`)
- `index.html` - Viewer page shell
- `viewer.js` - Client-side rendering logic
- `styles.css` - Responsive styling with dark mode support

#### 4. CDK Stack (`src/stacks/share-stack.ts`)
Single optional stack containing all share resources:
- S3 bucket (event store, encrypted, versioned, lifecycle rules)
- DynamoDB table (WebSocket connections, KMS, TTL, PITR)
- Share API Lambda (Node.js 20)
- 4 WebSocket Lambdas (connect, disconnect, default, broadcast)
- WebSocket API Gateway (with throttling and access logging)
- ALB listener rules on both API ALB (JWT) and Distribution ALB (OIDC)
- CloudWatch alarms for Lambda errors and throttles

#### 5. Legacy CloudFormation (`cloudformation/`)
- `share-lambda-stack.yaml` - Original POC (retained for reference)
- `share-websocket-stack.yaml` - Original POC (retained for reference)

## API Endpoints

### Via API ALB (programmatic, JWT/API-key auth)

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `POST` | `/api/share` | Create a new share | JWT or API key |
| `POST` | `/api/share/{id}/sync` | Sync session data | JWT or API key |
| `GET` | `/api/share/{id}/data` | Get share data | JWT or API key |
| `DELETE` | `/api/share/{id}` | Delete a share | JWT or API key |

### Via Distribution ALB (browser, OIDC auth)

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/share/{id}` | View shared session (HTML) | OIDC redirect |
| `GET` | `/api/share/{id}/data` | Get share data (viewer fetch) | OIDC cookie |

## Data Model

The share feature uses an **event-sourcing** pattern with S3:

- **`share/{id}.json`** - Share metadata (id, secret, sessionID)
- **`share_event/{id}/{ulid}.json`** - Append-only event log
- **`share_compaction/{id}.json`** - Compacted snapshot for fast reads

### Data Types

| Type | Description |
|------|-------------|
| `session` | Session metadata (title, version, timestamps) |
| `message` | Chat messages (user/assistant) with role, id, time |
| `part` | Message parts (text, code, tool calls, reasoning) with messageID |
| `model` | Model information |
| `session_diff` | Code diffs |

## Deployment

### Prerequisites

- All base stacks deployed (Network, Certificate, Auth, API, Distribution)
- Node.js 20+ for Lambda runtime

### Deploy with CDK

```bash
# Build Lambda code first
cd services/share/lambda && npm install && npm run build && cd -
cd services/share/websocket && npm install && npm run build && cd -

# Deploy share stack (optional feature flag)
npx cdk deploy OpenCodeShare-dev -c enableShareFeature=true

# Deploy without share (default)
npx cdk deploy --all
```

### Configure opencode-auth

Add the share endpoint to `~/.opencode/config.json`:

```json
{
  "client_id": "...",
  "api_endpoint": "https://oc.example.com/v1",
  "share_endpoint": "https://oc.example.com"
}
```

The `opencode-auth` proxy will intercept `/api/share/*` and `/share/*` requests and forward them to the share endpoint with JWT authentication.

## Configuration

### Environment Variables (Lambda)

| Variable | Description |
|----------|-------------|
| `OPENCODE_STORAGE_BUCKET` | S3 bucket name for share data |
| `OPENCODE_STORAGE_REGION` | AWS region for S3 |
| `BROADCAST_LAMBDA_ARN` | ARN of the WebSocket broadcast Lambda |
| `API_GATEWAY_URL` | Base URL for the API (used in inline viewer) |
| `CORS_ALLOWED_ORIGIN` | Allowed CORS origin (defaults to web domain) |
| `NODE_ENV` | Environment (`production` / `test`) |

### CDK Context

| Context Key | Default | Description |
|-------------|---------|-------------|
| `enableShareFeature` | `'false'` | Set to `'true'` to deploy the share stack |

## Security

- **API routes** (`/api/share/*`): JWT validation via API ALB (same as `/v1/chat/completions`) or API key passthrough
- **Viewer routes** (`/share/*`): OIDC browser redirect via Distribution ALB
- **Share writes** (sync/delete): Require share secret (UUID, timing-safe comparison)
- **S3**: Encrypted at rest (S3-managed), versioned, public access blocked, SSL enforced
- **DynamoDB**: AWS-managed encryption, point-in-time recovery, TTL for connection cleanup
- **WebSocket shareId**: Validated against `^[a-zA-Z0-9_-]{1,64}$` pattern
- **XSS protection**: Share IDs HTML-escaped before template injection, CSP headers on viewer
- **Input validation**: Sync payloads capped at 500 items / 5MB
- **IAM**: Lambda invoke scoped to specific broadcast Lambda ARN (not `function:*`)
- **CORS**: Restricted to configured web domain (not `*`)
