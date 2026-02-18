#!/bin/bash
# OpenCode Stack — Unified Setup & Pre-deploy Validation
# Guides users through authentication setup, validates prerequisites,
# and optionally kicks off deployment.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

ENVIRONMENT="${ENVIRONMENT:-dev}"
AWS_REGION="${AWS_REGION:-us-east-1}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

print_error()   { echo -e "${RED}  x $1${NC}"; }
print_success() { echo -e "${GREEN}  ✓ $1${NC}"; }
print_warning() { echo -e "${YELLOW}  ! $1${NC}"; }
print_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }

# ─── Read defaults from cdk.json ──────────────────────────
CDK_JSON="$PROJECT_DIR/cdk.json"
read_cdk_context() {
    local key=$1
    python3 -c "import json; print(json.load(open('$CDK_JSON')).get('context',{}).get('$key',''))" 2>/dev/null || echo ""
}

DEFAULT_API_DOMAIN=$(read_cdk_context "apiDomain")
DEFAULT_WEB_DOMAIN=$(read_cdk_context "webDomain")

# ─── Banner ───────────────────────────────────────────────
echo ""
echo -e "${BOLD}=========================================${NC}"
echo -e "${BOLD}  OpenCode Stack Setup${NC}"
echo -e "${BOLD}=========================================${NC}"
echo ""
echo -e "  Environment: ${CYAN}${ENVIRONMENT}${NC}"
echo -e "  Region:      ${CYAN}${AWS_REGION}${NC}"
echo ""

# ─── Domain Configuration ─────────────────────────────────
echo -e "${BOLD}--- Domain Configuration ---${NC}"
echo ""

read -rp "API domain [${DEFAULT_API_DOMAIN:-oc.example.com}]: " API_DOMAIN
API_DOMAIN="${API_DOMAIN:-${DEFAULT_API_DOMAIN:-oc.example.com}}"

read -rp "Web/downloads domain [${DEFAULT_WEB_DOMAIN:-downloads.${API_DOMAIN}}]: " WEB_DOMAIN
WEB_DOMAIN="${WEB_DOMAIN:-${DEFAULT_WEB_DOMAIN:-downloads.${API_DOMAIN}}}"

echo ""
print_success "API domain:  $API_DOMAIN"
print_success "Web domain:  $WEB_DOMAIN"

# ─── Auth Mode Selection ──────────────────────────────────
echo ""
echo "Select authentication mode:"
echo "  1) Cognito with federated IdP (e.g., Okta, Azure AD via Cognito)"
echo "  2) External OIDC provider (Okta, Auth0, Azure AD direct)"
echo "  3) Cognito only (user pool login, no federation)"
echo ""
read -rp "> " auth_mode

case $auth_mode in
    1) AUTH_MODE="cognito-federated" ;;
    2) AUTH_MODE="external" ;;
    3) AUTH_MODE="cognito-only" ;;
    *)
        print_error "Invalid choice"
        exit 1
        ;;
esac

# ─── Gather Auth Configuration ────────────────────────────

CDK_DEPLOY_FLAGS="-c apiDomain=${API_DOMAIN} -c webDomain=${WEB_DOMAIN}"

