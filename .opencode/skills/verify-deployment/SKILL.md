---
name: verify-deployment
description: Post-deployment health checks and endpoint validation for the OpenCode Stack
---

# Verify Deployment

You are performing post-deployment health checks on the OpenCode Stack. Run each check and report the results.

## Environment detection

Read the environment name from `cdk.context.json` (default: `dev`). Use this for SSM parameter paths and stack names.

## Checks to perform

### 1. Read endpoints from SSM

Fetch the API and web domain names:
```bash
aws ssm get-parameter --name "/opencode/<env>/api/dns-name" --query 'Parameter.Value' --output text
aws ssm get-parameter --name "/opencode/<env>/web/dns-name" --query 'Parameter.Value' --output text
```

### 2. API health endpoints

Hit the API health endpoints and report status:
```bash
curl -sf https://<api-domain>/health
curl -sf https://<api-domain>/ready
```

### 3. ECS service status

Check the ECS service desired vs running task count:
```bash
aws ecs describe-services \
  --cluster <cluster-name> \
  --services <service-name> \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount}'
```

Get cluster and service names from SSM:
- `/opencode/<env>/ecs/cluster-name`
- `/opencode/<env>/ecs/router-service-name`

### 4. ALB target health

Check that ALB targets are healthy:
```bash
aws elbv2 describe-target-health --target-group-arn <tg-arn>
```

Get the target group ARN from the API stack CloudFormation outputs or SSM parameters.

### 5. Distribution endpoint

Verify the web/distribution endpoint responds:
```bash
curl -sf -o /dev/null -w '%{http_code}' https://<web-domain>/
```

### 6. Auth verification

Confirm OIDC SSM parameters are populated:
- `/opencode/<env>/oidc/issuer`
- `/opencode/<env>/oidc/jwks-url`
- `/opencode/<env>/oidc/alb-client-id`
- `/opencode/<env>/oidc/cli-client-id`

Verify the JWKS endpoint is reachable:
```bash
curl -sf <jwks-url> | head -c 100
```

## Output format

Print a summary:

```
Deployment Health Check
─────────────────────────────────
✓ API endpoint         — https://oc.example.com (200 OK)
✓ Health check         — healthy
✓ ECS service          — 2/2 tasks running
✓ ALB targets          — 2 healthy
✓ Distribution         — https://downloads.oc.example.com (200 OK)
✓ OIDC config          — all SSM params present, JWKS reachable
─────────────────────────────────
Status: ALL HEALTHY
```

Use `✓` for healthy, `✗` for unhealthy, and `○` for unable to check. If anything is unhealthy, suggest running `/troubleshoot` for diagnosis.
