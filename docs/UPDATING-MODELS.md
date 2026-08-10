# Updating Models

How to add, update, or remove models from the distribution and propagate changes to all users.

## Overview

The system has two distribution mechanisms:

1. **Installer** — Full package with binaries + config. Users run this once (or on major updates).
2. **Config patches** — Incremental config updates applied automatically on each `oc` launch.

Config patches only work when users have a **versioned binary** (not a `dev` build). If the binary reports `opencode-auth version dev`, the config-patch system is bypassed entirely.

## Adding or Updating a Model

### Step 1: Update the Source Config

Edit `services/distribution/assets/opencode.json` and add/update the model entry under `provider.bedrock.models`:

```json
"my-new-model": {
  "name": "Display Name",
  "attachment": false,
  "modalities": { "input": ["text"], "output": ["text"] },
  "reasoning": true,
  "temperature": true,
  "tool_call": true,
  "cost": { "input": 0, "output": 0 },
  "limit": { "context": 128000, "output": 64000 }
}
```

### Step 2: Update the Router Model Map

Edit `services/router/main.py` and add the model to `DEFAULT_MODEL_MAP`:

```python
DEFAULT_MODEL_MAP = {
    ...
    "my-new-model": "provider.model-id-on-bedrock",
    "bedrock/my-new-model": "provider.model-id-on-bedrock",
}
```

If the model is not from Anthropic (i.e., doesn't start with `anthropic.` or `us.anthropic.`), it will be routed through Mantle automatically.

**Anthropic thinking shape:** Anthropic Claude Opus 4.7 and later (including Opus 5) require the *adaptive* thinking shape (`thinking.type = "adaptive"` + `output_config.effort`) and reject the legacy `thinking.type = "enabled"` shape. When adding such a model, also add both its keys to `ADAPTIVE_THINKING_MODELS` in `main.py`:

```python
ADAPTIVE_THINKING_MODELS = {
    ...
    "my-opus-model": ...,          # both the short name
    "bedrock/my-opus-model": ...,  # and the bedrock/ alias
}
```

Older Anthropic models (Opus 4.6, Sonnet) keep the legacy `enabled` shape and must NOT be added to this set. If unsure, test the model directly against Bedrock Converse with each shape before choosing.

### Step 3: Update IAM Permissions (if new provider)

If this is a new model provider (not Anthropic or Moonshot), update the ECS task role in `src/stacks/api-stack.ts` to grant `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the new model ARN pattern.

### Step 4: Redeploy the Router

```bash
./scripts/deploy.sh api
```

This rebuilds the container image and redeploys the ECS service with the updated model map.

### Step 5: Publish the Distribution

```bash
GOPROXY=direct ./scripts/publish-distribution.sh --version <current-version>
```

This:
- Cross-compiles versioned binaries for all platforms
- Repackages the installer zip with the updated `opencode.json`
- Auto-increments `config_version` in `config-patch.json` and `version.json`
- Uploads everything to S3

**Important:** Always pass `--version` to avoid publishing `dev` binaries that break the config-patch system.

To find the current version:
```bash
aws s3 cp s3://<distribution-bucket>/downloads/version.json - | python3 -c "import sys,json; print(json.load(sys.stdin)['latest'])"
```

### Step 6: Update the Landing Page (if model list changed significantly)

The landing page model list is hardcoded in `services/distribution/lambda/index.py`. If you added/removed models, update the HTML and deploy the Lambda:

```bash
cd services/distribution/lambda
zip -j /tmp/lambda-update.zip index.py
aws lambda update-function-code \
  --function-name opencode-landing-page-dev \
  --zip-file fileb:///tmp/lambda-update.zip
```

## How Config Patches Propagate

After publishing, users with versioned binaries get updates automatically:

1. On `oc` launch, `opencode-auth` fetches `version.json` from the distribution endpoint
2. If `version.json`'s `config_version` > local `last_config_version`, it fetches the config patch
3. Patch operations (`set_deep`) update `~/.opencode/opencode.json` with new model definitions
4. The local `last_config_version` is recorded to prevent re-applying

Users do **not** need to reinstall for model-only changes — they just need a versioned binary.

## When Users Must Reinstall

Users need to re-run the installer when:
- Their binary is a `dev` build (config patches don't work)
- A new binary version is required (security fix, new features)
- The `minimum` version in `version.json` is bumped above their current version

## Troubleshooting

### Config patch not applying

```bash
# Check binary version (must not be "dev")
opencode-auth --version

# Check local config version state
cat ~/.opencode/version-check.json

# Check server config version
curl -s https://<distribution-domain>/version.json | python3 -m json.tool

# Manually trigger config patch
opencode-auth update --config-only
```

### "Amazon Bedrock Models" vs "Bedrock Models" in /models

OpenCode has a **built-in** "Amazon Bedrock Models" provider that calls Bedrock directly using AWS credentials. This does not work with our stack because our ALB requires JWT authentication.

Users should only select models under **"Bedrock Models"** (the custom provider configured in `opencode.json`), which routes through the local proxy with proper auth headers.

### Go proxy blocked on corporate network

The Go module proxy (`proxy.golang.org`) may be blocked. Set `GOPROXY=direct` before running the publish script:

```bash
GOPROXY=direct ./scripts/publish-distribution.sh --version X.Y.Z
```

### deploy.sh distribution overwrites versioned binaries

`./scripts/deploy.sh distribution` calls `publish-distribution.sh` internally **without `--version`**, which publishes `dev` binaries. Always re-run the publish script with `--version` after a distribution CDK deploy:

```bash
./scripts/deploy.sh distribution
GOPROXY=direct ./scripts/publish-distribution.sh --version X.Y.Z
```

## Quick Reference

```bash
# Publish updated models (most common operation)
GOPROXY=direct ./scripts/publish-distribution.sh --version 1.2.1

# Redeploy router with new model map
./scripts/deploy.sh api

# Update landing page Lambda directly
cd services/distribution/lambda && zip -j /tmp/lambda.zip index.py
aws lambda update-function-code --function-name opencode-landing-page-dev --zip-file fileb:///tmp/lambda.zip

# Check what's currently published
aws s3 cp s3://<distribution-bucket>/downloads/version.json -
aws s3 cp s3://<distribution-bucket>/downloads/config-patch.json -
```
