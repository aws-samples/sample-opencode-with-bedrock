# IdP Federation Config from AWS (Secrets Manager + SSM) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move external IdP federation inputs out of environment variables and `cdk.context.json` into AWS — the client secret into Secrets Manager (versionless dynamic reference) and the non-secret config (client_id / name / issuer) into SSM Parameter Store — so the AuthStack reads all IdP inputs from AWS.

**Architecture:** `AuthStack` (cognito mode) reads `idp/client-id`, `idp/name`, `idp/issuer` from SSM via `valueFromLookup`, and sets the Cognito IdP `client_secret` to a CloudFormation dynamic reference (`{{resolve:secretsmanager:opencode/${env}/idp/client-secret:SecretString}}`). Federation is declared by the presence of `idp/name` + `idp/issuer`; the dynamic reference means the IdP resource is always rendered when declared, so it can never be silently deleted. The `IDP_CLIENT_ID`/`IDP_CLIENT_SECRET` env-var path and `idpName`/`idpIssuer` context path are removed.

**Tech Stack:** AWS CDK (TypeScript), `aws-cdk-lib/aws-cognito`, `aws-cdk-lib/aws-ssm`, CloudFormation dynamic references, Jest + `aws-cdk-lib/assertions`.

---

## File Structure

- **`src/stacks/auth-stack.ts`** — MODIFY. Change `AuthStackProps` IdP fields; source IdP inputs from SSM + Secrets Manager dynamic reference; rewrite the intent-based guard; render the IdP with the dynamic-reference secret.
- **`src/main.ts`** — MODIFY. Stop reading `idpName`/`idpIssuer` from context and `IDP_CLIENT_ID`/`IDP_CLIENT_SECRET` from env; pass only `environment` (AuthStack does the lookups internally).
- **`test/auth-stack.test.ts`** — MODIFY. Replace federation tests to use SSM context stubs + assert dynamic reference; update guard tests.
- **`.env.example`** — MODIFY. Remove IdP env vars; point to the bootstrap runbook.
- **`cdk.context.json.example`** — MODIFY. Remove `idpName`/`idpIssuer`/`idpClientId`/`idpClientSecret` placeholder keys.
- **`scripts/bootstrap-idp.sh`** — CREATE. One-time helper to provision the four `idp/*` values into AWS.
- **`docs/IDP-FEDERATION.md`** — CREATE. Runbook: bootstrap commands, Federate profile expectations, redirect URI, recovery.

---

## Design decisions locked for implementation

- **Where lookups happen:** inside `AuthStack.createCognitoResources` (NOT `main.ts`). This keeps `main.ts` thin and puts all IdP sourcing in one place. `main.ts` passes only `environment` (already available).
- **SSM param names (inputs, distinct from existing `oidc/*` outputs):**
  - `/opencode/${env}/idp/client-id`
  - `/opencode/${env}/idp/name`
  - `/opencode/${env}/idp/issuer`
- **Secret name:** `opencode/${env}/idp/client-secret`
- **Declaration of intent:** federation is ON when both `idp/name` and `idp/issuer` resolve to non-empty, non-placeholder values.
- **`valueFromLookup` placeholder behavior:** when a param isn't in cached context, `ssm.StringParameter.valueFromLookup` returns a dummy string of the form `dummy-value-for-/opencode/.../idp/name`. The guard and intent detection MUST treat a value starting with `dummy-value-for-` as "not configured" so a fresh synth (no context) behaves as "no federation" rather than erroring or emitting a broken IdP. Tests stub real values via `app.node.setContext(...)`.

---

## Task 1: Update AuthStackProps to drop client secret/id/name/issuer inputs

**Files:**
- Modify: `src/stacks/auth-stack.ts` (interface `AuthStackProps`, lines ~13-19)

- [ ] **Step 1: Edit the interface**

In `src/stacks/auth-stack.ts`, replace the Cognito-mode IdP props:

```typescript
  // Cognito mode props
  cognitoDomainPrefix?: string;
  appDomainName?: string;
```

Remove these four lines entirely (they are no longer inputs — AuthStack reads them from AWS):

```typescript
  idpName?: string;
  idpIssuer?: string;
  idpClientId?: string;
  idpClientSecret?: string;
```