case $AUTH_MODE in
    cognito-federated)
        echo ""
        echo -e "${BOLD}--- Cognito + Federated IdP Setup ---${NC}"
        echo ""

        read -rp "IdP Name: " IDP_NAME
        if [ -z "$IDP_NAME" ]; then
            print_error "IdP Name is required"
            exit 1
        fi

        DEFAULT_ISSUER=""

        if [ -n "$DEFAULT_ISSUER" ]; then
            read -rp "IdP Issuer URL [$DEFAULT_ISSUER]: " IDP_ISSUER
            IDP_ISSUER="${IDP_ISSUER:-$DEFAULT_ISSUER}"
        else
            read -rp "IdP Issuer URL: " IDP_ISSUER
            if [ -z "$IDP_ISSUER" ]; then
                print_error "IdP Issuer URL is required"
                exit 1
            fi
        fi

        read -rp "IdP Client ID: " IDP_CLIENT_ID
        if [ -z "$IDP_CLIENT_ID" ]; then
            print_error "IdP Client ID is required"
            exit 1
        fi

        read -rsp "IdP Client Secret: " IDP_CLIENT_SECRET
        echo ""
        if [ -z "$IDP_CLIENT_SECRET" ]; then
            print_error "IdP Client Secret is required"
            exit 1
        fi

        # Validate OIDC Discovery
        echo ""
        print_info "Validating OIDC Discovery..."
        DISCOVERY_URL="${IDP_ISSUER}/.well-known/openid-configuration"
        if curl -sf "$DISCOVERY_URL" > /dev/null 2>&1; then
            print_success "$DISCOVERY_URL is reachable"
        else
            print_warning "$DISCOVERY_URL is not reachable (may require VPN or internal network)"
        fi

        # Non-secret values pass as CDK context flags; secrets pass as env vars
        CDK_DEPLOY_FLAGS="$CDK_DEPLOY_FLAGS -c idpName=${IDP_NAME} -c idpIssuer=${IDP_ISSUER}"
        export IDP_CLIENT_ID
        export IDP_CLIENT_SECRET
        ;;

    external)
        echo ""
        echo -e "${BOLD}--- External OIDC Provider Setup ---${NC}"
        echo ""
        echo "Select your OIDC provider:"
        echo "  1) Okta"
        echo "  2) Auth0"
        echo "  3) Azure AD"
        echo "  4) Generic OIDC"
        echo ""
        read -rp "> " provider_choice

        case $provider_choice in
            1) PROVIDER="okta" ;;
            2) PROVIDER="auth0" ;;
            3) PROVIDER="azure" ;;
            4) PROVIDER="generic" ;;
            *)
                print_error "Invalid choice"
                exit 1
                ;;
        esac

        # Get issuer URL based on provider
        echo ""
        case $PROVIDER in
            okta)
                read -rp "Enter your Okta domain (e.g., dev-123456.okta.com): " okta_domain
                OIDC_ISSUER="https://${okta_domain}/oauth2/default"
                ;;
            auth0)
                read -rp "Enter your Auth0 tenant (e.g., my-tenant.auth0.com): " auth0_tenant
                OIDC_ISSUER="https://${auth0_tenant}"
                ;;
            azure)
                read -rp "Enter your Azure AD Tenant ID: " tenant_id
                OIDC_ISSUER="https://login.microsoftonline.com/${tenant_id}/v2.0"
                ;;
            generic)
                read -rp "Enter your OIDC Issuer URL: " OIDC_ISSUER
                ;;
        esac

        # Validate OIDC Discovery
        echo ""
        print_info "Validating OIDC issuer..."
        DISCOVERY_URL="${OIDC_ISSUER}/.well-known/openid-configuration"

        if DISCOVERY_RESPONSE=$(curl -sf "$DISCOVERY_URL" 2>/dev/null); then
            print_success "OIDC Discovery successful"

            # Extract and display endpoints
            AUTH_ENDPOINT=$(echo "$DISCOVERY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('authorization_endpoint',''))" 2>/dev/null || echo "")
            TOKEN_ENDPOINT=$(echo "$DISCOVERY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token_endpoint',''))" 2>/dev/null || echo "")
            USERINFO_ENDPOINT=$(echo "$DISCOVERY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('userinfo_endpoint',''))" 2>/dev/null || echo "")
            JWKS_URI=$(echo "$DISCOVERY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('jwks_uri',''))" 2>/dev/null || echo "")

            echo "  Issuer:     $OIDC_ISSUER"
            echo "  Authorize:  $AUTH_ENDPOINT"
            echo "  Token:      $TOKEN_ENDPOINT"
            echo "  UserInfo:   $USERINFO_ENDPOINT"
            echo "  JWKS URI:   $JWKS_URI"

            if [ -z "$AUTH_ENDPOINT" ] || [ -z "$TOKEN_ENDPOINT" ]; then
                print_error "Discovery response is missing required endpoints"
                exit 1
            fi
        else
            print_error "Failed to fetch OIDC discovery document from: $DISCOVERY_URL"
            echo "  Please verify the issuer URL and that it's accessible."
            exit 1
        fi

        # Print provider-specific setup instructions
        echo ""
        echo "═══════════════════════════════════════════════════════════════"
        case $PROVIDER in
            okta)
                echo -e "${CYAN}=== Okta Setup Instructions ===${NC}"
                echo ""
                echo "You need to create TWO applications in Okta:"
                echo ""
                echo "1. ALB Application (Web):"
                echo "   - Type: Web Application"
                echo "   - Grant type: Authorization Code"
                echo "   - Sign-in redirect URIs:"
                echo "     https://${WEB_DOMAIN}/oauth2/idpresponse"
                echo "   - Sign-out redirect URIs:"
                echo "     https://${WEB_DOMAIN}/"
                echo "   - Scopes: openid, email, profile"
                echo "   -> Note the Client ID and Client Secret"
                echo ""
                echo "2. CLI Application (Native/SPA):"
                echo "   - Type: Native Application"
                echo "   - Grant type: Authorization Code with PKCE"
                echo "   - Sign-in redirect URIs:"
                echo "     http://localhost:19876/callback"
                echo "     http://localhost:8080/callback"
                echo "   - Scopes: openid, email, profile"
                echo "   -> Note the Client ID (no secret needed)"
                ;;
            auth0)
                echo -e "${CYAN}=== Auth0 Setup Instructions ===${NC}"
                echo ""
                echo "You need to create TWO applications in Auth0:"
                echo ""
                echo "1. ALB Application (Regular Web):"
                echo "   - Type: Regular Web Application"
                echo "   - Allowed Callback URLs:"
                echo "     https://${WEB_DOMAIN}/oauth2/idpresponse"
                echo "   - Allowed Logout URLs:"
                echo "     https://${WEB_DOMAIN}/"
                echo "   - Enable: Allow Cross-Origin Authentication"
                echo "   -> Note the Client ID and Client Secret"
                echo ""
                echo "2. CLI Application (Native):"
                echo "   - Type: Native Application"
                echo "   - Allowed Callback URLs:"
                echo "     http://localhost:19876/callback"
                echo "     http://localhost:8080/callback"
                echo "   - Token Endpoint Authentication Method: None"
                echo "   -> Note the Client ID (no secret needed)"
                ;;
            azure)
                echo -e "${CYAN}=== Azure AD Setup Instructions ===${NC}"
                echo ""
                echo "You need to create TWO app registrations in Azure AD:"
                echo ""
                echo "1. ALB Application (Web):"
                echo "   - Type: Web"
                echo "   - Redirect URI:"
                echo "     https://${WEB_DOMAIN}/oauth2/idpresponse"
                echo "   - Create a client secret under Certificates & secrets"
                echo "   - API permissions: openid, email, profile"
                echo "   - Ensure 'email' claim is included in token config"
                echo "   -> Note the Application (client) ID and Client Secret"
                echo ""
                echo "2. CLI Application (Public client):"
                echo "   - Type: Public client/native"
                echo "   - Redirect URIs:"
                echo "     http://localhost:19876/callback"
                echo "     http://localhost:8080/callback"
                echo "   - Enable: Allow public client flows = Yes"
                echo "   -> Note the Application (client) ID"
                ;;
            generic)
                echo -e "${CYAN}=== Generic OIDC Setup Instructions ===${NC}"
                echo ""
                echo "Create two OIDC clients with your provider:"
                echo ""
                echo "1. ALB Client (confidential):"
                echo "   - Grant type: Authorization Code"
                echo "   - Redirect URI: https://${WEB_DOMAIN}/oauth2/idpresponse"
                echo "   - Scopes: openid email profile"
                echo "   -> Note the Client ID and Client Secret"
                echo ""
                echo "2. CLI Client (public):"
                echo "   - Grant type: Authorization Code with PKCE"
                echo "   - Redirect URIs:"
                echo "     http://localhost:19876/callback"
                echo "     http://localhost:8080/callback"
                echo "   - Scopes: openid email profile"
                echo "   -> Note the Client ID"
                ;;
        esac
        echo ""
        echo "═══════════════════════════════════════════════════════════════"
        echo ""

        # Collect client credentials
        read -rp "Enter ALB Client ID: " ALB_CLIENT_ID
        read -rsp "Enter ALB Client Secret: " ALB_CLIENT_SECRET
        echo ""
        read -rp "Enter CLI Client ID: " CLI_CLIENT_ID

        if [ -z "$ALB_CLIENT_ID" ] || [ -z "$ALB_CLIENT_SECRET" ] || [ -z "$CLI_CLIENT_ID" ]; then
            print_error "All three values are required"
            exit 1
        fi

        # Store ALB client secret in Secrets Manager
        echo ""
        print_info "Storing ALB client secret in AWS Secrets Manager..."
        SECRET_NAME="opencode/${ENVIRONMENT}/oidc-alb-client-secret"
        if aws secretsmanager create-secret \
            --name "$SECRET_NAME" \
            --secret-string "$ALB_CLIENT_SECRET" \
            --description "OIDC ALB client secret for Bedrock Inference" \
            --region "$AWS_REGION" 2>/dev/null; then
            print_success "Secret created: $SECRET_NAME"
        elif aws secretsmanager put-secret-value \
            --secret-id "$SECRET_NAME" \
            --secret-string "$ALB_CLIENT_SECRET" \
            --region "$AWS_REGION" 2>/dev/null; then
            print_success "Secret updated: $SECRET_NAME"
        else
            print_warning "Could not store secret in Secrets Manager."
            print_warning "Store it manually before deploying distribution:"
            echo "  aws secretsmanager create-secret \\"
            echo "    --name $SECRET_NAME \\"
            echo "    --secret-string '<your-secret>'"
        fi

        CDK_DEPLOY_FLAGS="$CDK_DEPLOY_FLAGS -c authProvider=external -c oidcIssuer=${OIDC_ISSUER} -c oidcAlbClientId=${ALB_CLIENT_ID} -c oidcCliClientId=${CLI_CLIENT_ID}"
        ;;

    cognito-only)
        echo ""
        echo -e "${BOLD}--- Cognito Only (No Federation) ---${NC}"
        echo ""
        echo "Cognito user pool with direct email/password sign-in."
        echo "No IdP federation will be configured."
        echo ""
        ;;
