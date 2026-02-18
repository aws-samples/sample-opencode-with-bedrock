#!/bin/bash
# Interactive OIDC provider setup for OpenCode
# Guides deployers through configuring Okta, Auth0, Azure AD, or generic OIDC

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

print_error() { echo -e "${RED}Error: $1${NC}" >&2; }
print_success() { echo -e "${GREEN}$1${NC}"; }
print_warning() { echo -e "${YELLOW}$1${NC}"; }
print_info() { echo -e "${CYAN}$1${NC}"; }

REGION="${AWS_REGION:-us-east-1}"
ENVIRONMENT="${ENVIRONMENT:-dev}"
WEB_DOMAIN="${WEB_DOMAIN:-downloads.oc.example.com}"

echo ""
print_info "╔══════════════════════════════════════════════════════════════╗"
print_info "║            OpenCode OIDC Provider Setup                      ║"
print_info "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Select provider
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
        ISSUER="https://${okta_domain}/oauth2/default"
        ;;
    auth0)
        read -rp "Enter your Auth0 tenant (e.g., my-tenant.auth0.com): " auth0_tenant
        ISSUER="https://${auth0_tenant}"
        ;;
    azure)
        read -rp "Enter your Azure AD Tenant ID: " tenant_id
        ISSUER="https://login.microsoftonline.com/${tenant_id}/v2.0"
        ;;
    generic)
        read -rp "Enter your OIDC Issuer URL: " ISSUER
        ;;
esac

# Validate issuer via OIDC Discovery
echo ""
print_info "Validating OIDC issuer..."
DISCOVERY_URL="${ISSUER}/.well-known/openid-configuration"

if ! DISCOVERY_RESPONSE=$(curl -sf "$DISCOVERY_URL" 2>/dev/null); then
    print_error "Failed to fetch OIDC discovery document from:"
    echo "  $DISCOVERY_URL"
    echo ""
    echo "Please verify:"
    echo "  - The issuer URL is correct"
    echo "  - The OIDC provider is accessible from this machine"
    exit 1
fi

# Extract endpoints
AUTH_ENDPOINT=$(echo "$DISCOVERY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('authorization_endpoint',''))" 2>/dev/null || echo "")
TOKEN_ENDPOINT=$(echo "$DISCOVERY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token_endpoint',''))" 2>/dev/null || echo "")
USERINFO_ENDPOINT=$(echo "$DISCOVERY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('userinfo_endpoint',''))" 2>/dev/null || echo "")
JWKS_URI=$(echo "$DISCOVERY_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('jwks_uri',''))" 2>/dev/null || echo "")

if [[ -z "$AUTH_ENDPOINT" ]] || [[ -z "$TOKEN_ENDPOINT" ]]; then
    print_error "OIDC discovery response is missing required endpoints"
    echo "  authorization_endpoint: ${AUTH_ENDPOINT:-MISSING}"
    echo "  token_endpoint: ${TOKEN_ENDPOINT:-MISSING}"
    exit 1
fi

print_success "OIDC Discovery successful!"
echo "  Issuer:          $ISSUER"
echo "  Authorize:       $AUTH_ENDPOINT"
echo "  Token:           $TOKEN_ENDPOINT"
echo "  UserInfo:        $USERINFO_ENDPOINT"
echo "  JWKS URI:        $JWKS_URI"

# Verify JWKS endpoint is reachable
if curl -sf "$JWKS_URI" > /dev/null 2>&1; then
    print_success "  JWKS endpoint reachable"
else
    print_warning "  JWKS endpoint not reachable (may need network access)"
fi

# Print provider-specific instructions
echo ""
echo "═══════════════════════════════════════════════════════════════"
case $PROVIDER in
    okta)
        print_info "=== Okta Setup Instructions ==="
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
        print_info "=== Auth0 Setup Instructions ==="
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
        print_info "=== Azure AD Setup Instructions ==="
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
        print_info "=== Generic OIDC Setup Instructions ==="
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

# Prompt for created values
read -rp "Enter ALB Client ID: " ALB_CLIENT_ID
read -rsp "Enter ALB Client Secret: " ALB_CLIENT_SECRET
echo ""
read -rp "Enter CLI Client ID: " CLI_CLIENT_ID

if [[ -z "$ALB_CLIENT_ID" ]] || [[ -z "$ALB_CLIENT_SECRET" ]] || [[ -z "$CLI_CLIENT_ID" ]]; then
    print_error "All three values are required"
    exit 1
fi

echo ""
print_info "Storing ALB client secret in AWS Secrets Manager..."
if aws secretsmanager create-secret \
    --name "opencode/${ENVIRONMENT}/oidc-alb-client-secret" \
    --secret-string "$ALB_CLIENT_SECRET" \
    --region "$REGION" 2>/dev/null; then
    print_success "Secret created successfully"
elif aws secretsmanager put-secret-value \
    --secret-id "opencode/${ENVIRONMENT}/oidc-alb-client-secret" \
    --secret-string "$ALB_CLIENT_SECRET" \
    --region "$REGION" 2>/dev/null; then
    print_success "Secret updated successfully"
else
    print_warning "Could not store secret in Secrets Manager."
    echo "Store it manually:"
    echo "  aws secretsmanager create-secret \\"
    echo "    --name opencode/${ENVIRONMENT}/oidc-alb-client-secret \\"
    echo "    --secret-string '<your-secret>' \\"
    echo "    --region ${REGION}"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
print_success "Setup complete! Deploy with:"
echo ""
echo "npx cdk deploy --all \\"
echo "  -c authProvider=external \\"
echo "  -c oidcIssuer=${ISSUER} \\"
echo "  -c oidcAlbClientId=${ALB_CLIENT_ID} \\"
echo "  -c oidcCliClientId=${CLI_CLIENT_ID}"
echo ""
echo "After deployment, publish the distribution:"
echo "  ./scripts/publish-distribution.sh"
echo ""