- [ ] **Step 2: Typecheck (expected to fail where props are still referenced)**

Run: `npx tsc --noEmit`
Expected: FAIL — errors in `auth-stack.ts` (uses `props.idpName` etc.) and `main.ts` (passes `idpName`, etc.). These are fixed in Tasks 2 and 4.

- [ ] **Step 3: Commit**

```bash
git add src/stacks/auth-stack.ts
git commit -m "refactor(auth): remove IdP inputs from AuthStackProps (sourced from AWS now)"
```

---

## Task 2: Source IdP config from SSM + Secrets Manager in AuthStack

**Files:**
- Modify: `src/stacks/auth-stack.ts` (imports; the IdP guard block ~113-153; the IdP creation block ~155-178; `supportedProviders` ~180)

- [ ] **Step 1: Ensure the ssm import exists**

At the top of `src/stacks/auth-stack.ts`, confirm this import is present (it already is — `ssm` is used for parameter outputs):

```typescript
import * as ssm from 'aws-cdk-lib/aws-ssm';
```

No new import is needed for the dynamic reference (it is a plain string).

- [ ] **Step 2: Replace the guard + config-sourcing block**

Replace the entire block that currently begins at the comment `// Identity Provider (fully configurable — no defaults)` and ends just before `// ALB Client (with secret for ALB OIDC auth)` (this includes the current guard, the `idpName`/`idpIssuer` consts, the `if (props.idpClientId && ...)` IdP creation, and the `supportedProviders` line) with:

```typescript
    // Identity Provider — external IdP inputs are sourced from AWS, not from
    // environment variables or cdk.context.json. This keeps all IdP inputs in
    // one durable, team-accessible place (bus-factor safe) and follows the
    // standard secrets-vs-config split:
    //   - non-secret config -> SSM Parameter Store (/opencode/<env>/idp/*)
    //   - client secret      -> Secrets Manager, via a CloudFormation dynamic
    //                           reference (never inlined into the template)
    //
    // Federation is DECLARED by the presence of idp/name + idp/issuer. Because
    // the secret is a dynamic reference, the IdP resource is always rendered
    // when federation is declared, so it can never be silently deleted by a
    // deploy that happens to be missing a credential.
    // IMPORTANT: pass an explicit defaultValue to valueFromLookup. Without a
    // default, valueFromLookup sets mustExist=true, which makes the context
    // lookup HARD-FAIL if the parameter does not exist in the account. That
    // would break the "no federation configured" path for adopters who never
    // provision idp/*. With a default supplied, a missing/uncached param
    // resolves to that default instead of erroring, so we can detect "not
    // configured" gracefully. We use the natural "dummy-value-for-<name>"
    // sentinel that valueFromLookup itself uses, and treat it as unconfigured.
    const NOT_SET = 'dummy-value-for-';
    const idpClientId = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/idp/client-id`,
      `${NOT_SET}/opencode/${props.environment}/idp/client-id`
    );
    const idpName = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/idp/name`,
      `${NOT_SET}/opencode/${props.environment}/idp/name`
    );
    const idpIssuer = ssm.StringParameter.valueFromLookup(
      this,
      `/opencode/${props.environment}/idp/issuer`,
      `${NOT_SET}/opencode/${props.environment}/idp/issuer`
    );

    // Treat the sentinel placeholder (param missing / not yet in cached
    // context) as "not configured".
    const isResolved = (v: string): boolean =>
      Boolean(v) && !v.startsWith(NOT_SET);

    const nameConfigured = isResolved(idpName);
    const issuerConfigured = isResolved(idpIssuer);
    const idpDeclared = nameConfigured || issuerConfigured;

    let identityProvider: cognito.CfnUserPoolIdentityProvider | undefined;

    if (idpDeclared) {
      if (!nameConfigured || !issuerConfigured) {
        throw new Error(
          'IdP federation is partially configured: both ' +
          `/opencode/${props.environment}/idp/name and ` +
          `/opencode/${props.environment}/idp/issuer must be set in SSM ` +
          'Parameter Store. Provision both (see docs/IDP-FEDERATION.md) or ' +
          'remove them to deploy with native Cognito login.'
        );
      }
      if (!isResolved(idpClientId)) {
        throw new Error(
          'IdP federation is configured (idp/name and idp/issuer are set) but ' +
          `/opencode/${props.environment}/idp/client-id is missing from SSM ` +
          'Parameter Store. Provision it (see docs/IDP-FEDERATION.md).'
        );
      }

      // Client secret via CloudFormation dynamic reference (versionless, to
      // support rotation without template changes). Never inlined; not logged.
      const clientSecretRef =
        `{{resolve:secretsmanager:opencode/${props.environment}/idp/client-secret:SecretString}}`;

      identityProvider = new cognito.CfnUserPoolIdentityProvider(this, 'OidcProvider', {
        userPoolId: userPool.userPoolId,
        providerName: idpName,
        providerType: 'OIDC',
        providerDetails: {
          client_id: idpClientId,
          client_secret: clientSecretRef,
          oidc_issuer: idpIssuer,
          authorize_scopes: 'openid email profile',
          attributes_request_method: 'GET',
        },
        attributeMapping: {
          email: 'email',
          email_verified: 'email_verified',
          given_name: 'given_name',
          family_name: 'family_name',
          username: 'sub',
        },
      });
    }

    const supportedProviders = identityProvider ? [idpName] : ['COGNITO'];
```

