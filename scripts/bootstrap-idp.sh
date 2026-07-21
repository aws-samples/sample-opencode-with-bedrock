#!/usr/bin/env bash
# Provision external IdP federation inputs into AWS for a given environment.
# Run ONCE per environment (and to update values). Requires AWS creds with
# ssm:PutParameter and secretsmanager:CreateSecret/PutSecretValue.
#
# NOTE: the client secret is passed as a command-line argument, so it may appear
# in your shell history and process list. Acceptable for one-time operator use;
# do NOT use this pattern in automation.
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
REGION="${AWS_REGION:-us-east-1}"

echo "Writing non-secret config to SSM Parameter Store..."
aws ssm put-parameter --overwrite --type String \
  --name "${PREFIX}/client-id" --value "${CLIENT_ID}" --region "${REGION}"
aws ssm put-parameter --overwrite --type String \
  --name "${PREFIX}/name" --value "${NAME}" --region "${REGION}"
aws ssm put-parameter --overwrite --type String \
  --name "${PREFIX}/issuer" --value "${ISSUER}" --region "${REGION}"

echo "Writing client secret to Secrets Manager (${SECRET_NAME})..."
if aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value \
    --secret-id "${SECRET_NAME}" --secret-string "${SECRET}" --region "${REGION}" >/dev/null
  echo "  updated existing secret"
else
  aws secretsmanager create-secret \
    --name "${SECRET_NAME}" --secret-string "${SECRET}" \
    --description "External IdP OIDC client secret for OpenCode ${ENV}" --region "${REGION}" >/dev/null
  echo "  created new secret"
fi

echo "Done. Verify with:"
echo "  aws ssm get-parameters-by-path --path ${PREFIX} --query 'Parameters[].Name'"
echo "  aws secretsmanager describe-secret --secret-id ${SECRET_NAME} --query Name"
