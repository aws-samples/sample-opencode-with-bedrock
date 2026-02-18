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

## After deployment

Run `./scripts/deploy.sh info` to display the API and web endpoints.

Print a final summary with the endpoints and suggest the user test:
- `curl https://<api-domain>/health`
- Opening `https://<web-domain>/` in a browser

If any phase fails, help the user diagnose the issue. Check CloudFormation events, ECS service events, and container logs as needed.