- [ ] **Step 3: Typecheck auth-stack (main.ts still broken — expected)**

Run: `npx tsc --noEmit`
Expected: FAIL only in `src/main.ts` (still passes removed props). No errors in `auth-stack.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/stacks/auth-stack.ts
git commit -m "feat(auth): source IdP config from SSM + Secrets Manager dynamic reference"
```

---

## Task 3: Simplify main.ts wiring

**Files:**
- Modify: `src/main.ts` (AuthStack instantiation, lines ~71-91)

- [ ] **Step 1: Remove the IdP prop lines**

In `src/main.ts`, delete these four lines from the `new AuthStack(...)` call:

```typescript
  idpName: app.node.tryGetContext('idpName') || undefined,
  idpIssuer: app.node.tryGetContext('idpIssuer') || undefined,
  idpClientId: process.env.IDP_CLIENT_ID || undefined,
  idpClientSecret: process.env.IDP_CLIENT_SECRET || undefined,
```

The remaining Cognito-mode props (`cognitoDomainPrefix`, `appDomainName`) and `environment` (already in `stackProps`/passed) stay. AuthStack now reads IdP inputs from AWS itself using `props.environment`.

- [ ] **Step 2: Typecheck (should now pass)**

Run: `npx tsc --noEmit`
Expected: PASS (no output).

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "refactor(main): stop passing IdP inputs to AuthStack"
```

---

## Task 4: Update auth-stack tests for the new sourcing model

**Files:**
- Modify: `test/auth-stack.test.ts`

- [ ] **Step 1: Replace the "IdP federation" describe block**

Replace the entire `describe('AuthStack — Cognito mode with IdP federation', ...)` block (lines ~104-131) with a version that stubs the SSM params via context. `valueFromLookup` reads cached context under the key `ssm:account=<acct>:parameterName=<name>:region=<region>`; set those so the values resolve to real strings:

```typescript
describe('AuthStack — Cognito mode with IdP federation', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const ctx = (name: string, value: string) =>
      app.node.setContext(
        `ssm:account=${testEnv.account}:parameterName=${name}:region=${testEnv.region}`,
        value
      );
    ctx('/opencode/test/idp/client-id', 'test-client-id');
    ctx('/opencode/test/idp/name', 'Okta');
    ctx('/opencode/test/idp/issuer', 'https://dev-example.okta.com/oauth2/default');

    const stack = new AuthStack(app, 'TestAuthCognitoIdp', {
      environment: 'test',
      provider: 'cognito',
      cognitoDomainPrefix: 'opencode-test',
      appDomainName: 'oc.example.com',
      env: testEnv,
    });
    template = Template.fromStack(stack);
  });

  test('creates a User Pool Identity Provider', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 1);
  });

  test('IdP client_secret is a Secrets Manager dynamic reference (never inlined)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderName: 'Okta',
      ProviderDetails: Match.objectLike({
        client_id: 'test-client-id',
        client_secret:
          '{{resolve:secretsmanager:opencode/test/idp/client-secret:SecretString}}',
        oidc_issuer: 'https://dev-example.okta.com/oauth2/default',
      }),
    });
  });

  test('creates User Pool and clients alongside IdP', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
  });
});
```

- [ ] **Step 2: Replace the guard tests in the "Error cases" block**

In `describe('AuthStack — Error cases', ...)`, remove the previous IdP guard tests (the PR #21 tests: "throws when IdP federation is declared ... credentials are missing", "throws when only idpName is set without idpIssuer", "does NOT throw and uses native Cognito ...") and replace them with SSM-based equivalents:

```typescript
  test('throws when idp/name is set without idp/issuer (partial config)', () => {
    expect(() => {
      const app = new cdk.App();
      app.node.setContext(
        `ssm:account=${testEnv.account}:parameterName=/opencode/test/idp/name:region=${testEnv.region}`,
        'Okta'
      );
      new AuthStack(app, 'TestAuthIdpPartial', {
        environment: 'test',
        provider: 'cognito',
        cognitoDomainPrefix: 'opencode-test',
        appDomainName: 'oc.example.com',
        env: testEnv,
      });
    }).toThrow('IdP federation is partially configured');
  });

  test('throws when name+issuer are set but client-id is missing', () => {
    expect(() => {
      const app = new cdk.App();
      const ctx = (name: string, value: string) =>
        app.node.setContext(
          `ssm:account=${testEnv.account}:parameterName=${name}:region=${testEnv.region}`,
          value
        );
      ctx('/opencode/test/idp/name', 'Okta');
      ctx('/opencode/test/idp/issuer', 'https://dev-example.okta.com/oauth2/default');
      // client-id intentionally not set
      new AuthStack(app, 'TestAuthIdpNoClientId', {
        environment: 'test',
        provider: 'cognito',
        cognitoDomainPrefix: 'opencode-test',
        appDomainName: 'oc.example.com',
        env: testEnv,
      });
    }).toThrow('/opencode/test/idp/client-id is missing');
  });

  test('does NOT throw and uses native Cognito when no IdP params are set', () => {
    expect(() => {
      const app = new cdk.App();
      const stack = new AuthStack(app, 'TestAuthNoIdp', {
        environment: 'test',
        provider: 'cognito',
        cognitoDomainPrefix: 'opencode-test',
        appDomainName: 'oc.example.com',
        env: testEnv,
      });
      const t = Template.fromStack(stack);
      t.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
    }).not.toThrow();
  });
