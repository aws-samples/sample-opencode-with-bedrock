#!/bin/bash
# OpenCode Auth Installer for Mac/Linux
# Run from the extracted zip directory: ./install.sh

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_error() { echo -e "${RED}Error: $1${NC}" >&2; }
print_success() { echo -e "${GREEN}$1${NC}"; }
print_warning() { echo -e "${YELLOW}$1${NC}"; }

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Platform detection
detect_platform() {
    local os arch

    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    arch=$(uname -m)

    case "$arch" in
        x86_64) arch="amd64" ;;
        arm64|aarch64) arch="arm64" ;;
        *)
            print_error "Unsupported architecture: $arch"
            exit 1
            ;;
    esac

    case "$os" in
        darwin|linux) ;;
        *)
            print_error "Unsupported operating system: $os"
            exit 1
            ;;
    esac

    echo "${os}-${arch}"
}

PLATFORM=$(detect_platform)
CONFIG_DIR="$HOME/.opencode"
INSTALL_DIR="${INSTALL_DIR:-$HOME/bin}"

MACOS_ISSUES=()

echo "Installing opencode-auth for $PLATFORM..."
echo ""

# Check that required files exist
BINARY_NAME="opencode-auth-$PLATFORM"
if [[ ! -f "$SCRIPT_DIR/$BINARY_NAME" ]]; then
    print_error "Binary not found: $SCRIPT_DIR/$BINARY_NAME"
    print_error "Make sure you're running this from the extracted zip directory."
    exit 1
fi

if [[ ! -f "$SCRIPT_DIR/opencode-config.json" ]]; then
    print_error "Config not found: $SCRIPT_DIR/opencode-config.json"
    exit 1
fi

if [[ ! -f "$SCRIPT_DIR/opencode.json" ]]; then
    print_error "OpenCode config not found: $SCRIPT_DIR/opencode.json"
    exit 1
fi

# macOS: Strip quarantine from extracted source files BEFORE copying.
# Browser downloads add com.apple.quarantine which propagates on copy.
if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "Clearing macOS quarantine from downloaded files..."
    if command -v xattr >/dev/null 2>&1; then
        xattr -cr "$SCRIPT_DIR" 2>/dev/null || true
    fi
fi

# Create directories
mkdir -p "$INSTALL_DIR"
mkdir -p "$CONFIG_DIR"

# Stop any running proxy before installing new binary
if command -v opencode-auth >/dev/null 2>&1; then
    echo "Stopping existing proxy..."
    opencode-auth proxy stop 2>/dev/null || true
fi

# Install binary
echo "Installing binary..."
cp "$SCRIPT_DIR/$BINARY_NAME" "$INSTALL_DIR/opencode-auth"
chmod 755 "$INSTALL_DIR/opencode-auth"

