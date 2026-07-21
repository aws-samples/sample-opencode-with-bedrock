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
