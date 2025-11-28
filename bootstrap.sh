#!/bin/bash
#
# Bootstrap script for ansible-pull deployment
# This script installs prerequisites needed to run ansible-pull
# Suitable for EC2 user-data or manual execution on fresh Ubuntu 24.04 instances
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Sovereign-Labs/rollup-starter-ansible/main/bootstrap.sh | bash

set -euo pipefail

# Configuration
LOG_FILE="/var/log/sovereign-bootstrap.log"
ANSIBLE_VERSION="2.16"

# Logging function
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

log "=========================================="
log "Sovereign Rollup Bootstrap - Starting"
log "=========================================="

# Check if running as root or with sudo
if [[ $EUID -ne 0 ]]; then
   log "ERROR: This script must be run as root or with sudo"
   exit 1
fi

# Detect Ubuntu version
if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    log "Detected OS: $NAME $VERSION"
    if [[ "$ID" != "ubuntu" ]]; then
        log "WARNING: This script is tested on Ubuntu 24.04. Your OS: $ID"
    fi
else
    log "ERROR: Cannot detect OS version"
    exit 1
fi

# Update package lists
log "Updating package lists..."
apt-get update -qq

# Install software-properties-common (for add-apt-repository)
log "Installing software-properties-common..."
apt-get install -y -qq software-properties-common

# Add Ansible PPA (for latest stable version)
log "Adding Ansible PPA..."
add-apt-repository --yes --update ppa:ansible/ansible

# Install required packages
log "Installing required packages..."
apt-get install -y -qq \
    ansible \
    git \
    python3 \
    python3-pip \
    ca-certificates \
    curl \
    gnupg \
    lsb-release

# Verify installations
log "Verifying installations..."
if command -v ansible-pull >/dev/null 2>&1; then
    ANSIBLE_VER=$(ansible --version | head -n1)
    log "✓ Ansible installed: $ANSIBLE_VER"
else
    log "ERROR: ansible-pull not found after installation"
    exit 1
fi

if command -v git >/dev/null 2>&1; then
    GIT_VER=$(git --version)
    log "✓ Git installed: $GIT_VER"
else
    log "ERROR: git not found after installation"
    exit 1
fi

# Verify Python3
if command -v python3 >/dev/null 2>&1; then
    PYTHON_VER=$(python3 --version)
    log "✓ Python3 installed: $PYTHON_VER"
else
    log "ERROR: python3 not found after installation"
    exit 1
fi

# Create working directory for ansible-pull
log "Creating ansible-pull working directory..."
mkdir -p /var/lib/ansible-pull
chmod 755 /var/lib/ansible-pull

log "=========================================="
log "Bootstrap completed successfully!"
log "=========================================="
log ""
log "Next steps:"
log ""
log "1. Create runtime_vars.yaml with your configuration"
log "   Option A - Download template:"
log "     curl -fsSL https://raw.githubusercontent.com/Sovereign-Labs/rollup-starter-ansible/main/vars/runtime_vars.yaml.template -o /tmp/runtime_vars.yaml"
log "     vim /tmp/runtime_vars.yaml"
log ""
log "   Option B - Create minimal config:"
log "     cat > /tmp/runtime_vars.yaml << 'EOF'"
log "     ---"
log "     data_availability_role: \"mock_da\""
log "     switches: \"cr\""
log "     zkvm_role: \"mock_zkvm\""
log "     debug: true"
log "     rollup_commit_hash: \"770a88a25576640b1e76b9385bf61b05452d60dd\""
log "     da_start_height: 1"
log "     EOF"
log ""
log "2. Run ansible-pull to deploy the rollup:"
log "     ansible-pull -U https://github.com/Sovereign-Labs/rollup-starter-ansible.git \\"
log "       -C main \\"
log "       -i inventory/localhost.ini \\"
log "       -e @/tmp/runtime_vars.yaml \\"
log "       local.yml"
log ""
log "Full documentation: https://github.com/Sovereign-Labs/rollup-starter-ansible/blob/main/ANSIBLE_PULL.md"
log "Bootstrap log saved to: $LOG_FILE"

exit 0