# macOS: Full Gatekeeper clearance for installed binary
if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "Configuring macOS security..."

    # Step 1: Remove quarantine from installed binary
    if command -v xattr >/dev/null 2>&1; then
        xattr -cr "$INSTALL_DIR/opencode-auth" 2>/dev/null || true
        # Verify quarantine is actually gone
        if xattr -l "$INSTALL_DIR/opencode-auth" 2>/dev/null | grep -q "com.apple.quarantine"; then
            # Targeted removal as fallback
            xattr -d com.apple.quarantine "$INSTALL_DIR/opencode-auth" 2>/dev/null || true
            if xattr -l "$INSTALL_DIR/opencode-auth" 2>/dev/null | grep -q "com.apple.quarantine"; then
                MACOS_ISSUES+=("quarantine attribute could not be removed")
            fi
        fi
    fi

    # Step 2: Ad-hoc code sign (creates a local signature that satisfies Gatekeeper)
    if command -v codesign >/dev/null 2>&1; then
        SIGN_OUTPUT=$(codesign -s - -f "$INSTALL_DIR/opencode-auth" 2>&1) || true
        # Verify signature
        if codesign --verify "$INSTALL_DIR/opencode-auth" 2>/dev/null; then
            print_success "  ✓ Binary signed"
        else
            MACOS_ISSUES+=("code signing failed: $SIGN_OUTPUT")
        fi
    else
        MACOS_ISSUES+=("codesign not found")
    fi

    # Step 3: Verify the binary can actually execute (catches cached Gatekeeper rejections)
    if EXEC_OUTPUT=$("$INSTALL_DIR/opencode-auth" help 2>&1); then
        print_success "  ✓ Binary passed Gatekeeper check"
    elif echo "$EXEC_OUTPUT" | grep -qi "killed\|not allowed\|cannot be opened\|malicious software"; then
        MACOS_ISSUES+=("Gatekeeper is blocking execution")
    else
        # Binary ran but returned non-zero (e.g., no subcommand) — that's fine, it executed
        print_success "  ✓ Binary passed Gatekeeper check"
    fi

    # Report issues and provide fix commands
    if [[ ${#MACOS_ISSUES[@]} -gt 0 ]]; then
        echo ""
        print_warning "macOS security issues detected:"
        for issue in "${MACOS_ISSUES[@]}"; do
            print_warning "  - $issue"
        done
        echo ""
        echo "  To fix, try ONE of these (in order of preference):"
        echo ""
        echo "    1. System Settings → Privacy & Security → click 'Allow Anyway'"
        echo ""
        echo "    2. Remove quarantine and re-sign manually:"
        echo "         sudo xattr -rd com.apple.quarantine $INSTALL_DIR/opencode-auth"
        echo "         codesign -s - -f $INSTALL_DIR/opencode-auth"
        echo ""
    fi
fi

# Install configs with secure permissions
echo "Installing configs..."
cp "$SCRIPT_DIR/opencode-config.json" "$CONFIG_DIR/config.json"
cp "$SCRIPT_DIR/opencode.json" "$CONFIG_DIR/opencode.json"
chmod 600 "$CONFIG_DIR/config.json"
chmod 600 "$CONFIG_DIR/opencode.json"

# Detect shell and profile file
detect_shell_profile() {
    local shell_name profile

    shell_name=$(basename "${SHELL:-/bin/bash}")

    case "$shell_name" in
        zsh)
            profile="$HOME/.zshrc"
            ;;
        bash)
            # Check for .bash_profile on macOS, .bashrc on Linux
            if [[ "$(uname -s)" == "Darwin" ]]; then
                if [[ -f "$HOME/.bash_profile" ]]; then
                    profile="$HOME/.bash_profile"
                else
                    profile="$HOME/.bashrc"
                fi
            else
                profile="$HOME/.bashrc"
            fi
            ;;
        fish)
            profile="$HOME/.config/fish/config.fish"
            ;;
        *)
            profile="$HOME/.profile"
            ;;
    esac

    echo "$profile"
}

PROFILE=$(detect_shell_profile)

# Install fish shell function
install_fish_function() {
    local fish_dir="$HOME/.config/fish/functions"
    mkdir -p "$fish_dir"
    cat > "$fish_dir/oc.fish" << 'FISH_FUNC'
function oc
    opencode-auth run -- $argv
end
FISH_FUNC
    print_success "Created fish function: $fish_dir/oc.fish"
}

# Check for existing oc command (OpenShift CLI conflict)
check_oc_conflict() {
    if command -v oc >/dev/null 2>&1; then
        local oc_path
        oc_path=$(command -v oc)
        if [[ "$oc_path" != "$INSTALL_DIR/oc" ]]; then
            print_warning "⚠ Existing 'oc' command detected: $oc_path"
            print_warning "  This may conflict with OpenShift CLI (oc)"
            print_warning "  The new 'oc' wrapper will be installed at: $INSTALL_DIR/oc"
            print_warning "  Ensure $INSTALL_DIR comes first in your PATH"
            echo ""
        fi
    fi
}

