#!/bin/bash
# Publish opencode-auth distribution package to S3
# Usage: ./publish-distribution.sh [--profile PROFILE] [--version VERSION]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ASSETS_DIR="$PROJECT_ROOT/services/distribution/assets"
PROFILE="${AWS_PROFILE:-opencode}"
REGION="${AWS_REGION:-us-east-1}"
ENVIRONMENT="${ENVIRONMENT:-dev}"
VERSION="${VERSION:-dev}"
MINIMUM_VERSION=""
CONFIG_VERSION=""
CRITICAL="false"
MESSAGE=""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

print_error() { echo -e "${RED}Error: $1${NC}" >&2; }
print_success() { echo -e "${GREEN}$1${NC}"; }
print_warning() { echo -e "${YELLOW}$1${NC}"; }
print_info() { echo -e "${CYAN}$1${NC}"; }

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Package and upload opencode-auth distribution to S3.

Options:
    --profile PROFILE              AWS profile to use (default: opencode)
    --region REGION                AWS region (default: us-east-1)
    --environment ENV              Environment name (default: dev)
    --version VERSION              Version string (default: dev)
    --minimum-version VERSION      Minimum supported client version (for version enforcement)
    --config-version N             Config patch version number (integer)
    --critical                     Mark this release as critical (security fix)
    --message MESSAGE              Release message shown to users
    --help                         Show this help message

Examples:
    $(basename "$0") --profile opencode
    $(basename "$0") --profile opencode --version 1.0.0
    $(basename "$0") --version 1.1.0 --minimum-version 1.0.0 --critical --message "Security fix"
EOF
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --profile)
            PROFILE="$2"
            shift 2
            ;;
        --region)
            REGION="$2"
            shift 2
            ;;
        --environment)
            ENVIRONMENT="$2"
            shift 2
            ;;
        --version)
            VERSION="$2"
            shift 2
            ;;
        --minimum-version)
            MINIMUM_VERSION="$2"
            shift 2
            ;;
        --config-version)
            CONFIG_VERSION="$2"
            shift 2
            ;;
        --critical)
            CRITICAL="true"
            shift
            ;;
        --message)
            MESSAGE="$2"
            shift 2
            ;;
        --help)
            usage
            ;;
        *)
            print_error "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Check dependencies
