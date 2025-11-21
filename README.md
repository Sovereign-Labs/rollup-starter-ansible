# Sovereign Rollup Ansible Automation

This repository contains Ansible playbooks to automate deploying the [rollup-starter](https://github.com/Sovereign-Labs/rollup-starter) on remote servers, primarily tested on AWS EC2 instances.

## Deployment Modes

This repository supports **two deployment modes**:

### 1. Traditional Push Mode (SSH-based)
Deploy to remote servers via SSH from your local machine. Ideal for:
- Development and testing
- Manual deployments
- Non-AWS environments (Hetzner, bare metal)

**Quick start**: See deployment examples below ⬇️

### 2. Pull Mode (ansible-pull for EC2)
Machines self-configure on first boot without SSH. Ideal for:
- Automated EC2 deployments via CDK/CloudFormation
- Cloud-init / user-data integration
- Immutable infrastructure patterns

**Quick start**: See [ANSIBLE_PULL.md](ANSIBLE_PULL.md) and [CDK_INTEGRATION.md](CDK_INTEGRATION.md)

## Overview

This setup supports multiple deployment configurations:
- **Mock DA** - For local development and testing (fastest)
- **Celestia DA** - Connects to external Celestia RPC (no local node required)
- **Mock zkVM** - No installation required (default, fastest)
- **Risc0 zkVM** - Full zkVM proving capabilities (requires installation)

## Key Features

✅ **Parameterized Data Availability Layer** - Easy switching between MockDA and Celestia
✅ **Parameterized zkVM** - Easy switching between mock and risc0
✅ **Consolidated Configuration** - All settings in central locations
✅ **Automatic Disk Setup** - Mounts and configures NVME drives
✅ **Monitoring Integration** - Telegraf, Loki, and Tempo support
✅ **ansible-pull Support** - Self-configuring EC2 instances without SSH
✅ **CDK Integration Ready** - Works with AWS CDK for IaC deployments

## Machine Requirements


**Recommended AWS Instance:** [`c5ad.4xlarge`](https://aws.amazon.com/ec2/instance-types/c5/)
- 16 CPU cores
- 2 x NVME SSD
- 32 GB RAM
- Ubuntu 24.04 LTS
- Root volume: ≥100GB gp3

**Setup Steps:**
1. Launch EC2 instance with Ubuntu 24.04
2. Create/use an AWS SSH keypair
3. Move `.pem` file: `mv ~/Downloads/YourKey.pem ~/.ssh/`
4. Set permissions: `chmod 400 ~/.ssh/YourKey.pem`
5. Verify SSH access: `ssh -i ~/.ssh/YourKey.pem ubuntu@<IP>`

## Required Software (macOS)

```bash
brew install ansible
ansible --version  # Should be ansible [core 2.16+]
```

## Configuration

### Variable Files

All configuration is organized in role-based defaults and secret files:

#### 1. Common Infrastructure
**File:** [`roles/common/defaults/main.yaml`](roles/common/defaults/main.yaml)

**Key Variables:**
- `raw_disk_list` - Disks to mount (default: AWS c5ad.4xlarge)
- `setup_disks` - Enable automatic disk setup (default: true)
- `rollup_storage_dir` - Rollup data path (default: `/mnt/rollup`)
- `rollup_log_dir` - Log path (default: `/mnt/logs`)
- `da_store` - DA data path (default: `/mnt/da`)
- `max_open_files` - File descriptor limit (default: 1000000)
- Monitoring endpoints (InfluxDB, Loki, Tempo)

#### 2. Rollup Configuration
**File:** [`roles/rollup/defaults/main.yaml`](roles/rollup/defaults/main.yaml)

**Key Variables:**
- `rollup_org_name` - GitHub org (default: "Sovereign-Labs")
- `rollup_repo_name` - Repository name (default: "rollup-starter")
- `rollup_commit_hash` - ⚠️ **Git commit to deploy** (update this!)
- `zkvm_role` - zkVM implementation (default: "mock_zkvm", option: "risc0")
- `debug` - Build in debug mode (default: true)
- `genesis_sequencer_rollup_address` - Sequencer address
- `genesis_rollup_prover_address` - Prover address
- `rollup_http_port` - API port (default: 12346)
- `nginx_port` - Proxy port (default: 8081)
- `wipe` - Wipe data on deployment (default: false)

#### 3. Data Availability - Celestia
**File:** [`roles/data-availability/celestia/defaults/main.yaml`](roles/data-availability/celestia/defaults/main.yaml)

**Key Variables:**
- `celestia_network` - Network ("mocha" or "celestia")
- `celestia_rpc_url` - External RPC endpoint
- `celestia_grpc_url` - External gRPC endpoint
- `da_rollup_address` - Celestia address for signing
- `da_start_height` - DA block height to start from
- `rollup_batch_namespace` - Namespace for batches (10 chars)
- `rollup_proof_namespace` - Namespace for proofs (10 chars)

**Secrets (override in `vars/celestia_secrets.yaml`):**
- `celestia_grpc_auth_token`
- `signer_private_key`

#### 4. Data Availability - Mock
**File:** [`roles/data-availability/mock_da/defaults/main.yaml`](roles/data-availability/mock_da/defaults/main.yaml)

**Key Variables:**
- `da_start_height` - Starting height (default: 1)
- `da_rollup_address` - Mock address (hex string)

#### 5. zkVM - Risc0
**File:** [`roles/zkvm/risc0/defaults/main.yaml`](roles/zkvm/risc0/defaults/main.yaml)

**Key Variables:**
- `risc0_cargo_version` - cargo-risczero version (default: "1.2.0")
- `risc0_toolchain_version` - Toolchain version (default: "r0.1.81.0")

#### 6. zkVM - Mock
**File:** [`roles/zkvm/mock_zkvm/defaults/main.yaml`](roles/zkvm/mock_zkvm/defaults/main.yaml)

No configuration needed - included in rollup by default.

### Secret Files (NOT Committed)

#### Celestia Secrets
**File:** `vars/celestia_secrets.yaml` (add to `.gitignore`)

```yaml
# Celestia Secrets - DO NOT COMMIT
celestia_grpc_auth_token: "YOUR_GRPC_AUTH_TOKEN"
signer_private_key: "YOUR_PRIVATE_KEY_HEX"
```

#### Monitoring Secrets
**File:** `vars/monitoring_secrets.yaml`

Contains Grafana Loki and Tempo credentials.

### How to Override Variables

Variables can be overridden in order of precedence (highest to lowest):

1. **Command line** - Using `-e` flag:
   ```bash
   -e zkvm_role=risc0 -e debug=false
   ```

2. **Secret files** - Create/edit files in `vars/`:
   ```bash
   # Edit secrets
   vi vars/celestia_secrets.yaml
   ```

3. **Role defaults** - Edit role default files:
   ```bash
   # Edit rollup defaults
   vi roles/rollup/defaults/main.yaml
   ```

**Example - Override multiple variables:**
```bash
ansible-playbook setup.yaml \
    -i '1.2.3.4,' \
    -u ubuntu \
    --private-key ~/.ssh/YourKey.pem \
    -e data_availability_role=celestia \
    -e zkvm_role=risc0 \
    -e rollup_commit_hash=abc123def \
    -e debug=false \
    -e switches=cdr
```

## Using Inventory Files (Recommended)

For managing multiple servers, use inventory files instead of command-line parameters:

### Quick Setup

```bash
# 1. Copy the example inventory
cp inventory/hosts.ini.example inventory/hosts.ini

# 2. Edit with your server details
vi inventory/hosts.ini

# 3. Deploy to all production servers
ansible-playbook setup.yaml -i inventory/hosts.ini --limit production

# 4. Deploy to specific server
ansible-playbook setup.yaml -i inventory/hosts.ini --limit rollup-prod-01
```

### Inventory Format (INI)

```ini
# Production servers
[production]
rollup-prod-01 ansible_host=54.81.181.127
rollup-prod-02 ansible_host=54.81.181.128

# Shared variables for all production servers
[production:vars]
ansible_user=ubuntu
ansible_ssh_private_key_file=~/.ssh/production-key.pem
ansible_ssh_common_args=-o ForwardAgent=yes -o StrictHostKeyChecking=no
data_availability_role=celestia
zkvm_role=risc0
debug=false
rollup_commit_hash=main
```

### Mixed Configurations

You can override group variables per host for mixed deployments:

```ini
[staging]
# Host-specific variables override group vars
rollup-staging-01 ansible_host=54.81.181.200 data_availability_role=mock_da
rollup-staging-02 ansible_host=54.81.181.201 data_availability_role=celestia

[staging:vars]
zkvm_role=mock_zkvm    # Shared by all staging servers
debug=true             # Shared by all staging servers
```

### Common Inventory Commands

```bash
# Deploy to all servers in a group
ansible-playbook setup.yaml -i inventory/hosts.ini --limit production

# Deploy to multiple groups
ansible-playbook setup.yaml -i inventory/hosts.ini --limit "production,staging"

# Deploy to specific server
ansible-playbook setup.yaml -i inventory/hosts.ini --limit rollup-prod-01

# Deploy in parallel (5 servers at once)
ansible-playbook setup.yaml -i inventory/hosts.ini --limit production --forks 5

# Update only rollup (skip common/DA)
ansible-playbook setup.yaml -i inventory/hosts.ini --limit production -e switches=r

# Override inventory variables from command line
ansible-playbook setup.yaml -i inventory/hosts.ini --limit staging -e rollup_commit_hash=abc123
```

See [inventory/README.md](inventory/README.md) for more details.

## Deployment Examples

### 1. Mock DA with Mock zkVM (Fastest - Development)

```bash
ansible-playbook setup.yaml \
    -i '54.81.181.127,' \
    -u ubuntu \
    --private-key ~/.ssh/YourKey.pem \
    -e 'ansible_ssh_common_args="-o ForwardAgent=yes -o StrictHostKeyChecking=no"' \
    -e 'switches=cdr' \
    -e 'data_availability_role=mock_da'
```

**What this does:**
- ✅ Sets up common infrastructure (disks, deps, monitoring)
- ✅ Configures Mock DA (SQLite-based, no external dependencies)
- ✅ Uses Mock zkVM (no installation required)
- ✅ Builds and starts rollup

### 2. Celestia DA with Mock zkVM

**Prerequisites:**
1. Update `vars/celestia_secrets.yaml` with your credentials
2. Update `roles/data-availability/celestia/defaults/main.yaml` with your settings

```bash
ansible-playbook setup.yaml \
    -i '54.81.181.127,' \
    -u ubuntu \
    --private-key ~/.ssh/YourKey.pem \
    -e 'ansible_ssh_common_args="-o ForwardAgent=yes -o StrictHostKeyChecking=no"' \
    -e 'switches=cdr' \
    -e 'data_availability_role=celestia'
```

**What this does:**
- ✅ Connects to external Celestia RPC (no local node)
- ✅ Uses your Celestia credentials for signing
- ✅ Updates namespace in constants.toml
- ✅ Uses Mock zkVM for fast iteration

### 3. Celestia DA with Risc0 zkVM (Full Production Setup)

```bash
ansible-playbook setup.yaml \
    -i '54.81.181.127,' \
    -u ubuntu \
    --private-key ~/.ssh/YourKey.pem \
    -e 'ansible_ssh_common_args="-o ForwardAgent=yes -o StrictHostKeyChecking=no"' \
    -e 'switches=cdr' \
    -e 'data_availability_role=celestia' \
    -e 'zkvm_role=risc0'
```

**What this does:**
- ✅ Installs Risc0 toolchain (rzup, cargo-risczero)
- ✅ Builds with full zkVM proving capabilities
- ⏱️ Takes longer to build (~10-15 minutes for first build)

### 4. Update Rollup Only (No Infrastructure Changes)

```bash
ansible-playbook setup.yaml \
    -i '54.81.181.127,' \
    -u ubuntu \
    --private-key ~/.ssh/YourKey.pem \
    -e 'ansible_ssh_common_args="-o ForwardAgent=yes"' \
    -e 'switches=r' \
    -e 'data_availability_role=celestia'
```

**What this does:**
- Stops rollup service
- Updates git repository to latest `rollup_commit_hash`
- Rebuilds binary
- Restarts rollup service

### 5. Update and Wipe Data

```bash
ansible-playbook setup.yaml \
    -i '54.81.181.127,' \
    -u ubuntu \
    --private-key ~/.ssh/YourKey.pem \
    -e 'switches=r' \
    -e 'data_availability_role=celestia' \
    -e 'wipe=true'
```

⚠️ **Warning:** This deletes all rollup state data!

## Switches Explained

The `switches` variable controls which roles run:

- `c` - **Common** - Infrastructure setup (disks, deps, users)
- `d` - **Data Availability** - DA configuration
- `r` - **Rollup** - Build and deploy rollup

**Common Combinations:**
- `cdr` - Full setup from scratch
- `dr` - DA + Rollup (skip infrastructure)
- `r` - Rollup only (update binary)

## SSH Setup

**Add keys to SSH agent:**
```bash
# Add AWS key
ssh-add ~/.ssh/YourAWSKey.pem

# Add GitHub key (for private repos)
ssh-add ~/.ssh/github_id_rsa

# Verify
ssh-add -l
```

## Expected Output

Successful deployment:
```
PLAY RECAP ****************************************************************
54.81.181.127 : ok=93   changed=30   unreachable=0    failed=0    skipped=36
```

**Key indicators:**
- `failed=0` - All tasks succeeded
- `unreachable=0` - SSH connection stable
- `changed=X` - Number of modified configurations

## Structure

### Roles

**1. common**
- Installs dependencies (Rust, build tools)
- Mounts and configures disks
- Creates `sovereign` user
- Tunes kernel parameters
- Sets up monitoring (Telegraf, Loki, Tempo)
- Configures time sync (Chrony)

**2. data-availability**
- **Celestia:** Configures external RPC connection (no local node)
- **Mock:** Sets up SQLite-based DA for testing

**3. rollup**
- Clones rollup repository
- Checks out specific commit
- Updates configuration files
- Updates namespaces in constants.toml (Celestia only)
- Builds rollup binary
- Manages systemd service

**4. zkvm**
- **Risc0:** Installs zkVM toolchain
- **Mock:** No installation (built-in)

## Troubleshooting

### Check Service Status
```bash
sudo systemctl status rollup
```

### View Logs
```bash
# Systemd journal
journalctl -u rollup -f

# Log file
tail -f /mnt/logs/rollup.log.*
```

### Common Issues

**1. SSH Host Key Verification Failed**
```bash
# Add to ansible command:
-e 'ansible_ssh_common_args="-o StrictHostKeyChecking=no"'
```

**2. Variable Not Found Error**
- Check that all required variable files exist
- Verify `data_availability_role` is set
- Check `vars/celestia_secrets.yaml` for Celestia deployments

**3. Build Failures**
- Verify `rollup_commit_hash` is valid
- Check disk space: `df -h`
- Review build logs: `journalctl -u rollup`

**4. Risc0 Installation Slow**
- First installation takes 10-15 minutes
- Use `mock_zkvm` for development iteration

### Manual Verification

**Check running processes:**
```bash
ps aux | grep rollup
```

**Check disk usage:**
```bash
df -h /mnt/rollup /mnt/logs
```

**Test API endpoint:**
```bash
curl http://localhost:12346/health  # Direct
curl http://localhost:8081/health   # Via nginx
```

## Architecture Diagram

```
┌─────────────────┐
│  Ansible Host   │
│   (Your Mac)    │
└────────┬────────┘
         │ SSH
         ▼
┌─────────────────────────────────────┐
│         Remote Server               │
│  ┌──────────────────────────────┐  │
│  │  Common Infrastructure       │  │
│  │  - Disks, Users, Monitoring  │  │
│  └──────────────────────────────┘  │
│                                     │
│  ┌──────────────────────────────┐  │
│  │  Data Availability           │  │
│  │  - Celestia RPC Connection   │  │
│  │    OR                        │  │
│  │  - Mock DA (SQLite)          │  │
│  └──────────────────────────────┘  │
│                                     │
│  ┌──────────────────────────────┐  │
│  │  zkVM                        │  │
│  │  - Risc0 Toolchain           │  │
│  │    OR                        │  │
│  │  - Mock (built-in)           │  │
│  └──────────────────────────────┘  │
│                                     │
│  ┌──────────────────────────────┐  │
│  │  Rollup                      │  │
│  │  - Build from source         │  │
│  │  - Systemd service           │  │
│  │  - Nginx proxy               │  │
│  └──────────────────────────────┘  │
└─────────────────────────────────────┘
```

## Advanced Usage

### Custom Namespaces (Celestia)

Edit `roles/data-availability/celestia/defaults/main.yaml`:
```yaml
rollup_batch_namespace: "my-batch1"  # Exactly 10 chars
rollup_proof_namespace: "my-proof1"  # Exactly 10 chars
```

### Custom DA Start Height

Reduce sync time by starting from a recent height:
```bash
# Get latest height from Celestia explorer
# https://mocha.celenium.io/

# Update in celestia defaults
da_start_height: 6739020
```

### Custom Build Options

```bash
# Release build (optimized, slower compile)
-e debug=false

# Specific commit
-e rollup_commit_hash=abc123def456

# Custom binary name
-e rollup_bin=my-rollup
```

## Additional Documentation

### For Automated Deployments

- **[ANSIBLE_PULL.md](ANSIBLE_PULL.md)** - Complete guide to ansible-pull deployment
  - How ansible-pull works
  - EC2 user-data integration
  - Testing and troubleshooting
  - Security best practices

- **[CDK_INTEGRATION.md](CDK_INTEGRATION.md)** - AWS CDK integration guide
  - CDK stack examples
  - Variable configuration
  - Secrets management
  - Deployment patterns

### Key Files for ansible-pull

- `local.yml` - Entry point for ansible-pull (self-configuration)
- `inventory/localhost.ini` - Localhost inventory
- `vars/runtime_vars.yaml.template` - All injectable variables
- `bootstrap.sh` - Prerequisites installer
- `cloud-init-userdata.sh.example` - Complete EC2 user-data example

## Contributing

When adding new variables:
1. Add to appropriate `roles/*/defaults/main.yaml`
2. Document in this README
3. Add secrets to `vars/*_secrets.yaml` (never commit)
4. Update examples if needed
5. Update `vars/runtime_vars.yaml.template` for ansible-pull

## License

See [LICENSE.md](LICENSE.md)
