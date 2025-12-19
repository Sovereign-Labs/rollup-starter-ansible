# Ansible-Pull Deployment Guide

This guide explains how to deploy the Sovereign rollup using `ansible-pull` for automated EC2 instance configuration without SSH access.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Files for ansible-pull](#files-for-ansible-pull)
- [CDK Integration](#cdk-integration)
- [Required Variables](#required-variables)
- [Testing Locally](#testing-locally)
- [Troubleshooting](#troubleshooting)

## Overview

**ansible-pull** inverts the normal Ansible workflow. 
Instead of pushing from a control machine via SSH, the target machine pulls the playbook from a Git repository and runs it locally.

### Benefits for EC2 Deployment

- ✅ No SSH access required
- ✅ Works perfectly with EC2 user-data / cloud-init
- ✅ Machines self-configure on first boot
- ✅ Still portable for Hetzner, bare metal (can use push or pull)
- ✅ Version controlled configuration

### Trade-offs

- Requires Git repository access from target machine
- Machine needs internet access during provisioning
- All variables must be injected at runtime

## Quick Start

### 1. Bootstrap Prerequisites (one-time)

On the target machine (Ubuntu 24.04):

```bash
curl -fsSL https://raw.githubusercontent.com/Sovereign-Labs/rollup-starter-ansible/main/bootstrap.sh | sudo bash
```

This installs ansible, git, python3, and creates the working directory `/var/lib/ansible-pull`.

### 2. Create Runtime Variables

Since `ansible-pull` clones the repository during execution (not before), you need to create your `runtime_vars.yaml` file manually in a known location.

**Option A: Download the template from GitHub**

```bash
# Download the template
curl -fsSL https://raw.githubusercontent.com/Sovereign-Labs/rollup-starter-ansible/main/vars/runtime_vars.yaml.template -o /tmp/runtime_vars.yaml

# Edit with your configuration
vim /tmp/runtime_vars.yaml
```

**Option B: Create minimal configuration manually**

```bash
# Create minimal runtime_vars.yaml for mock DA deployment
cat > /tmp/runtime_vars.yaml << 'EOF'
---
# Minimal configuration for testing
data_availability_role: "mock_da"
switches: "cr"
zkvm_role: "mock_zkvm"
debug: true
rollup_commit_hash: "770a88a25576640b1e76b9385bf61b05452d60dd"
da_start_height: 1

# Monitoring tokens (set values here, or leave empty to skip monitoring)
influxdb_token: "your-influxdb-token"
grafana_loki_token: "your-loki-token"
grafana_tempo_token: "your-tempo-token"
EOF
```

### 3. Run ansible-pull

Now run ansible-pull, which will:
1. Clone the repository to a temporary location
2. Read your runtime_vars.yaml
3. Execute the deployment

```bash
sudo ansible-pull \
    -U https://github.com/Sovereign-Labs/rollup-starter-ansible.git \
    -C main \
    -i inventory/localhost.ini \
    -e @/tmp/runtime_vars.yaml \
    local.yml
```

**Note:** The `-i inventory/localhost.ini` path is relative to the cloned repository, not your current directory. `ansible-pull` will find it automatically after cloning.

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    EC2 Instance Launches                     │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Cloud-Init / User Data Executes                 │
│  1. Install ansible, git, python3                           │
│  2. Generate runtime_vars.yaml from CDK parameters          │
│  3. Run ansible-pull                                        │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    Ansible-Pull Flow                         │
│  1. Clone Git repository to /tmp                            │
│  2. Read local.yml playbook                                 │
│  3. Execute against localhost (connection: local)           │
│  4. Run roles: common → rollup                              │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   Rollup Running                             │
│  - Systemd service: rollup                                  │
│  - Nginx proxy on port 8081                                 │
│  - Monitoring agents active                                 │
└─────────────────────────────────────────────────────────────┘
```

## Required Variables

### Minimal Required (always needed)

```yaml
data_availability_role: "celestia"  # or "mock_da"
switches: "cr"                       # or "r"
```