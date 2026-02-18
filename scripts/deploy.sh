#!/bin/bash
set -e

# OpenCode Stack Deployment Script
# Deploys all stacks in the correct order with proper error handling

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENVIRONMENT="${ENVIRONMENT:-dev}"
AWS_REGION="${AWS_REGION:-us-east-1}"

# Container builder configuration (docker or finch)
CONTAINER_BUILDER="${CONTAINER_BUILDER:-docker}"

# CDK context flags (populated by -c arguments)
CDK_CONTEXT_FLAGS=""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
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

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check AWS CLI
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI is not installed"
        exit 1
    fi

    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        log_error "AWS credentials not configured or invalid"
        exit 1
    fi

    # Check CDK (using local npx)
    if ! npx cdk --version &> /dev/null; then
        log_error "AWS CDK is not installed. Run: npm install"
        exit 1
    fi

    # Check container builder (docker default, finch as alternative)
    if [ "$CONTAINER_BUILDER" = "docker" ]; then
        if ! command -v docker &> /dev/null; then
            log_warning "Docker is not installed. Checking for Finch..."
            if command -v finch &> /dev/null; then
                log_info "Found Finch, using as fallback"
                CONTAINER_BUILDER="finch"
            else
                log_warning "Neither Docker nor Finch found. Router image build will be skipped."
                CONTAINER_BUILDER=""
            fi
        else
            log_info "Using Docker for container builds"
        fi
    elif [ "$CONTAINER_BUILDER" = "finch" ]; then
        if ! command -v finch &> /dev/null; then
            log_warning "Finch is not installed. Router image build will be skipped."
            CONTAINER_BUILDER=""
        else
            log_info "Using Finch for container builds"
        fi
    fi

    log_success "Prerequisites check passed"
}

# ─── Secret Management ───────────────────────────────────

# Auto-create the OIDC ALB client secret in Secrets Manager from Cognito outputs.
# Called after Auth stack deploy in Cognito mode.
ensure_alb_client_secret() {
    local secret_name="opencode/${ENVIRONMENT}/oidc-alb-client-secret"

    # Check if this is Cognito mode (user-pool-id SSM param exists)
    local user_pool_id
    user_pool_id=$(aws ssm get-parameter \
        --name "/opencode/${ENVIRONMENT}/cognito/user-pool-id" \
        --query 'Parameter.Value' --output text 2>/dev/null) || true

    if [ -z "$user_pool_id" ]; then
        # External mode — secret must already exist (created by setup-oidc-provider.sh)
        if aws secretsmanager get-secret-value --secret-id "$secret_name" --query 'SecretString' --output text &> /dev/null; then
            log_success "ALB client secret exists in Secrets Manager (external mode)"
            return 0
        fi
        log_warning "Not in Cognito mode and no ALB client secret found."
        log_warning "For external OIDC providers, run: ./scripts/setup-oidc-provider.sh"
        return 1
    fi

    # Cognito mode — always sync the secret from the current Cognito client
    log_info "Syncing ALB client secret from Cognito..."

    local alb_client_id
    alb_client_id=$(aws ssm get-parameter \
        --name "/opencode/${ENVIRONMENT}/oidc/alb-client-id" \
        --query 'Parameter.Value' --output text 2>/dev/null) || true

    if [ -z "$alb_client_id" ]; then
        log_error "ALB client ID not found in SSM. Auth stack may not have deployed correctly."
        return 1
    fi

    local client_secret
    client_secret=$(aws cognito-idp describe-user-pool-client \
        --user-pool-id "$user_pool_id" \
        --client-id "$alb_client_id" \
        --query 'UserPoolClient.ClientSecret' \
        --output text 2>/dev/null) || true

    if [ -z "$client_secret" ]; then
        log_error "Failed to retrieve ALB client secret from Cognito."
        return 1
    fi

    # Create or update the secret
    if aws secretsmanager describe-secret --secret-id "$secret_name" &> /dev/null; then
        aws secretsmanager put-secret-value \
            --secret-id "$secret_name" \
            --secret-string "$client_secret" > /dev/null
        log_success "ALB client secret synced in Secrets Manager"
    else
        aws secretsmanager create-secret \
            --name "$secret_name" \
            --secret-string "$client_secret" \
            --description "OIDC ALB client secret for OpenCode (auto-created)" > /dev/null
        log_success "ALB client secret created in Secrets Manager"
    fi
}

