---
name: troubleshoot
description: Diagnose common OpenCode Stack deployment issues
---

# Troubleshoot

You are helping the user diagnose deployment issues with the OpenCode Stack. Start by understanding what's failing, then run targeted checks.

## Initial triage

Ask the user what's failing, or detect from conversation context. Common categories:

1. **ECS / Router service** — tasks not starting, crashing, or unhealthy
2. **ALB / Networking** — health checks failing, 502/503 errors
3. **Authentication** — OIDC errors, login failures, callback issues
4. **DNS / Certificate** — domain not resolving, TLS errors
5. **Secrets Manager** — distribution stack fails, missing secret
6. **CDK / CloudFormation** — stack deploy failures
7. **Share feature** — share Lambda errors, WebSocket connection issues, share viewer not loading

## Diagnostic checks by category

### ECS / Router service

1. Get recent ECS service events:
   ```bash
   aws ecs describe-services --cluster <cluster> --services <service> --query 'services[0].events[:5]'
   ```
2. Check stopped task reason:
   ```bash
   aws ecs list-tasks --cluster <cluster> --service-name <service> --desired-status STOPPED
   aws ecs describe-tasks --cluster <cluster> --tasks <task-arn> --query 'tasks[0].stoppedReason'
   ```
3. Check container logs:
   ```bash
   aws logs tail /ecs/bedrock-router-<env> --since 30m
   ```
4. Verify the ECR image exists and was pushed recently:
   ```bash
   aws ecr describe-images --repository-name <repo> --query 'imageDetails | sort_by(@, &imagePushedAt) | [-1]'
   ```

### ALB / Networking

1. Check target health:
   ```bash
   aws elbv2 describe-target-health --target-group-arn <tg-arn>
   ```
2. Check ALB listener rules:
   ```bash
   aws elbv2 describe-listeners --load-balancer-arn <alb-arn>
   ```
3. Check security group rules — ensure the ALB can reach ECS tasks on the expected port.

### Authentication

1. Verify OIDC SSM parameters exist:
   ```bash
   aws ssm get-parameters-by-path --path "/opencode/<env>/oidc/" --query 'Parameters[].Name'
   ```
2. Check JWKS endpoint is reachable:
   ```bash
   curl -sf $(aws ssm get-parameter --name "/opencode/<env>/oidc/jwks-url" --query 'Parameter.Value' --output text)
   ```
3. Verify Secrets Manager secret exists and has a value:
   ```bash
   aws secretsmanager get-secret-value --secret-id "opencode/<env>/oidc-alb-client-secret" --query 'SecretString' --output text | head -c 5
   ```
   (Print only first 5 chars to confirm it exists without exposing the secret.)
4. For Cognito mode, check if the user pool and clients exist:
   ```bash
   aws ssm get-parameter --name "/opencode/<env>/cognito/user-pool-id" --query 'Parameter.Value' --output text
   ```

### DNS / Certificate

1. Check if DNS records resolve:
   ```bash
   dig +short <api-domain>
   dig +short <web-domain>
   ```
2. Check ACM certificate status:
   ```bash
   aws acm list-certificates --query "CertificateSummaryList[?DomainName=='*.<domain>']"
   ```

### Secrets Manager

1. Check if the secret exists:
   ```bash
   aws secretsmanager describe-secret --secret-id "opencode/<env>/oidc-alb-client-secret"
   ```
2. If missing in Cognito mode, suggest running `./scripts/deploy.sh auth` which auto-creates it.
3. If missing in external mode, suggest running `./scripts/setup.sh` or creating it manually.

### CDK / CloudFormation

1. Check stack status and events:
   ```bash
   aws cloudformation describe-stack-events --stack-name <stack> --query 'StackEvents[?ResourceStatus==`CREATE_FAILED` || ResourceStatus==`UPDATE_FAILED`][:5]'
    ```
2. Common failures:
   - **Resource already exists** — a previous failed deploy left orphaned resources. Delete the stack and redeploy.
   - **Insufficient permissions** — check IAM policies for the deploying role.
   - **Limit exceeded** — check service quotas (VPCs, EIPs, etc.).

### Share feature

1. Check if the share stack is deployed:
   ```bash
   aws cloudformation describe-stacks --stack-name OpenCodeShare-<env> --query 'Stacks[0].StackStatus'
   ```
2. Check share SSM parameters:
   ```bash
   aws ssm get-parameters-by-path --path "/opencode/<env>/share/" --query 'Parameters[].{Name:Name,Value:Value}' --output table
   ```
3. Check share API Lambda logs:
   ```bash
   aws logs tail "/aws/lambda/opencode-share-api-<env>" --since 30m
   ```
4. Check WebSocket Lambda logs (connect/disconnect/default):
   ```bash
   aws logs tail "/aws/lambda/opencode-share-ws-connect-<env>" --since 30m
   aws logs tail "/aws/lambda/opencode-share-ws-disconnect-<env>" --since 30m
   ```
5. Check DynamoDB connections table for stale entries:
   ```bash
   TABLE=$(aws ssm get-parameter --name "/opencode/<env>/share/connections-table-name" --query 'Parameter.Value' --output text 2>/dev/null)
   aws dynamodb scan --table-name "$TABLE" --select COUNT
   ```
6. Check S3 bucket for share data:
   ```bash
   BUCKET=$(aws ssm get-parameter --name "/opencode/<env>/share/bucket-name" --query 'Parameter.Value' --output text 2>/dev/null)
   aws s3 ls "s3://$BUCKET/" --summarize
   ```
7. Verify ALB rules exist at priorities 7-8 on both ALBs:
   ```bash
   # API ALB (JWT)
   LISTENER_ARN=$(aws ssm get-parameter --name "/opencode/<env>/alb/jwt/listener-arn" --query 'Parameter.Value' --output text)
   aws elbv2 describe-rules --listener-arn "$LISTENER_ARN" --query 'Rules[?Priority==`7` || Priority==`8`]'
   ```
8. Test WebSocket connectivity:
   ```bash
   WS_URL=$(aws ssm get-parameter --name "/opencode/<env>/share/websocket-url" --query 'Parameter.Value' --output text)
   # Use wscat or curl to test: wscat -c "$WS_URL"
   ```

## Remediation suggestions

After diagnosing, suggest specific fixes:
- For image issues: `./scripts/deploy.sh build-image`
- For secret issues: `./scripts/deploy.sh auth` (Cognito) or `./scripts/setup.sh` (external)
- For ECS issues: `./scripts/deploy.sh redeploy`
- For full redeploy: `./scripts/deploy.sh`
- For share feature issues: `./scripts/deploy.sh share`
- For preflight validation: `./scripts/deploy.sh preflight`

Get cluster name, service name, and other resource identifiers from SSM parameters under `/opencode/<env>/`.
