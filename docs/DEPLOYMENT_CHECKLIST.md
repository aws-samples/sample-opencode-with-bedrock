# Deployment Checklist

This checklist covers everything needed for a successful deployment of the OpenCode Stack.

## Quick Start

The fastest path to a working deployment:

```bash
./scripts/setup.sh      # Interactive wizard — configures auth, validates prereqs
./scripts/deploy.sh      # Full automated deploy (network → auth → api → distribution)
```

If you prefer step-by-step control, follow the phases below.

> **Tip:** If you're using [opencode](https://opencode.ai), run the `/deploy-guide` skill for interactive, context-aware deployment assistance.

---

## Prerequisites

### 1. AWS Credentials
- [ ] AWS CLI installed and configured
- [ ] Valid credentials (`aws sts get-caller-identity` succeeds)
- [ ] Target region set (default: `us-east-1`)

```bash
# Option 1: AWS SSO (recommended)
aws configure sso
aws sso login --profile your-profile
export AWS_PROFILE=your-profile

# Option 2: Environment variables
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_REGION=us-east-1
```

### 2. Tools
- [ ] Node.js 18+
- [ ] Docker or Finch (for container image builds)
- [ ] npm dependencies installed (`npm install`)

### 3. Domain & DNS
- [ ] Route 53 Hosted Zone for your domain
- [ ] Hosted Zone ID noted for configuration

### 4. OIDC Provider (for authentication)
- [ ] Choose auth mode: Cognito, Cognito + federated IdP, or external OIDC provider
- [ ] If external: provider applications created (ALB + CLI clients)

See [OIDC Setup Guide](./OIDC_SETUP.md) for detailed instructions.

### 5. Context Configuration
- [ ] `cdk.context.json` created (copy from `cdk.context.json.example` and fill in your values)

```bash
# Recommended: use the interactive setup wizard
./scripts/setup.sh
```

Or copy the example and edit manually:
```bash
cp cdk.context.json.example cdk.context.json
# Edit with your domain, hosted zone, and auth settings
```

> **Note:** `cdk.context.json` may contain sensitive values and is in `.gitignore`.

---

## Deployment Phases

### Phase 1: Network + Certificate

Deploys VPC, subnets, NAT Gateway, and ACM certificate.

```bash
./scripts/deploy.sh network
```

- [ ] Network stack deployed
- [ ] Certificate stack deployed

### Phase 2: Auth

Deploys OIDC authentication (Cognito or external provider). Automatically creates the ALB client secret in Secrets Manager for Cognito mode.

```bash
./scripts/deploy.sh auth
```

- [ ] Auth stack deployed
- [ ] SSM parameters created (issuer, JWKS URL, client IDs, etc.)
- [ ] ALB client secret stored in Secrets Manager (auto-created for Cognito)

### Phase 3: API

Deploys ECS Fargate service with the Bedrock proxy router, JWT ALB, and listener rules. Builds and pushes the router container image automatically.

```bash
./scripts/deploy.sh api
```

- [ ] API stack deployed (ECR, ECS, JWT ALB)
- [ ] Router container image built and pushed
- [ ] ECS service running

### Phase 4: Distribution

Deploys the landing page Lambda, S3 assets bucket, and OIDC ALB for browser authentication.

```bash
./scripts/deploy.sh distribution
```

- [ ] Distribution stack deployed
- [ ] Landing page accessible
- [ ] OIDC browser auth working

---

## Post-Deployment Verification

```bash
# View deployment info (API + web endpoints)
./scripts/deploy.sh info

# API health check
curl https://<your-api-domain>/health

# Web endpoint
curl https://<your-web-domain>/
```

- [ ] API health endpoint returns OK
- [ ] Web endpoint loads landing page
- [ ] Authentication flow completes successfully

---

## Troubleshooting

### Router service won't start
Check ECS service events and container logs:
```bash
aws logs tail /ecs/bedrock-router-dev --follow
```
Common cause: container image not pushed. Run `./scripts/deploy.sh build-image`.

### ALB health checks failing
Check ECS task status and security group rules. Ensure the router container is running and listening on the expected port.

### Authentication not working
Verify OIDC SSM parameters exist and the JWKS endpoint is reachable:
```bash
./scripts/deploy.sh preflight
```
For external providers, confirm callback URLs match your domain configuration.

### Distribution stack fails
The distribution stack requires the ALB client secret in Secrets Manager. For Cognito mode, `deploy.sh auth` creates this automatically. For external providers, run `./scripts/setup.sh` or create the secret manually.

> **Tip:** Run `/troubleshoot` in opencode for interactive diagnosis.

---

## Command Reference

```bash
./scripts/deploy.sh                  # Full automated deploy (all phases)
./scripts/deploy.sh network          # Phase 1: Network + Certificate
./scripts/deploy.sh auth             # Phase 2: Auth + auto-create secret
./scripts/deploy.sh api              # Phase 3: API (ECS + JWT ALB + image build)
./scripts/deploy.sh distribution     # Phase 4: Distribution (Lambda + S3 + OIDC ALB)
./scripts/deploy.sh preflight        # Validate prerequisites without deploying
./scripts/deploy.sh build-image      # Build and push router image only
./scripts/deploy.sh redeploy         # Force ECS service redeployment
./scripts/deploy.sh info             # Show deployment endpoints
./scripts/deploy.sh publish          # Publish distribution assets to S3
```

## Opencode Skills

If you're using [opencode](https://opencode.ai), these skills provide interactive guidance:

| Skill | Purpose |
|-------|---------|
| `/deploy-preflight` | Validate all prerequisites before deployment |
| `/deploy-guide` | Step-by-step deployment walkthrough |
| `/verify-deployment` | Post-deployment health checks |
| `/troubleshoot` | Diagnose common deployment issues |
| `/jwt-debug` | Debug JWT authentication and API key issues |