# Check if Secrets Manager secret exists and has a value
check_secrets_manager_secret() {
    local secret_name="opencode/${ENVIRONMENT}/oidc-alb-client-secret"

    log_info "Checking Secrets Manager secret: $secret_name"

    if ! aws secretsmanager describe-secret --secret-id "$secret_name" &> /dev/null; then
        log_error "Secrets Manager secret not found: $secret_name"
        return 1
    fi

    # Verify secret has a value
    local secret_value
    secret_value=$(aws secretsmanager get-secret-value \
        --secret-id "$secret_name" \
        --query 'SecretString' \
        --output text 2>/dev/null) || true

    if [ -z "$secret_value" ]; then
        log_error "Secret exists but has no value: $secret_name"
        return 1
    fi

    log_success "Secrets Manager secret verified"
    return 0
}

# ─── Validation ───────────────────────────────────────────

# Validate SSM parameters exist after Auth stack deployment
validate_auth_ssm_params() {
    log_info "Validating Auth stack SSM parameters..."

    local params=(
        "/opencode/${ENVIRONMENT}/oidc/issuer"
        "/opencode/${ENVIRONMENT}/oidc/jwks-url"
        "/opencode/${ENVIRONMENT}/oidc/authorization-endpoint"
        "/opencode/${ENVIRONMENT}/oidc/token-endpoint"
        "/opencode/${ENVIRONMENT}/oidc/userinfo-endpoint"
        "/opencode/${ENVIRONMENT}/oidc/alb-client-id"
        "/opencode/${ENVIRONMENT}/oidc/cli-client-id"
    )

    local missing=0
    for param in "${params[@]}"; do
        if aws ssm get-parameter --name "$param" &> /dev/null; then
            log_success "  SSM: $param"
        else
            log_error "  Missing SSM: $param"
            missing=$((missing + 1))
        fi
    done

    if [ $missing -gt 0 ]; then
        log_error "$missing SSM parameter(s) missing. Deploy Auth stack first."
        return 1
    fi

    # Validate JWKS endpoint is reachable
    local jwks_url
    jwks_url=$(aws ssm get-parameter --name "/opencode/${ENVIRONMENT}/oidc/jwks-url" --query 'Parameter.Value' --output text 2>/dev/null) || true
    if [ -n "$jwks_url" ]; then
        if curl -sf "$jwks_url" > /dev/null 2>&1; then
            log_success "  JWKS endpoint reachable: $jwks_url"
        else
            log_warning "  JWKS endpoint not reachable: $jwks_url (may work after deployment)"
        fi
    fi

    log_success "Auth SSM parameters validated"
    return 0
}

# Run preflight checks without deploying
preflight() {
    log_info "======================================"
    log_info "Preflight Validation"
    log_info "======================================"

    check_prerequisites

    cd "$PROJECT_DIR"

    # Check Node.js version
    local node_version
    node_version=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
    if [ -n "$node_version" ] && [ "$node_version" -ge 18 ]; then
        log_success "Node.js ${node_version}+ installed"
    else
        log_error "Node.js 18+ required (found: $(node -v 2>/dev/null || echo 'not installed'))"
        return 1
    fi

    # Check npm dependencies
    if [ -d "node_modules" ]; then
        log_success "npm dependencies installed"
    else
        log_info "Installing npm dependencies..."
        npm install
        log_success "npm dependencies installed"
    fi

    # Check CDK build
    log_info "Checking CDK build..."
    if npm run build > /dev/null 2>&1; then
        log_success "CDK builds successfully"
    else
        log_error "CDK build failed. Run 'npm run build' for details."
        return 1
    fi

    # Check existing SSM params (informational)
    log_info "Checking existing SSM parameters (informational)..."
    if validate_auth_ssm_params 2>/dev/null; then
        log_success "Auth SSM parameters exist"
    else
        log_warning "Auth SSM parameters not found (will be created during auth deploy)"
    fi

    # Check secrets manager
    if check_secrets_manager_secret 2>/dev/null; then
        log_success "Secrets Manager secret exists"
    else
        log_warning "OIDC ALB client secret not found (will be auto-created after auth deploy)"
    fi

    log_success "======================================"
    log_success "Preflight checks complete"
    log_success "======================================"
}

# ─── Stack Deployment ─────────────────────────────────────

# Deploy a single stack
deploy_stack() {
    local stack_name=$1
    local stack_id=$2

    log_info "Deploying $stack_name..."

    # shellcheck disable=SC2086
    if npx cdk deploy "$stack_id" --require-approval never $CDK_CONTEXT_FLAGS; then
        log_success "$stack_name deployed successfully"
        return 0
    else
        log_error "Failed to deploy $stack_name"
        return 1
    fi
}

