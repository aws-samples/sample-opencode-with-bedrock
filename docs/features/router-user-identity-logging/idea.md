---
id: router-user-identity-logging
name: Add User Identity to Router Logs
type: Enhancement
priority: P0
effort: Small
impact: High
created: 2026-02-27
---

# Add User Identity to Router Logs

## Problem Statement

The router's auth middleware (`api_key_auth_middleware` at `main.py:896-1018`) already extracts `user_sub`, `user_email`, and `auth_source` on every authenticated request, but none of the log statements include these fields. This makes it impossible to attribute Bedrock usage and costs to specific users.

This gap was discovered during a cost investigation where $38,500 in Kimi K2.5 Mantle charges appeared on the account with no way to identify the responsible user. Bedrock model invocation logging does not capture Mantle API calls (bearer token auth bypasses it), so the router logs are the only source of truth for 3rd-party model usage attribution.

## Proposed Solution

Add `auth_source`, `user_sub`, and `user_email` from the `request` object to the `extra` dict on these log statements in `services/router/main.py`:

| Log Statement | Location | Priority |
|---|---|---|
| "Request started" | `request_logging_middleware` ~line 1396 | High |
| "Request completed" | `request_logging_middleware` ~line 1410 | High |
| "Forwarding to Bedrock Mantle" | `chat_completions` ~line 1512 | High |
| "Mantle streaming complete" | `chat_completions` ~line 1580 | High |
| "Mantle non-streaming response" | `chat_completions` ~line 1531 | High |
| "Stream usage emitted" | Anthropic streaming handler | Medium |
| "Request failed" | error handler ~line 1427 | Medium |

Example change for "Request started":

```python
log.info(
    "Request started",
    extra={
        "request_id": request_id,
        "method": request.method,
        "path": request.path,
        "user_agent": request.headers.get("User-Agent", "unknown"),
        "auth_source": request.get("auth_source", ""),     # ADD
        "user_sub": request.get("user_sub", ""),            # ADD
        "user_email": request.get("user_email", ""),        # ADD
    },
)
```

The `request` object is accessible in all target locations -- either directly as a function parameter or via closure scope.

## Success Criteria

- [ ] All log statements listed above include `user_sub` and `auth_source`
- [ ] CloudWatch Insights query `stats sum(prompt_tokens) by user_email, modelId` returns per-user breakdowns
- [ ] Mantle (Kimi, DeepSeek, etc.) requests are attributable to specific users
- [ ] No PII concerns -- `user_sub` is a Cognito UUID, `user_email` is internal corp email

## Notes

Created via feature-capture during cost investigation of account 046264621987.

Context: Bedrock model invocation logging (enabled 2026-02-27) captures identity for Converse/InvokeModel (SigV4) calls but NOT for Mantle API (bearer token) calls. The router is the only place to capture identity for 3P model usage (Kimi K2.5, DeepSeek, etc.).