```

- [ ] **Step 3: Confirm `Match` is imported**

At the top of `test/auth-stack.test.ts`, confirm:

```typescript
import { Template, Match } from 'aws-cdk-lib/assertions';
```

(It already is.)

- [ ] **Step 4: Run the auth-stack tests**

Run: `npx jest test/auth-stack.test.ts`
Expected: PASS — all tests including the new dynamic-reference assertion and the two guard cases.

- [ ] **Step 5: Commit**

```bash
git add test/auth-stack.test.ts
git commit -m "test(auth): cover SSM-sourced IdP config and dynamic-reference secret"
```

---

## Task 5: Bootstrap helper script

**Files:**
- Create: `scripts/bootstrap-idp.sh`

- [ ] **Step 1: Write the script**

Create `scripts/bootstrap-idp.sh`:

```bash
#!/usr/bin/env bash
# Provision external IdP federation inputs into AWS for a given environment.
# Run ONCE per environment (and to update values). Requires AWS creds with
# ssm:PutParameter and secretsmanager:CreateSecret/PutSecretValue.
#
# Usage:
#   ./scripts/bootstrap-idp.sh <env> <client-id> <provider-name> <issuer-url> <client-secret>
#
# Example:
#   ./scripts/bootstrap-idp.sh dev opencode-cognito-dev Midway \
#     https://idp.federate.amazon.com 'the-secret-value'
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "Usage: $0 <env> <client-id> <provider-name> <issuer-url> <client-secret>" >&2
  exit 1
fi