# Verify installation
verify_installation() {
    echo ""
    echo "Verifying installation..."
    
    # Check if oc is in PATH
    if command -v oc >/dev/null 2>&1; then
        print_success "✓ 'oc' command found in PATH"
    else
        print_warning "⚠ 'oc' command not found in PATH"
        print_warning "  You may need to restart your shell or run: source $PROFILE"
    fi
    
    # Check if opencode-auth is installed
    if command -v opencode-auth >/dev/null 2>&1; then
        print_success "✓ opencode-auth binary found"
    else
        print_error "✗ opencode-auth binary not found"
    fi
    
    # Check if vanilla opencode is available
    if command -v opencode >/dev/null 2>&1; then
        print_success "✓ 'opencode' command available for vanilla mode"
    else
        print_warning "⚠ 'opencode' command not found (install opencode for vanilla mode)"
    fi
}

# Ensure install dir is in PATH
ensure_path() {
    if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
        echo "" >> "$PROFILE"
        echo "# Added by opencode-auth installer" >> "$PROFILE"
        echo 'export PATH="$HOME/bin:$PATH"' >> "$PROFILE"
        print_warning "Added $INSTALL_DIR to PATH in $PROFILE"
    fi
}

# Create wrapper script (more reliable than alias - works even when opencode binary exists)
create_oc_wrapper() {
    local wrapper_path="$INSTALL_DIR/oc"

    echo "Creating wrapper script..."
    cat > "$wrapper_path" << WRAPPER
#!/bin/bash
# OpenCode wrapper with automatic authentication
# Generated by opencode-auth installer

# Prevent infinite recursion - if already running through wrapper, exec real opencode
if [[ -n "\$OPENCODE_AUTH_WRAPPER" ]]; then
    # Find opencode in PATH, excluding this wrapper
    for dir in \${PATH//:/ }; do
        if [[ "\$dir" != "$INSTALL_DIR" ]] && [[ -x "\$dir/opencode" ]]; then
            exec "\$dir/opencode" "\$@"
        fi
    done
    echo "Error: Could not find opencode binary. Please install opencode first." >&2
    exit 1
fi

export OPENCODE_AUTH_WRAPPER=1
exec opencode-auth run -- "\$@"
WRAPPER
    chmod +x "$wrapper_path"
}

# Check for conflicts
check_oc_conflict

# Install fish function if using fish shell
if [[ "$(basename "${SHELL:-/bin/bash}")" == "fish" ]]; then
    install_fish_function
fi

ensure_path
create_oc_wrapper

# Verify installation
verify_installation

echo ""
print_success "Installation complete!"
echo ""
echo "Installed:"
echo "  Binary:  $INSTALL_DIR/opencode-auth"
echo "  Wrapper: $INSTALL_DIR/oc"
echo "  Config:  $CONFIG_DIR/config.json"
echo "  Config:  $CONFIG_DIR/opencode.json"
echo ""
echo "Usage:"
echo "  oc                          - Launch authenticated opencode (recommended)"
echo "  opencode                    - Launch vanilla opencode (no auth)"
echo "  opencode-auth proxy status  - Check authentication proxy status"
echo "  opencode-auth proxy stop    - Stop the authentication proxy"
echo ""
echo "How it works:"
echo "  The 'oc' command automatically starts a local proxy server that:"
echo "  - Handles authentication for all API requests"
echo "  - Refreshes tokens automatically before they expire"
echo "  - Enables seamless long-running sessions without 401 errors"
echo ""
echo "Restart your shell or run:"
echo "  source $PROFILE"
echo ""
echo "The first time you run 'oc', it will open your browser to authenticate."

# macOS: security note only if issues were detected earlier
if [[ "$(uname -s)" == "Darwin" ]] && [[ ${#MACOS_ISSUES[@]} -gt 0 ]]; then
    echo ""
    print_warning "macOS: If 'oc' is blocked, see the fix commands above."
fi
