# Design: Source IdP Federation Config from AWS (Secrets Manager + SSM)

**Date:** 2026-07-21
**Status:** Approved (pending spec review)
**Branch:** `feat/idp-secrets-manager`
**Scope:** Change how `AuthStack` obtains external IdP federation inputs — move them out of environment variables / `cdk.context.json` and into AWS (Secrets Manager for the secret, SSM Parameter Store for non-secret config) so they survive operator departure and follow the standard secrets-vs-config split.

## Motivation

Today the AuthStack obtains IdP federation inputs from ephemeral/local sources:

- `IDP_CLIENT_ID` / `IDP_CLIENT_SECRET` — environment variables (must be re-supplied every shell)
- `idpName` / `idpIssuer` — `cdk.context.json` (gitignored, laptop-only)

This caused a production incident: a deploy run without the env vars synthesized a template with no identity provider, and CloudFormation **deleted** the existing IdP, reverting all app clients to native Cognito login (a silent auth outage). PR #21 added a guard that fails loudly in that state. This design removes the underlying fragility:

1. **Bus-factor:** all IdP inputs live only on one operator's machine. If that person is unavailable, no teammate can recover or redeploy. (This mirrors the real incident, where the original engineer had left.)
2. **Secret handling:** the client secret was inlined into the deployed CloudFormation template, making it readable by anyone with template access and unrecoverable once overwritten.

## Decisions (from brainstorming)

| Topic | Decision |
|-------|----------|
| Secret ownership | Secret created **out-of-band** (once); CDK only **references** it. CDK never sees or manages the secret value. |
| Backward compatibility | **None required** — this is a reference sample. Single clean path; the `IDP_CLIENT_SECRET` env-var path is removed. |
| Secret identification | **Conventional name** from environment: `opencode/${environment}/idp/client-secret`. |
| Non-secret config location | **SSM Parameter Store** (`opencode/${environment}/idp/*`), NOT `cdk.context.json`. Standard secrets-vs-config split; reuses the repo's existing SSM pattern. |
| IdP inputs source of truth | **All IdP inputs live in AWS.** CDK reads them; nothing IdP-related in `cdk.context.json`. |
| Guard behavior | **Intent-based.** The dynamic reference means the IdP resource is always rendered when federation is configured, so it can no longer be silently deleted. CloudFormation fails loudly at deploy if the referenced secret is absent. |

## Architecture

### New AWS-resident IdP inputs (bootstrapped out-of-band, once)

| Value | Store | Name | Sensitivity |
|-------|-------|------|-------------|
| Client secret | Secrets Manager | `opencode/${env}/idp/client-secret` | secret |
| Client ID | SSM Parameter Store | `opencode/${env}/idp/client-id` | non-secret |
| Provider name | SSM Parameter Store | `opencode/${env}/idp/name` | non-secret |
| Issuer URL | SSM Parameter Store | `opencode/${env}/idp/issuer` | non-secret |

These are **inputs describing an external IdP** — distinct from the existing `opencode/${env}/oidc/*` params, which are **Cognito outputs** (issuer, jwks, endpoints, Cognito-generated client IDs) written by AuthStack and read by Api/Distribution. Verified: no namespace collision, no downstream impact.

### How AuthStack consumes them

- **Non-secret config** (`client-id`, `name`, `issuer`): read at synth via `ssm.StringParameter.valueFromLookup(...)`, consistent with how Api/Distribution already read `oidc/*`.
- **Secret** (`client-secret`): referenced via a **versionless** CloudFormation dynamic reference:
  ```
  {{resolve:secretsmanager:opencode/${env}/idp/client-secret:SecretString}}
  ```
  Confirmed supported: `secretsmanager` dynamic references work in all resource properties, and resolved values are not persisted in CloudFormation logs. Versionless per AWS best practice (supports rotation without template changes).

### Intent + guard logic (replaces PR #21's env-var check)