# network — VPC, subnets, NAT Gateway, ACM certificate
deploy_network() {
    log_info "======================================"
    log_info "Deploying Network + Certificate"
    log_info "======================================"

    deploy_stack "Network Stack" "OpenCodeNetwork-${ENVIRONMENT}"
    deploy_stack "Certificate Stack" "OpenCodeCertificate-${ENVIRONMENT}"
}

# auth — OIDC authentication (Cognito or external provider)
deploy_auth() {
    log_info "======================================"
    log_info "Deploying Auth (OIDC Configuration)"
    log_info "======================================"

    # Validate IdP credentials if idpName is configured in cdk.json
    local idp_name
    idp_name=$(cd "$PROJECT_DIR" && node -e "const c=require('./cdk.json').context; console.log(c.idpName||'')" 2>/dev/null) || true
    if [ -n "$idp_name" ]; then
        if [ -z "$IDP_CLIENT_ID" ] || [ -z "$IDP_CLIENT_SECRET" ]; then
            log_error "cdk.json has idpName='$idp_name' but IDP_CLIENT_ID and/or IDP_CLIENT_SECRET env vars are not set."
            log_error "IdP federation will NOT be configured without these credentials."
            log_error ""
            log_error "Deploy with:"
            log_error "  IDP_CLIENT_ID=<client-id> IDP_CLIENT_SECRET=<client-secret> ./scripts/deploy.sh"
            exit 1
        fi
        log_info "IdP federation: $idp_name (credentials provided)"
    fi

    deploy_stack "Auth Stack" "OpenCodeAuth-${ENVIRONMENT}"

    # Validate SSM outputs
    validate_auth_ssm_params

    # Auto-create ALB client secret in Secrets Manager
    ensure_alb_client_secret
}

# api — ECS Fargate service, JWT ALB, listener rules
deploy_api() {
    log_info "======================================"
    log_info "Deploying API (ECS + JWT ALB)"
    log_info "======================================"

    deploy_stack "API Stack" "OpenCodeApi-${ENVIRONMENT}"
}

# distribution — Landing page Lambda, S3 assets, OIDC ALB for browser auth
deploy_distribution() {
    log_info "======================================"
    log_info "Deploying Distribution (Landing Page + OIDC ALB)"
    log_info "======================================"

    # Verify secret exists before deploying
    if ! check_secrets_manager_secret; then
        log_error "Cannot deploy Distribution without OIDC ALB client secret."
        log_error "Run './scripts/deploy.sh auth' first, or create the secret manually."
        exit 1
    fi

    deploy_stack "Distribution Stack" "OpenCodeDistribution-${ENVIRONMENT}"
}

# ─── Router Image ─────────────────────────────────────────

# Build and push router container image
build_router_image() {
    log_info "======================================"
    log_info "Building Router Container Image"
    log_info "======================================"

    if [ -z "$CONTAINER_BUILDER" ]; then
        log_warning "No container builder available (docker or finch), skipping image build"
        log_info "Install Docker: https://docs.docker.com/get-docker/"
        log_info "Or set CONTAINER_BUILDER=finch to use Finch"
        return 0
    fi

    cd "$PROJECT_DIR/services/router"

    # Get ECR repository URI from SSM
    local ecr_uri
    ecr_uri=$(aws ssm get-parameter --name "/opencode/${ENVIRONMENT}/ecr/repository-uri" --query 'Parameter.Value' --output text 2>/dev/null) || true

    if [ -z "$ecr_uri" ]; then
        log_warning "ECR repository not found in SSM. Skipping image push."
        log_info "To push manually after ECR is created:"
        log_info "  1. cd services/router"
        log_info "  2. $CONTAINER_BUILDER build -t bedrock-router ."
        log_info "  3. aws ecr get-login-password | $CONTAINER_BUILDER login --username AWS --password-stdin <account>.dkr.ecr.${AWS_REGION}.amazonaws.com"
        log_info "  4. $CONTAINER_BUILDER tag bedrock-router:latest <ecr-uri>:latest"
        log_info "  5. $CONTAINER_BUILDER push <ecr-uri>:latest"
        return 0
    fi

    log_info "Building container image with $CONTAINER_BUILDER (linux/amd64)..."
    $CONTAINER_BUILDER build --platform linux/amd64 -t bedrock-router .

    log_info "Logging into ECR..."
    aws ecr get-login-password --region "$AWS_REGION" | $CONTAINER_BUILDER login --username AWS --password-stdin "${ecr_uri%%/*}"

    log_info "Tagging and pushing image..."
    $CONTAINER_BUILDER tag bedrock-router:latest "${ecr_uri}:latest"
    $CONTAINER_BUILDER push "${ecr_uri}:latest"

    log_success "Router image built and pushed successfully with $CONTAINER_BUILDER"

    cd "$PROJECT_DIR"
}

