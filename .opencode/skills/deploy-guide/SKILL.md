---
name: deploy-guide
description: Walk through the full OpenCode Stack deployment step by step
---

# Deploy Guide

You are guiding the user through a full deployment of the OpenCode Stack. Work through each phase in order, verifying success before proceeding to the next.

## Before you begin

1. **Run preflight checks.** Execute the same checks as the `deploy-preflight` skill (AWS credentials, Node.js, container builder, cdk.context.json, npm deps, CDK synth). If any required check fails, stop and help the user fix it.

2. **Check for `cdk.context.json`.** If it doesn't exist, tell the user to run `./scripts/setup.sh` — it's an interactive wizard that configures domains, auth mode, and validates prerequisites. Do not try to create `cdk.context.json` manually.

## Deployment phases

Execute each phase by running the corresponding `deploy.sh` subcommand. After each phase, verify success before moving on.

### Phase 1: Network + Certificate

```bash
./scripts/deploy.sh network
```

**What it does:** Creates the VPC, subnets, NAT Gateway, and ACM certificate.

**Verify:** Check that the CloudFormation stacks `OpenCodeNetwork-<env>` and `OpenCodeCertificate-<env>` are in `CREATE_COMPLETE` or `UPDATE_COMPLETE` state.

### Phase 2: Auth

```bash
./scripts/deploy.sh auth
```

**What it does:** Deploys OIDC authentication (Cognito user pool or external provider config). Writes SSM parameters for the OIDC endpoints and client IDs. For Cognito mode, automatically creates the ALB client secret in Secrets Manager.

**Verify:** Confirm SSM parameters exist under `/opencode/<env>/oidc/` and the Secrets Manager secret `opencode/<env>/oidc-alb-client-secret` has a value.

### Phase 3: API

```bash
./scripts/deploy.sh api
```

**What it does:** Deploys the API stack (ECR repository, ECS Fargate service, JWT ALB with HTTPS listener and rules). Builds and pushes the router container image. If the ECR repo already existed, the image is pushed before the stack deploy to avoid pull errors.

**Verify:** Check that:
- The CloudFormation stack `OpenCodeApi-<env>` deployed successfully
- The ECS service has running tasks (desired count matches running count)
- The ALB target group has healthy targets

### Phase 4: Distribution

```bash
./scripts/deploy.sh distribution
```

**What it does:** Deploys the landing page Lambda function, S3 assets bucket, and OIDC ALB for browser-based authentication.

**Verify:** Check that:
- The CloudFormation stack `OpenCodeDistribution-<env>` deployed successfully
- The web endpoint responds

### Phase 5: Share (optional)

```bash
./scripts/deploy.sh share
```

**What it does:** Builds the share Lambda code (API + WebSocket handlers), then deploys the ShareStack with `enableShareFeature=true`. This creates an S3 bucket for session data, a DynamoDB table for WebSocket connections, a WebSocket API Gateway with connect/disconnect/default routes, 5 Lambda functions (API handler, connect, disconnect, default, broadcast), and ALB listener rules on both the API ALB (priorities 7-8, JWT auth) and the Distribution ALB (priorities 7-8, OIDC auth).

**Verify:** Check that:
- The CloudFormation stack `OpenCodeShare-<env>` deployed successfully
- The SSM parameter `/opencode/<env>/share/websocket-url` has a value
- The WebSocket endpoint is reachable: `wscat -c <websocket-url>`
- The share API responds via the API ALB: `curl -sf https://<api-domain>/api/share/health` (with valid JWT)

**Note:** This phase is optional. If you skip it, the share feature is simply not available — no other stacks are affected.

## After deployment

Run `./scripts/deploy.sh info` to display the API and web endpoints.

Print a final summary with the endpoints and suggest the user test:
- `curl https://<api-domain>/health`
- Opening `https://<web-domain>/` in a browser

If any phase fails, help the user diagnose the issue. Check CloudFormation events, ECS service events, and container logs as needed.