Federation is **declared** by the presence of the `idp/name` + `idp/issuer` SSM params (looked up at synth). When declared:
- `providerDetails.client_secret` = the dynamic reference (always present in the template → IdP resource always rendered → cannot be silently deleted).
- If `idp/name` or `idp/issuer` is absent → throw at synth (both required together — retains PR #21's completeness check).
- If the referenced secret does not exist at deploy → CloudFormation fails loudly while resolving the reference, **without deleting the IdP** (safe failure).

The obsolete `IDP_CLIENT_SECRET` env-var check from PR #21 is removed; the dynamic reference supersedes it.

## Bootstrap (one-time, documented, team-runnable)

A documented script/runbook provisions the four values into AWS for a given environment:

```bash
# Secret
aws secretsmanager create-secret \
  --name opencode/${ENV}/idp/client-secret \
  --secret-string '<client-secret>'

# Non-secret config
aws ssm put-parameter --type String \
  --name /opencode/${ENV}/idp/client-id --value '<client-id>'
aws ssm put-parameter --type String \
  --name /opencode/${ENV}/idp/name --value 'Midway'
aws ssm put-parameter --type String \
  --name /opencode/${ENV}/idp/issuer --value 'https://idp.federate.amazon.com'
```

For a public-sample adopter this makes the "provision your external IdP inputs" step explicit rather than hidden in a gitignored file. A teammate can read/recreate all four with documented commands — bus-factor solved.

## Changes required

1. **`src/main.ts`** — stop passing `idpClientId`/`idpClientSecret` (env) and `idpName`/`idpIssuer` (context) into AuthStack; AuthStack now sources them from AWS itself (or main.ts performs the `valueFromLookup` and passes them in — decide during implementation for cleanest wiring).
2. **`src/stacks/auth-stack.ts`** — read `idp/*` SSM params via `valueFromLookup`; set `client_secret` to the dynamic reference; update the guard to intent-based; grant nothing extra (dynamic reference needs no IAM — resolved by CloudFormation, not the stack role).
3. **`.env.example`** — remove `IDP_CLIENT_ID`/`IDP_CLIENT_SECRET`; document the bootstrap step instead.
4. **`cdk.context.json.example`** — remove `idpName`/`idpIssuer`/`idpClientId`/`idpClientSecret` placeholder keys (no longer context-sourced).
5. **Docs** — add a short "Provisioning IdP federation inputs" runbook (e.g. in `docs/`), covering the bootstrap commands, the Federate profile expectations, redirect URI, and recovery.
6. **Bootstrap script** — optional helper under `scripts/` to set the four values.

## Testing

- **Unit (`test/auth-stack.test.ts`):**
  - IdP config present (mock SSM lookups) → IdP resource rendered with a `{{resolve:secretsmanager:...}}` client_secret.
  - `idp/name` without `idp/issuer` → throws (completeness guard).
  - No IdP config → native Cognito, no IdP resource, no throw.
- **Note on `valueFromLookup`:** returns a dummy placeholder at synth when context is uncached; tests set context or assert on the token/placeholder. Confirm approach during implementation.
- `npx tsc --noEmit` clean; full `jest` run.

## Migration for the existing `dev` stack (operator step, not code)

1. Bootstrap the four `idp/*` values into AWS (secret currently known; client_id `opencode-cognito-dev`; name `Midway`; issuer `https://idp.federate.amazon.com`).
2. Deploy `feat/idp-secrets-manager`'s AuthStack.
3. Verify the `Midway` IdP still present and both clients federate — the dynamic reference should re-resolve to the same secret (no IdP deletion).
4. Once confirmed, `IDP_CLIENT_ID`/`IDP_CLIENT_SECRET` can be dropped from the local `.env`, and `idpName`/`idpIssuer` from `cdk.context.json`.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Switching `client_secret` to a dynamic reference updates the live IdP resource | Same secret value → re-resolves identically; IdP updated in place, not deleted. Verify in dev before relying on it. |
| Referenced secret missing at deploy | CloudFormation fails loudly during resolution; does not delete the IdP. |
| `valueFromLookup` synth-time placeholder behavior in tests/CI | Set context in tests; document that first synth needs the params to exist (or cached context). |
| Adopters who don't use federation | Guard is intent-based (only fires when `idp/*` present); no federation = native Cognito, unaffected. |

## Out of scope

- Secret rotation automation (best-practice note only; versionless reference is rotation-ready).
- Any change to the downstream `oidc/*` outputs or Api/Distribution consumers.