# Force ECS service redeployment
force_ecs_redeployment() {
    log_info "======================================"
    log_info "Forcing ECS Service Redeployment"
    log_info "======================================"

    local cluster_name
    local service_name

    cluster_name=$(aws ssm get-parameter --name "/opencode/${ENVIRONMENT}/ecs/cluster-name" --query 'Parameter.Value' --output text 2>/dev/null) || true
    service_name=$(aws ssm get-parameter --name "/opencode/${ENVIRONMENT}/ecs/router-service-name" --query 'Parameter.Value' --output text 2>/dev/null) || true

    if [ -n "$cluster_name" ] && [ -n "$service_name" ]; then
        log_info "Forcing new deployment for service: $service_name"
        aws ecs update-service --cluster "$cluster_name" --service "$service_name" --force-new-deployment
        log_success "ECS service redeployment initiated"
    else
        log_warning "ECS cluster or service not found in SSM"
    fi
}

# ─── Distribution Assets ─────────────────────────────────

# Publish distribution assets to S3 using the existing publish script
publish_distribution_assets() {
    log_info "======================================"
    log_info "Publishing Distribution Assets to S3"
    log_info "======================================"

    "$SCRIPT_DIR/publish-distribution.sh" --profile "${AWS_PROFILE:-default}" --region "$AWS_REGION"
}

# ─── Full Deployment ──────────────────────────────────────

# Deploy everything
deploy_all() {
    log_info "Starting full deployment for environment: $ENVIRONMENT"
    log_info "AWS Region: $AWS_REGION"

    check_prerequisites

    cd "$PROJECT_DIR"

    # Build CDK
    log_info "Building CDK..."
    npm run build

    # Bootstrap CDK if needed
    log_info "Checking CDK bootstrap..."
    npx cdk bootstrap "aws://$(aws sts get-caller-identity --query 'Account' --output text)/${AWS_REGION}" || true

    # Step 1: Network (VPC + Certificate)
    deploy_network

    # Step 2: Auth (OIDC config + auto-create ALB secret)
    deploy_auth

    # Step 3: Build and push router image before ECS starts (if ECR repo exists)
    # On subsequent deploys the ECR repo already exists, so we push first to avoid
    # CannotPullContainerError when ECS tasks start during the API stack deploy.
    local ecr_preexisted=false
    if aws ssm get-parameter --name "/opencode/${ENVIRONMENT}/ecr/repository-uri" &>/dev/null; then
        ecr_preexisted=true
        build_router_image
    fi

    # Step 4: API (ECS + JWT ALB) — creates ECR repo + ECS service
    deploy_api

    # Step 5: On first deploy, ECR repo was just created — push image now
    if [ "$ecr_preexisted" = false ]; then
        build_router_image
        force_ecs_redeployment
    fi

    # Step 6: Publish distribution assets to S3 (if available)
    if [ -f "$PROJECT_DIR/services/distribution/assets/install.sh" ]; then
        local publish_assets="n"
        read -r -p "$(echo -e "${YELLOW}[PROMPT]${NC} Publish distribution assets to S3? (y/N): ")" publish_assets
        if [[ "$publish_assets" =~ ^[Yy]$ ]]; then
            publish_distribution_assets
        else
            log_info "Skipping distribution asset publish"
        fi
    fi

    # Step 7: Distribution (Landing page + OIDC ALB)
    deploy_distribution

    log_success "======================================"
    log_success "Full deployment completed successfully!"
    log_success "======================================"

    # Print useful information
    print_deployment_info
}

# Print deployment information
print_deployment_info() {
    log_info ""
    log_info "Deployment Information:"
    log_info "======================"

    local api_dns
    local web_dns

    api_dns=$(aws ssm get-parameter --name "/opencode/${ENVIRONMENT}/api/dns-name" --query 'Parameter.Value' --output text 2>/dev/null) || true
    web_dns=$(aws ssm get-parameter --name "/opencode/${ENVIRONMENT}/web/dns-name" --query 'Parameter.Value' --output text 2>/dev/null) || true

    if [ -n "$api_dns" ]; then
        log_info "API Endpoint: https://$api_dns"
        log_info "Health Check: https://$api_dns/health"
    fi

    if [ -n "$web_dns" ]; then
        log_info "Web Endpoint: https://$web_dns"
    fi

    log_info ""
    log_info "Useful Commands:"
    log_info "  View CDK diff:        cdk diff"
    log_info "  Destroy all stacks:   cdk destroy --all"
    log_info "  View logs:            aws logs tail /ecs/bedrock-router-${ENVIRONMENT} --follow"
}

