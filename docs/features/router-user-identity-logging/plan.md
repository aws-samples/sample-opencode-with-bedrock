---
id: router-user-identity-logging
status: completed
started: 2026-02-27
completed: 2026-02-28
---

# Implementation Plan: Add User Identity to Router Logs

## Overview

Add `user_sub`, `user_email`, and `auth_source` to all request lifecycle log statements in `services/router/main.py`. The auth middleware already populates these fields on every authenticated request -- they just need to be included in the log `extra` dicts.

## Implementation Steps

### Step 1: Add identity to `request_logging_middleware`

**File:** `services/router/main.py`

Three log statements updated:

| Log Message | Fields Added |
|---|---|
| "Request started" | `auth_source`, `user_sub`, `user_email` |
| "Request completed" | `auth_source`, `user_sub`, `user_email` |
| "Request failed" | `auth_source`, `user_sub`, `user_email` |

All three use `request.get("user_sub", "")` etc. The auth middleware runs before the logging middleware (see middleware ordering at line ~1721), so these fields are guaranteed to be set.

### Step 2: Add identity to Mantle log statements in `chat_completions`

**File:** `services/router/main.py`

Three log statements updated:

| Log Message | Fields Added |
|---|---|
| "Forwarding to Bedrock Mantle" | `user_sub`, `user_email` |
| "Mantle non-streaming response" | `user_sub`, `user_email` |
| "Mantle streaming complete" | `user_sub`, `user_email` |

### Step 3: Add identity to Anthropic streaming usage log

**File:** `services/router/main.py`

| Log Message | Fields Added |
|---|---|
| "Stream usage emitted" | `user_sub`, `user_email` |

### Step 4: Deploy and verify -- DONE

Deployed 2026-02-27 ~16:47 CT. Verified working in production.

**Useful CloudWatch Insights queries:**

Per-user cost attribution (all models):
```
fields @timestamp, user_email, model, prompt_tokens, completion_tokens
| filter @message like /Stream usage emitted/
| stats sum(prompt_tokens) as total_input, sum(completion_tokens) as total_output by user_email, model
| sort total_input desc
```

Mantle/Kimi usage by user:
```
fields @timestamp, user_email, usage.prompt_tokens, usage.completion_tokens
| filter @message like /Mantle streaming complete/
| stats sum(usage.prompt_tokens) as total_input, sum(usage.completion_tokens) as total_output by user_email
| sort total_input desc
```

## Verification Results

- Confirmed `user_email` and `user_sub` appear on all 7 log statements
- Verified with both Anthropic (Claude Opus) and Mantle (Kimi K2.5) traffic
- Two users observed: `schuettc@amazon.com`, `mvincig@amazon.com`
- Prompt caching fields (`cache_read_tokens`, `cache_write_tokens`) continue to work alongside identity fields

## Notes on Kimi/Mantle Caching

Prompt caching is **not available** for Kimi/Mantle models. The Mantle path in the router is a transparent proxy -- it forwards OpenAI-format requests as-is to the Mantle API. Caching would require Mantle to expose a caching mechanism (e.g., OpenAI-compatible `cache_control` on content parts). Currently, Kimi responses return only `prompt_tokens` and `completion_tokens` with no cache-related fields.

For comparison, Anthropic caching works because the router translates requests to the Bedrock Converse API and injects `cachePoint` blocks. The Mantle API has no equivalent.

## Risks & Considerations

- **PII**: `user_email` is internal corp email, `user_sub` is a Cognito UUID. Both acceptable for operational logs.
- **Log volume**: No increase -- we added fields to existing log statements, not new ones.
- **Backward compatibility**: CloudWatch Insights queries that don't reference the new fields are unaffected.
- **Unauthenticated paths**: Health checks skip auth middleware and won't have identity fields. The `request.get("user_sub", "")` pattern handles this safely with empty defaults.
- **Log retention**: The router log group has 7-day retention. Consider increasing to 30+ days to retain evidence for cost investigations.