ENV="$1"; CLIENT_ID="$2"; NAME="$3"; ISSUER="$4"; SECRET="$5"
PREFIX="/opencode/${ENV}/idp"
SECRET_NAME="opencode/${ENV}/idp/client-secret"

echo "Writing non-secret config to SSM Parameter Store..."
aws ssm put-parameter --overwrite --type String \
  --name "${PREFIX}/client-id" --value "${CLIENT_ID}"
aws ssm put-parameter --overwrite --type String \
  --name "${PREFIX}/name" --value "${NAME}"
aws ssm put-parameter --overwrite --type String \
  --name "${PREFIX}/issuer" --value "${ISSUER}"

echo "Writing client secret to Secrets Manager (${SECRET_NAME})..."
if aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value \
    --secret-id "${SECRET_NAME}" --secret-string "${SECRET}" >/dev/null
  echo "  updated existing secret"
else
  aws secretsmanager create-secret \
    --name "${SECRET_NAME}" --secret-string "${SECRET}" \
    --description "External IdP OIDC client secret for OpenCode ${ENV}" >/dev/null
  echo "  created new secret"
fi

echo "Done. Verify with:"
echo "  aws ssm get-parameters-by-path --path ${PREFIX} --query 'Parameters[].Name'"
echo "  aws secretsmanager describe-secret --secret-id ${SECRET_NAME} --query Name"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/bootstrap-idp.sh`

- [ ] **Step 3: Shellcheck / syntax check**

Run: `bash -n scripts/bootstrap-idp.sh`
Expected: no output (valid syntax).

- [ ] **Step 4: Commit**

```bash
git add scripts/bootstrap-idp.sh
git commit -m "feat(scripts): add bootstrap-idp.sh to provision IdP inputs into AWS"
```

---

## Task 6: Update .env.example and cdk.context.json.example

**Files:**
- Modify: `.env.example`
- Modify: `cdk.context.json.example`

- [ ] **Step 1: Edit `.env.example`**

Remove the IdP federation block:

```
# Cognito IdP Federation (required if cdk.context.json has idpName set)
# These are the OIDC client credentials for your identity provider.
# They are passed as environment variables (not in cdk.context.json) to avoid
# committing secrets to any config file.
# IDP_CLIENT_ID=your-idp-client-id
# IDP_CLIENT_SECRET=your-idp-client-secret
```

Replace it with:

```
# Cognito IdP Federation
# IdP inputs are NO LONGER supplied via environment variables. They are stored
# in AWS (SSM Parameter Store for non-secret config, Secrets Manager for the
# client secret) and read by the AuthStack at deploy time.
# Provision them once with scripts/bootstrap-idp.sh — see docs/IDP-FEDERATION.md.
```

- [ ] **Step 2: Edit `cdk.context.json.example`**

Remove these keys (and any accompanying `_oidcIssuer` example comment lines referencing them):

```
  "idpName": "YourIdP",
  "idpIssuer": "https://your-idp-issuer.example.com",
  "idpClientId": "your-idp-client-id",
  "idpClientSecret": "your-idp-client-secret",
```

Ensure the resulting file is still valid JSON (no trailing comma left behind).

- [ ] **Step 3: Validate JSON**

Run: `python3 -c "import json; json.load(open('cdk.context.json.example')); print('valid')"`
Expected: `valid`

- [ ] **Step 4: Commit**

```bash
git add .env.example cdk.context.json.example
git commit -m "docs(config): remove IdP env/context inputs; point to AWS-sourced bootstrap"
```

---

## Task 7: IdP federation runbook

**Files:**
- Create: `docs/IDP-FEDERATION.md`

- [ ] **Step 1: Write the runbook**

Create `docs/IDP-FEDERATION.md`:

```markdown
# IdP Federation (external OIDC provider)

The AuthStack can federate Cognito to an external OIDC identity provider. All
IdP inputs live in AWS — nothing is stored in `.env` or `cdk.context.json` —
so they survive operator turnover and follow the standard secrets-vs-config
split.

## Where the inputs live

| Value | Store | Name |
|-------|-------|------|
| Client secret | Secrets Manager | `opencode/<env>/idp/client-secret` |
| Client ID | SSM Parameter Store | `/opencode/<env>/idp/client-id` |
| Provider name | SSM Parameter Store | `/opencode/<env>/idp/name` |
| Issuer URL | SSM Parameter Store | `/opencode/<env>/idp/issuer` |

