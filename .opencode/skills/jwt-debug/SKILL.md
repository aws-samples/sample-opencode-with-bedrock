---
name: jwt-debug
description: Debug JWT authentication issues — decode tokens, check expiry, verify JWKS, inspect ALB rules
---

# JWT Debug

You are helping the user debug JWT authentication issues with the OpenCode Stack. Work through the relevant checks based on the user's problem.

## Environment setup

Read the environment name from `cdk.context.json` (default: `dev`). Use it for all SSM parameter paths below.

## Step 1: Identify the problem

Ask the user what they're seeing, or detect from context. Common symptoms:

- **401 Unauthorized** on API requests
- **Token expired** errors
- **JWKS fetch failures**
- **Token works locally but not via ALB**
- **API key not working**

## Step 2: Token inspection

If the user has a token, decode and inspect it. **Never log or display the full token** — only show decoded claims.

### Decode the token

```bash
# Decode header
echo "$TOKEN" | jq -R 'split(".") | .[0] | @base64d | fromjson'

# Decode payload
echo "$TOKEN" | jq -R 'split(".") | .[1] | @base64d | fromjson'
```

### Check expiration

```bash
EXP=$(echo "$TOKEN" | jq -R 'split(".") | .[1] | @base64d | fromjson' | jq -r '.exp')
NOW=$(date +%s)
REMAINING=$((EXP - NOW))
```

Report whether the token is valid or expired, and by how many minutes.

### Verify claims match configuration

Fetch the expected values from SSM and compare:

| Claim | Expected SSM Parameter |
|-------|----------------------|
| `iss` | `/opencode/<env>/oidc/issuer` |
| `aud` | `/opencode/<env>/oidc/cli-client-id` |

If claims don't match, explain the mismatch and how to fix it.

## Step 3: JWKS endpoint verification

```bash
JWKS_URL=$(aws ssm get-parameter --name "/opencode/<env>/oidc/jwks-url" --query 'Parameter.Value' --output text)
curl -sf "$JWKS_URL" | jq '.keys | length'
```

Check:
- Is the JWKS URL reachable?
- Does it return a valid JSON document with a `keys` array?
- Does the `kid` in the token header match a key in the JWKS response?

## Step 4: ALB rule inspection

Fetch the listener ARN and inspect the full rule chain:

```bash
LISTENER_ARN=$(aws ssm get-parameter --name "/opencode/<env>/alb/jwt/listener-arn" --query 'Parameter.Value' --output text)
aws elbv2 describe-rules --listener-arn "$LISTENER_ARN" --query 'Rules[*].[Priority,Conditions[0].Field,Actions[0].Type]' --output table
```

Verify the expected rule priority chain:

| Priority | Rule | Description |
|----------|------|-------------|
| 1 | Health Check | `/health`, `/health/*`, `/ready` — no auth |
| 3 | API Key Management | `/v1/api-keys*` + Bearer — JWT validated |
| 5 | JWT Validation | `Authorization: Bearer*` — JWT validated |
| 10 | API Key Passthrough | `X-API-Key: oc_*` — forwarded to router |
| default | Catch-all | Returns 401 |

If rules are missing or misordered, suggest redeploying the API stack: `./scripts/deploy.sh api`.

## Step 5: API key debugging (if applicable)

If the user is having issues with API key auth (`X-API-Key` header):

1. Verify the key prefix is `oc_`
2. Check that the API key passthrough rule (priority 10) exists on the ALB
3. Check router logs for key validation errors:
   ```bash
   aws logs tail "/ecs/bedrock-router-<env>" --since 15m --filter-pattern "api-key"
   ```
4. Verify the DynamoDB API keys table exists:
   ```bash
   aws ssm get-parameter --name "/opencode/<env>/dynamodb/api-keys-table-name" --query 'Parameter.Value' --output text
   ```

## Step 6: Auth SSM parameters

Verify all OIDC SSM parameters are populated:

```bash
aws ssm get-parameters-by-path --path "/opencode/<env>/oidc/" --query 'Parameters[].{Name:Name,Value:Value}' --output table
```

Expected parameters:
- `/opencode/<env>/oidc/issuer`
- `/opencode/<env>/oidc/jwks-url`
- `/opencode/<env>/oidc/authorization-endpoint`
- `/opencode/<env>/oidc/token-endpoint`
- `/opencode/<env>/oidc/userinfo-endpoint`
- `/opencode/<env>/oidc/alb-client-id`
- `/opencode/<env>/oidc/cli-client-id`

If any are missing, suggest redeploying the auth stack: `./scripts/deploy.sh auth`.

## Step 7: ALB and ECS logs

If the issue isn't clear from the above, check logs:

```bash
# ALB logs (if enabled)
aws logs tail "/aws/elb/opencode-jwt-<env>" --since 30m

# Search for 401 errors
aws logs filter-log-events \
  --log-group-name "/aws/elb/opencode-jwt-<env>" \
  --filter-pattern '" 401 "' \
  --limit 10

# ECS router logs
aws logs tail "/ecs/bedrock-router-<env>" --since 30m
```

## Output format

After running checks, print a diagnosis summary:

```
JWT Debug Summary
─────────────────────────────────
Token status:    expired 23 minutes ago
Issuer match:    ✓ matches SSM value
Audience match:  ✗ token has "wrong-client-id", expected "correct-client-id"
JWKS endpoint:   ✓ reachable, 2 keys
ALB rules:       ✓ all 4 rules present
SSM parameters:  ✓ all 7 params populated
─────────────────────────────────
Diagnosis: Audience claim mismatch — the token was issued for a different client ID.
Fix: Re-authenticate with `opencode-auth login` to get a new token with the correct audience.
```

Always end with a clear diagnosis and specific remediation steps.