check_dependencies() {
    local missing=()

    if ! command -v zip &> /dev/null; then
        missing+=("zip")
    fi

    if ! command -v aws &> /dev/null; then
        missing+=("aws-cli")
    fi

    if ! command -v go &> /dev/null; then
        missing+=("go")
    fi

    if [[ ${#missing[@]} -gt 0 ]]; then
        print_error "Missing required dependencies: ${missing[*]}"
        echo "Please install them and try again."
        exit 1
    fi
}

# Build opencode-auth binaries for all platforms
build_binaries() {
    print_info "Building opencode-auth binaries..."

    local go_dir="$PROJECT_ROOT/auth/opencode-auth"
    local ldflags="-s -w -X main.version=${VERSION}"

    local targets=(
        "darwin:amd64"
        "darwin:arm64"
        "linux:amd64"
        "windows:amd64"
    )

    for target in "${targets[@]}"; do
        local os_name="${target%%:*}"
        local arch="${target##*:}"
        local output="$ASSETS_DIR/opencode-auth-${os_name}-${arch}"
        [[ "$os_name" == "windows" ]] && output="${output}.exe"

        echo "  Building ${os_name}/${arch}..."
        (cd "$go_dir" && GOOS="$os_name" GOARCH="$arch" go build -ldflags "$ldflags" -o "$output" .)
    done

    # Generate checksums
    echo "  Generating checksums..."
    for binary in "$ASSETS_DIR"/opencode-auth-*; do
        [[ "$binary" == *.sha256 ]] && continue
        [[ ! -f "$binary" ]] && continue
        shasum -a 256 "$binary" | awk '{print $1}' > "${binary}.sha256"
    done

    print_success "Binaries built successfully"
}

echo ""
print_info "╔══════════════════════════════════════════════════════════════╗"
print_info "║          OpenCode Distribution Package Publisher             ║"
print_info "╚══════════════════════════════════════════════════════════════╝"
echo ""

check_dependencies

echo "Configuration:"
echo "  Profile: $PROFILE"
echo "  Region:  $REGION"
echo "  Version: $VERSION"
echo ""

# Step 0: Build binaries from source
build_binaries
echo ""

# Get S3 bucket name from CloudFormation
print_info "Fetching S3 bucket from CloudFormation..."
BUCKET=$(aws cloudformation describe-stacks \
    --stack-name "OpenCodeDistribution-${ENVIRONMENT}" \
    --region "$REGION" \
    --profile "$PROFILE" \
    --query 'Stacks[0].Outputs[?OutputKey==`AssetsBucketName`].OutputValue' \
    --output text 2>/dev/null)

if [[ -z "$BUCKET" ]] || [[ "$BUCKET" == "None" ]]; then
    print_error "Could not find distribution bucket."
    echo "Is OpenCodeDistribution-${ENVIRONMENT} deployed?"
    exit 1
fi
echo "  Bucket: $BUCKET"

# Get CLI Client ID from Auth stack
CLI_CLIENT_ID=$(aws cloudformation describe-stacks \
    --stack-name "OpenCodeAuth-${ENVIRONMENT}" \
    --region "$REGION" \
    --profile "$PROFILE" \
    --query 'Stacks[0].Outputs[?OutputKey==`CliClientId`].OutputValue' \
    --output text 2>/dev/null || echo "")

# Get OIDC Issuer from Auth stack
OIDC_ISSUER=$(aws cloudformation describe-stacks \
    --stack-name "OpenCodeAuth-${ENVIRONMENT}" \
    --region "$REGION" \
    --profile "$PROFILE" \
    --query 'Stacks[0].Outputs[?OutputKey==`OidcIssuer`].OutputValue' \
    --output text 2>/dev/null || echo "")

# Get API domain from API stack
API_DOMAIN=$(aws cloudformation describe-stacks \
    --stack-name "OpenCodeApi-${ENVIRONMENT}" \
    --region "$REGION" \
    --profile "$PROFILE" \
    --query 'Stacks[0].Outputs[?OutputKey==`ApiDomainName`].OutputValue' \
    --output text 2>/dev/null || echo "")

# Get distribution web domain from Distribution stack
WEB_DOMAIN=$(aws cloudformation describe-stacks \
    --stack-name "OpenCodeDistribution-${ENVIRONMENT}" \
    --region "$REGION" \
    --profile "$PROFILE" \
    --query 'Stacks[0].Outputs[?OutputKey==`WebDomainName`].OutputValue' \
    --output text 2>/dev/null || echo "")

if [[ -n "$CLI_CLIENT_ID" ]] && [[ "$CLI_CLIENT_ID" != "None" ]]; then
    echo "  CLI Client ID: $CLI_CLIENT_ID"
fi
if [[ -n "$API_DOMAIN" ]] && [[ "$API_DOMAIN" != "None" ]]; then
    echo "  API Domain: $API_DOMAIN"
fi
if [[ -n "$OIDC_ISSUER" ]] && [[ "$OIDC_ISSUER" != "None" ]]; then
    echo "  OIDC Issuer: $OIDC_ISSUER"
fi
if [[ -n "$WEB_DOMAIN" ]] && [[ "$WEB_DOMAIN" != "None" ]]; then
    echo "  Web Domain: $WEB_DOMAIN"
fi
echo ""

# Step 1: Create zip package
print_info "Step 1: Creating distribution package..."

PACKAGE_DIR=$(mktemp -d)
ZIP_NAME="opencode-installer.zip"
ZIP_PATH="$ASSETS_DIR/$ZIP_NAME"

# Copy binaries
echo "  Copying binaries..."
for binary in "$ASSETS_DIR"/opencode-auth-*; do
    # Skip checksum files
    [[ "$binary" == *.sha256 ]] && continue
    [[ -f "$binary" ]] && cp "$binary" "$PACKAGE_DIR/"
done

# Copy install.sh
echo "  Copying install.sh..."
cp "$ASSETS_DIR/install.sh" "$PACKAGE_DIR/"

# Copy config files and inject values
echo "  Copying config files..."
if [[ -n "$CLI_CLIENT_ID" ]] && [[ "$CLI_CLIENT_ID" != "None" ]] && [[ -n "$API_DOMAIN" ]] && [[ "$API_DOMAIN" != "None" ]]; then
    echo "  Injecting CLI Client ID, API Domain, and OIDC Issuer"
    sed -e "s|{{CLIENT_ID}}|$CLI_CLIENT_ID|g" -e "s|{{API_DOMAIN}}|$API_DOMAIN|g" -e "s|{{ISSUER}}|$OIDC_ISSUER|g" -e "s|{{WEB_DOMAIN}}|$WEB_DOMAIN|g" "$ASSETS_DIR/opencode-config.json" > "$PACKAGE_DIR/opencode-config.json"
else
    print_warning "Could not fetch values from CloudFormation, using template config"
    cp "$ASSETS_DIR/opencode-config.json" "$PACKAGE_DIR/"
fi

cp "$ASSETS_DIR/opencode.json" "$PACKAGE_DIR/"

# Create zip
echo "  Creating zip..."
rm -f "$ZIP_PATH"
(cd "$PACKAGE_DIR" && zip -r "$ZIP_PATH" .)

# Cleanup temp dir
rm -rf "$PACKAGE_DIR"

# Show package contents
echo ""
echo "  Package contents:"
unzip -l "$ZIP_PATH" | tail -n +4 | sed '$d' | sed '$d' | while read -r line; do
    echo "    $line"
done

ZIP_SIZE=$(du -h "$ZIP_PATH" | cut -f1)
echo ""
echo "  Created: $ZIP_PATH ($ZIP_SIZE)"
echo ""

# Step 2: Upload to S3
print_info "Step 2: Uploading to S3..."

# Create downloads prefix if needed
echo "  Uploading $ZIP_NAME..."
aws s3 cp "$ZIP_PATH" "s3://$BUCKET/downloads/$ZIP_NAME" \
    --profile "$PROFILE" \
    --region "$REGION" \
    --content-type "application/zip"

# Upload individual binaries (for direct download from landing page)
echo "  Uploading individual binaries..."
for binary in "$ASSETS_DIR"/opencode-auth-*; do
    # Skip checksum files
    [[ "$binary" == *.sha256 ]] && continue
    [[ ! -f "$binary" ]] && continue

    filename=$(basename "$binary")
    echo "    $filename"
    aws s3 cp "$binary" "s3://$BUCKET/downloads/$filename" \
        --profile "$PROFILE" \
        --region "$REGION" \
        --content-type "application/octet-stream"
done

# Step 3: Generate and upload config-patch.json from opencode.json
print_info "Step 3: Generating config-patch.json from opencode.json..."

# Determine config_version: use --config-version if set, otherwise read from
# existing config-patch.json on S3 and auto-increment
EXISTING_PATCH=$(aws s3 cp "s3://$BUCKET/downloads/config-patch.json" - \
    --profile "$PROFILE" \
    --region "$REGION" 2>/dev/null || echo "")

if [[ -z "$CONFIG_VERSION" ]]; then
    if [[ -n "$EXISTING_PATCH" ]]; then
        PREV_CONFIG_VERSION=$(echo "$EXISTING_PATCH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('config_version',0))" 2>/dev/null || echo "0")
    else
        PREV_CONFIG_VERSION="0"
    fi
    CONFIG_VERSION=$((PREV_CONFIG_VERSION + 1))
    echo "  Auto-incremented config_version: $PREV_CONFIG_VERSION -> $CONFIG_VERSION"
fi

# Build config-patch.json from opencode.json
# This converts each model entry into a set_deep operation, and also patches
# config.json with version_check_url for existing installs that lack it.
CONFIG_PATCH_JSON=$(python3 -c "
import json, sys

# Read the distribution opencode.json
with open('$ASSETS_DIR/opencode.json') as f:
    oc = json.load(f)

# Build set_deep entries from opencode.json model definitions
set_deep = {}
provider = oc.get('provider', {})
for provider_name, provider_config in provider.items():
    models = provider_config.get('models', {})
    for model_name, model_def in models.items():
        set_deep[f'provider.{provider_name}.models.{model_name}'] = model_def
    # Also set provider options (e.g. baseURL)
    options = provider_config.get('options')
    if options:
        set_deep[f'provider.{provider_name}.options'] = options

# Build the config patch
patch = {
    'config_version': int('$CONFIG_VERSION'),
    'patches': {
        'config.json': {
            'set': {}
        },
        'opencode.json': {
            'set_deep': set_deep
        }
    }
}

# Add config.json patches for version_check_url and connection params
config_set = patch['patches']['config.json']['set']
if '$CLI_CLIENT_ID' and '$CLI_CLIENT_ID' != 'None':
    config_set['client_id'] = '$CLI_CLIENT_ID'
if '$API_DOMAIN' and '$API_DOMAIN' != 'None':
    config_set['api_endpoint'] = 'https://$API_DOMAIN/v1'
if '$OIDC_ISSUER' and '$OIDC_ISSUER' != 'None':
    config_set['issuer'] = '$OIDC_ISSUER'
if '$WEB_DOMAIN' and '$WEB_DOMAIN' != 'None':
    config_set['version_check_url'] = 'https://$WEB_DOMAIN/version.json'

print(json.dumps(patch, indent=2))
")

echo "$CONFIG_PATCH_JSON" | aws s3 cp - "s3://$BUCKET/downloads/config-patch.json" \
    --profile "$PROFILE" \
    --region "$REGION" \
    --content-type "application/json"

MODEL_COUNT=$(echo "$CONFIG_PATCH_JSON" | python3 -c "import sys,json; p=json.load(sys.stdin); print(len([k for k in p['patches']['opencode.json']['set_deep'] if k.startswith('provider.') and '.models.' in k]))" 2>/dev/null || echo "?")
echo "  config-patch.json uploaded (config_version: $CONFIG_VERSION, models: $MODEL_COUNT)"
echo ""

# Step 4: Generate and upload version.json manifest
print_info "Step 4: Publishing version manifest..."

if [[ "$VERSION" != "dev" ]]; then
    # Determine minimum version: use --minimum-version if set, otherwise try to read
    # the current minimum from existing version.json on S3
    if [[ -z "$MINIMUM_VERSION" ]]; then
        EXISTING_MANIFEST=$(aws s3 cp "s3://$BUCKET/downloads/version.json" - \
            --profile "$PROFILE" \
            --region "$REGION" 2>/dev/null || echo "")
        if [[ -n "$EXISTING_MANIFEST" ]]; then
            MINIMUM_VERSION=$(echo "$EXISTING_MANIFEST" | python3 -c "import sys,json; print(json.load(sys.stdin).get('minimum',''))" 2>/dev/null || echo "")
        fi
        if [[ -z "$MINIMUM_VERSION" ]]; then
            MINIMUM_VERSION="$VERSION"
        fi
    fi

    # CONFIG_VERSION is already determined in Step 3 (config-patch generation)

    RELEASE_DATE=$(date -u +%Y-%m-%d)

    # Derive download URL from distribution web domain
    DOWNLOAD_URL=""
    if [[ -n "$WEB_DOMAIN" ]] && [[ "$WEB_DOMAIN" != "None" ]]; then
        DOWNLOAD_URL="https://${WEB_DOMAIN}"
    fi

    # Generate version.json
    VERSION_JSON=$(python3 -c "
import json
manifest = {
    'latest': '${VERSION}',
    'minimum': '${MINIMUM_VERSION}',
    'config_version': int('${CONFIG_VERSION}'),
    'released': '${RELEASE_DATE}',
    'download_url': '${DOWNLOAD_URL}',
    'changelog_url': '',
    'critical': $( [ "${CRITICAL}" = "true" ] && echo "True" || echo "False" ),
    'message': '${MESSAGE}'
}
print(json.dumps(manifest, indent=2))
")

    echo "$VERSION_JSON" | aws s3 cp - "s3://$BUCKET/downloads/version.json" \
        --profile "$PROFILE" \
        --region "$REGION" \
        --content-type "application/json" \
        --cache-control "max-age=300"

    echo "  Version manifest uploaded:"
    echo "    latest:         $VERSION"
    echo "    minimum:        $MINIMUM_VERSION"
    echo "    config_version: $CONFIG_VERSION"
    echo "    critical:       $CRITICAL"
    if [[ -n "$MESSAGE" ]]; then
        echo "    message:        $MESSAGE"
    fi
else
    # Even for dev, update config_version in existing version.json so config patches get picked up
    EXISTING_MANIFEST=$(aws s3 cp "s3://$BUCKET/downloads/version.json" - \
        --profile "$PROFILE" \
        --region "$REGION" 2>/dev/null || echo "")
    if [[ -n "$EXISTING_MANIFEST" ]]; then
        UPDATED_MANIFEST=$(echo "$EXISTING_MANIFEST" | python3 -c "
import sys, json
m = json.load(sys.stdin)
m['config_version'] = int('$CONFIG_VERSION')
print(json.dumps(m, indent=2))
")
        echo "$UPDATED_MANIFEST" | aws s3 cp - "s3://$BUCKET/downloads/version.json" \
            --profile "$PROFILE" \
            --region "$REGION" \
            --content-type "application/json" \
            --cache-control "max-age=300"
        echo "  Updated config_version in version.json to $CONFIG_VERSION (version remains unchanged)"
    else
        print_warning "  Skipping version.json update (no existing manifest found)"
    fi
fi

echo ""
print_success "═══════════════════════════════════════════════════════════════"
print_success "                    Publication Complete!                       "
print_success "═══════════════════════════════════════════════════════════════"
echo ""
if [[ -n "$WEB_DOMAIN" ]] && [[ "$WEB_DOMAIN" != "None" ]]; then
    echo "Downloads available at:"
    echo "  https://${WEB_DOMAIN}"
fi
echo ""
echo "Quick start:"
echo "  1. Download and extract the installer zip"
echo "  2. Run: ./install.sh (Mac/Linux)"
echo "  3. Restart your shell"
echo "  4. Run: oc"
echo ""