These are **inputs describing your external IdP**, distinct from the
`/opencode/<env>/oidc/*` params (which are Cognito *outputs*).

## Enabling federation

1. Register an OIDC client with your IdP. The redirect/callback URI is your
   Cognito hosted-UI domain:
   `https://<cognito-domain>.auth.<region>.amazoncognito.com/oauth2/idpresponse`
2. Provision the four values into AWS (one-time):

   ```bash
   ./scripts/bootstrap-idp.sh <env> <client-id> <provider-name> <issuer-url> <client-secret>
   ```

3. Deploy the auth stack:

   ```bash
   npx cdk deploy OpenCodeAuth-<env>
   ```

The AuthStack reads `idp/name` + `idp/issuer` to detect that federation is
configured, reads `idp/client-id`, and references the secret via a
CloudFormation dynamic reference — the secret value is never inlined into the
template.

## Disabling federation

Delete the `idp/*` SSM params (and optionally the secret), then redeploy. With
no `idp/name`/`idp/issuer`, the stack falls back to native Cognito login.

## Recovery / bus-factor

Every input is retrievable from AWS by any teammate with access:

```bash
aws ssm get-parameters-by-path --path /opencode/<env>/idp \
  --query 'Parameters[].[Name,Value]' --output table
aws secretsmanager get-secret-value \
  --secret-id opencode/<env>/idp/client-secret --query SecretString --output text
```

If the secret is lost, regenerate it from your IdP's client registration and
re-run `bootstrap-idp.sh`. Keep the IdP client registration owned by a team
group (not an individual) so it is always regenerable.

## Guard behavior

- If `idp/name` and `idp/issuer` are set but `idp/client-id` is missing → synth
  fails with a clear error.
- If only one of `idp/name` / `idp/issuer` is set → synth fails (both required).
- If the referenced secret does not exist at deploy → CloudFormation fails while
  resolving the dynamic reference, **without** deleting the identity provider.
```

- [ ] **Step 2: Commit**

```bash
git add docs/IDP-FEDERATION.md
git commit -m "docs: add IdP federation runbook (bootstrap, recovery, guard behavior)"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no output).

- [ ] **Step 2: Full test suite**

Run: `npx jest`
Expected: all tests pass. (Note: the CDK-heavy suites occasionally emit a
"worker process failed to exit gracefully" teardown warning that is unrelated
to pass/fail — re-run once if a suite is flagged but all individual tests
passed.)

- [ ] **Step 3: Synth with no IdP context (fresh adopter path — native Cognito)**

Run: `npx cdk synth OpenCodeAuth-dev 2>/dev/null | grep -c "AWS::Cognito::UserPoolIdentityProvider" || true`
Expected: `0` when no `idp/*` params are cached/provisioned (federation off).
Note: on the real `dev` account this requires the `idp/*` params NOT to be in
cached context; if they are provisioned + cached, expect `1`. Interpret in
context.

- [ ] **Step 4: Commit any final touch-ups (if needed)**

```bash
git status
# only if there are stray changes to record
```

---

## Migration note (operator step for the existing `dev` stack — NOT part of code commits)

After merging, to migrate the live `dev` stack off env/context:

1. Provision the four values (secret already known; `client-id=opencode-cognito-dev`, `name=Midway`, `issuer=https://idp.federate.amazon.com`):
   ```bash
   ./scripts/bootstrap-idp.sh dev opencode-cognito-dev Midway \
     https://idp.federate.amazon.com '<client-secret>'
   ```
2. Deploy: `npx cdk deploy OpenCodeAuth-dev` (with the `idp/*` params now in AWS; a `cdk context --reset` or fresh synth may be needed so the lookups cache the real values).
3. Verify the `Midway` IdP is still present and both clients federate; confirm the dynamic reference resolved to the same secret (IdP updated in place, not recreated/deleted).
4. Remove `IDP_CLIENT_ID`/`IDP_CLIENT_SECRET` from local `.env` and `idpName`/`idpIssuer` from `cdk.context.json`.
```