esac

# ─── Pre-deploy Validation ────────────────────────────────

echo ""
echo -e "${BOLD}--- Pre-deploy Validation ---${NC}"

ERRORS=0

# AWS CLI
if command -v aws &> /dev/null; then
    print_success "AWS CLI installed"
else
    print_error "AWS CLI not installed"
    ERRORS=$((ERRORS + 1))
fi

# AWS credentials
ACCOUNT_ID=$(aws sts get-caller-identity --query 'Account' --output text 2>/dev/null) || true
if [ -n "$ACCOUNT_ID" ]; then
    print_success "AWS credentials valid (account: $ACCOUNT_ID)"
else
    print_error "AWS credentials invalid or not configured"
    ERRORS=$((ERRORS + 1))
fi

# CDK
if npx cdk --version &> /dev/null; then
    CDK_VERSION=$(npx cdk --version 2>/dev/null | head -1)
    print_success "CDK installed ($CDK_VERSION)"
else
    print_error "CDK not installed. Run: npm install"
    ERRORS=$((ERRORS + 1))
fi

# Node.js 18+
NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1) || true
if [ -n "$NODE_VERSION" ] && [ "$NODE_VERSION" -ge 18 ]; then
    print_success "Node.js $(node -v) installed"
else
    print_error "Node.js 18+ required (found: $(node -v 2>/dev/null || echo 'not installed'))"
    ERRORS=$((ERRORS + 1))
