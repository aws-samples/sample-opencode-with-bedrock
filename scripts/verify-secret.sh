#!/bin/bash
# Verify Secrets Manager secret exists and has a value
# Usage: ./verify-secret.sh [environment]
# Example: ./verify-secret.sh dev

set -e

ENVIRONMENT="${1:-dev}"
SECRET_NAME="opencode/${ENVIRONMENT}/oidc-alb-client-secret"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_info "Verifying secret: $SECRET_NAME"

# Check if secret exists
if ! aws secretsmanager describe-secret --secret-id "$SECRET_NAME" &> /dev/null; then
    log_error "Secret not found: $SECRET_NAME"
    echo ""
    log_error "This secret is required for OIDC ALB authentication."
    log_error "Please create it before deploying Phase 3 (Distribution)."
    echo ""
    log_info "Run './scripts/deploy.sh auth' to create it automatically (Cognito mode)"
    log_info "Or run './scripts/setup.sh' for external OIDC providers"
    exit 1
fi

log_success "Secret exists"

# Check if secret has a value
SECRET_VALUE=$(aws secretsmanager get-secret-value \
    --secret-id "$SECRET_NAME" \
    --query 'SecretString' \
    --output text 2>/dev/null) || true

if [ -z "$SECRET_VALUE" ]; then
    log_error "Secret exists but has no value"
    log_error "Please update the secret with the Cognito ALB client secret."
    log_info "Run './scripts/deploy.sh auth' to sync it from Cognito"
    exit 1
fi

log_success "Secret has a value (${#SECRET_VALUE} characters)"

# Get secret details
SECRET_ARN=$(aws secretsmanager describe-secret \
    --secret-id "$SECRET_NAME" \
    --query 'ARN' \
    --output text)

CREATED_DATE=$(aws secretsmanager describe-secret \
    --secret-id "$SECRET_NAME" \
    --query 'CreatedDate' \
    --output text)

log_info "Secret ARN: $SECRET_ARN"
log_info "Created: $CREATED_DATE"

echo ""
log_success "Secret verification passed!"
log_info "You can now deploy Phase 3 (Distribution)"