# ─── CLI ──────────────────────────────────────────────────

# Show usage
show_usage() {
    cat << EOF
OpenCode Stack Deployment Script

Usage: $0 [OPTIONS] [COMMAND]

Commands:
  all                 Deploy all stacks (default)
  network             Deploy Network + Certificate stacks
  auth                Deploy Auth stack (OIDC config + auto-create ALB secret)
  api                 Deploy API stack (ECS + JWT ALB)
  distribution        Deploy Distribution stack (Landing page + OIDC ALB)
  publish             Build and publish distribution assets to S3
  preflight           Run all validations without deploying
  build-image         Build and push router container image only
  redeploy            Force ECS service redeployment
  info                Show deployment information

Options:
  -e, --environment   Environment name (default: dev)
  -r, --region        AWS region (default: us-east-1)
  -c key=value        Pass CDK context flag (can be repeated, non-secret values only)
  -h, --help          Show this help message

Examples:
  $0                              # Deploy all stacks
  $0 network                      # Deploy Network + Certificate only
  $0 auth                         # Deploy Auth only (+ auto-create secret)
  $0 -e prod all                  # Deploy all stacks to production
  $0 preflight                    # Validate without deploying

  # Deploy with IdP federation (secrets via env vars):
  IDP_CLIENT_ID=xxx IDP_CLIENT_SECRET=yyy $0 -c idpName=YourIdP -c idpIssuer=https://your-idp-issuer.example.com

Environment Variables:
  ENVIRONMENT         Environment name (default: dev)
  AWS_REGION          AWS region (default: us-east-1)
  AWS_PROFILE         AWS profile to use
  IDP_CLIENT_ID       IdP client ID for Cognito federation (secret — do not pass via -c)
  IDP_CLIENT_SECRET   IdP client secret for Cognito federation (secret — do not pass via -c)

EOF
}

# Main function
main() {
    local command="all"

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -e|--environment)
                ENVIRONMENT="$2"
                shift 2
                ;;
            -r|--region)
                AWS_REGION="$2"
                shift 2
                ;;
            -c)
                CDK_CONTEXT_FLAGS="$CDK_CONTEXT_FLAGS -c $2"
                shift 2
                ;;
            -h|--help)
                show_usage
                exit 0
                ;;
            all|network|auth|api|distribution|publish|build-image|redeploy|info|preflight)
                command="$1"
                shift
                ;;
            *)
                log_error "Unknown option: $1"
                show_usage
                exit 1
                ;;
        esac
    done

    # Export for CDK
    export ENVIRONMENT
    export AWS_REGION
    export CDK_DEFAULT_REGION="$AWS_REGION"
    export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query 'Account' --output text)

    # Execute command
    case $command in
        all)
            deploy_all
            ;;
        network)
            check_prerequisites
            cd "$PROJECT_DIR"
            npm run build
            deploy_network
            ;;
        auth)
            check_prerequisites
            cd "$PROJECT_DIR"
            npm run build
            deploy_auth
            ;;
        api)
            check_prerequisites
            cd "$PROJECT_DIR"
            npm run build
            local ecr_preexisted=false
            if aws ssm get-parameter --name "/opencode/${ENVIRONMENT}/ecr/repository-uri" &>/dev/null; then
                ecr_preexisted=true
                build_router_image
            fi
            deploy_api
            if [ "$ecr_preexisted" = false ]; then
                build_router_image
            fi
            force_ecs_redeployment
            ;;
        distribution)
            check_prerequisites
            cd "$PROJECT_DIR"
            npm run build
            publish_distribution_assets
            deploy_distribution
            ;;
        publish)
            check_prerequisites
            publish_distribution_assets
            ;;
        build-image)
            check_prerequisites
            build_router_image
            force_ecs_redeployment
            ;;
        redeploy)
            force_ecs_redeployment
            ;;
        preflight)
            preflight
            ;;
        info)
            print_deployment_info
            ;;
        *)
            log_error "Unknown command: $command"
            show_usage
            exit 1
            ;;
    esac
}

main "$@"