fi

# npm dependencies
cd "$PROJECT_DIR"
if [ -d "node_modules" ]; then
    print_success "npm dependencies installed"
else
    print_info "Installing npm dependencies..."
    npm install > /dev/null 2>&1
    if [ -d "node_modules" ]; then
        print_success "npm dependencies installed"
    else
        print_error "npm install failed"
        ERRORS=$((ERRORS + 1))
    fi
fi

# CDK build
print_info "Checking CDK build..."
if npm run build > /dev/null 2>&1; then
    print_success "CDK builds successfully"
else
    print_error "CDK build failed. Run 'npm run build' for details."
    ERRORS=$((ERRORS + 1))
fi

# Container builder
if command -v docker &> /dev/null; then
    print_success "Container builder available (docker)"
elif command -v finch &> /dev/null; then
    print_success "Container builder available (finch)"
else
    print_warning "No container builder (docker/finch) — router image build will be skipped"
fi

# Summarize
echo ""
if [ $ERRORS -gt 0 ]; then
    print_error "$ERRORS validation error(s). Fix the issues above before deploying."
    exit 1
fi

print_success "All pre-deploy checks passed"

# ─── Deploy Prompt ────────────────────────────────────────

echo ""
echo -e "${BOLD}--- Ready to Deploy ---${NC}"
echo ""

if [ -n "$IDP_CLIENT_ID" ]; then
    echo "Deploy command:"
    echo -e "  ${CYAN}IDP_CLIENT_ID=<your-client-id> \\\\${NC}"
    echo -e "  ${CYAN}IDP_CLIENT_SECRET=<your-client-secret> \\\\${NC}"
    echo -e "  ${CYAN}./scripts/deploy.sh ${CDK_DEPLOY_FLAGS}${NC}"
    echo ""
    echo -e "  (Secrets are passed via env vars, not CLI args)"
else
    echo "Deploy command:"
    echo -e "  ${CYAN}./scripts/deploy.sh ${CDK_DEPLOY_FLAGS}${NC}"
fi
echo ""

read -rp "Would you like to deploy now? [y/N] " deploy_now

if [[ "$deploy_now" =~ ^[Yy]$ ]]; then
    echo ""
    print_info "Starting deployment..."
    echo ""

    # Secrets are already exported as env vars (IDP_CLIENT_ID, IDP_CLIENT_SECRET)
    # Non-secret context flags are passed via -c
    # shellcheck disable=SC2086
    exec "$SCRIPT_DIR/deploy.sh" $CDK_DEPLOY_FLAGS
else
    echo ""
    print_info "Deployment skipped. Run the command above when ready."
fi
