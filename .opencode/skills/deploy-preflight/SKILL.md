---
name: deploy-preflight
description: Validate all prerequisites before deploying the OpenCode Stack
---

# Deploy Preflight

You are validating that all prerequisites are met before deploying the OpenCode Stack. Run each check below and report a clear pass/fail summary at the end.

## Checks to perform

### 1. AWS CLI and credentials
Run `aws sts get-caller-identity` to verify the AWS CLI is installed and credentials are valid. Report the account ID and region.

### 2. Node.js version
Verify Node.js 18+ is installed by checking `node -v`.

### 3. Container builder
Check if `docker` or `finch` is available. Report which one is found, or warn if neither exists (image builds will be skipped).

### 4. Context configuration
Check if `cdk.context.json` exists in the project root. If it doesn't, tell the user to run `./scripts/setup.sh` or copy from `cdk.context.json.example`.

### 5. npm dependencies
Check if `node_modules/` exists. If missing, suggest running `npm install`.

### 6. CDK synth
Run `npx cdk synth --quiet` to validate the CDK app builds without errors. If it fails, show the error output.

### 7. Existing SSM parameters (informational)
Check if auth SSM parameters exist under `/opencode/<environment>/oidc/`. This is informational — missing params are expected before first deploy.

### 8. Secrets Manager (informational)
Check if `opencode/<environment>/oidc-alb-client-secret` exists in Secrets Manager. This is informational — the secret is auto-created during `deploy.sh auth` for Cognito mode.

## Output format

After all checks, print a summary table:

```
Preflight Summary
─────────────────────────────────
✓ AWS credentials      — account 123456789012 (us-east-1)
✓ Node.js              — v22.x
✓ Container builder    — docker
✓ cdk.context.json     — found
✓ npm dependencies     — installed
✓ CDK synth            — passed
○ SSM parameters       — not found (expected before first deploy)
○ Secrets Manager      — not found (auto-created during auth deploy)
─────────────────────────────────
Result: READY TO DEPLOY
```

Use `✓` for pass, `✗` for fail, and `○` for informational items. If any required check fails, the result should be `NOT READY — fix issues above`.
