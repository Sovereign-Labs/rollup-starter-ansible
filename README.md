# Sovereign Rollup Ansible Automation

This repository contains Ansible playbooks to automate deploying the [rollup-starter](https://github.com/Sovereign-Labs/rollup-starter) on remote servers, primarily tested on AWS EC2 instances.

For more information scroll below to Deployment modes

## "I just want to change rollup_config.toml"

Template is in [`roles/rollup/templates/rollup_config.toml.j2](./roles/rollup/templates/rollup_config.toml.j2)
There are also 2 injected parts for each DA:
 * MockDA: [`roles/rollup/templates/mock_da/rollup_da_config.toml.j2`](./roles/rollup/templates/mock_da/rollup_da_config.toml.j2)
 * Celestia: [`roles/rollup/templates/celestia/rollup_da_config.toml.j2`](./roles/rollup/templates/celestia/rollup_da_config.toml.j2)

All variables are defined in [`roles/rollup/defaults/main.yaml`](./roles/rollup/defaults/main.yaml) . Some of them dynamically calculated in tasks.

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

**Quick start**: See [ANSIBLE_PULL.md](ANSIBLE_PULL.md) 

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


**Recommended AWS Instance:** [`c8gd.12xlarge`](https://aws.amazon.com/ec2/instance-types/c8/)

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

# Install required collections (`community.crypto` for proxy cert checks,
# `community.postgresql` for local Postgres provisioning in the rollup role)
ansible-galaxy collection install -r requirements.yml
```

## Configuration

### Variable Files

All configuration is organized in role-based defaults and secret files:

#### 1. Common Infrastructure
**File:** [`roles/common/defaults/main.yaml`](roles/common/defaults/main.yaml)

For instances with one local NVMe, such as `i8g.2xlarge`, use:

```yaml
disk_profile: aws_single_nvme_ebs_logs
```

This mounts the first instance-store NVMe at `/mnt/rollup` without RAID and a
separate EBS volume at `/mnt/logs`, including the persistent system journal.
Attach that EBS volume as **`/dev/sdg` in the EC2 block-device mapping**; its Linux
name is discovered from NVMe controller metadata, so enumeration order does not
matter. A missing, ambiguous, partitioned, or root EBS device fails discovery
before disk formatting. The root EBS volume remains separate. A 64 GiB gp3 logs
volume is a reasonable starting size for the Relay trial.

The profile does not require a snapshot-mirror EBS volume and does not enable
snapshot scheduling. Use `rollup_sequencer_kind: standard` and
`is_backup_node: false` for a replica that only follows the chain. A manually
installed stop/sleep/restart cron job works independently of `is_backup_node`.
Setting that flag to `true` installs the real snapshot script and cron job,
which require a separate configured snapshot volume to run successfully.

For a real backup node with one local NVMe, use:

```yaml
disk_profile: aws_ebs_backup_node_single_nvme
rollup_sequencer_kind: standard
is_backup_node: true
```

This adds an independent snapshot-mirror EBS volume attached as **`/dev/sdf`**,
mounted at `/mnt/snapshots`, and enables the usual hourly snapshot script/cron.
The profile name also enables `is_backup_node` automatically when it is unset.
Size the mirror for the state data it must hold; it is separate from both root
and the small logs volume. The existing CDK snapshot-volume lookup uses `/dev/sdf`.

All EBS profiles use the same attachment-name resolver. The older
`aws_ebs_backup_node` and `aws_ebs_backup_node_raid_0` profiles now explicitly
require snapshots at `/dev/sdf`, matching CDK; their NVMe assignments are unchanged.
The new profiles explicitly select logs at `/dev/sdg`. These names are EC2
attachment identifiers, not guaranteed Linux device paths on Ubuntu/Nitro.
The resolver translates them to the current NVMe paths; mounts use filesystem
UUIDs. Instance-store NVMe discovery still uses the device model.

Custom auto-discovery profiles that used `ebs_serial_prefix` must instead specify
`snapshots_ebs_device_name` with the actual EC2 attachment name and retain
`snapshots_disk_from_ebs: true`. Manual profiles can still use literal Linux paths.
To verify EBS discovery locally without accessing disks:

```bash
python3 -m unittest discover -s tests -p 'test_ebs_disk_discovery.py'
```

#### 2. Rollup Configuration
**File:** [`roles/rollup/defaults/main.yaml`](roles/rollup/defaults/main.yaml)

**Key Variables:**
- `rollup_repo` - Full git URL (default: "https://github.com/Sovereign-Labs/rollup-starter.git")
  - Use HTTPS for public repos, `git@github.com:org/repo.git` for private repos with SSH keys
- `rollup_commit_hash` - ⚠️ **Git commit to deploy** (update this!)
- `zkvm_role` - zkVM implementation (default: "mock_zkvm", options: "risc0", "sp1")
- `rollup_genesis_operating_mode` - Genesis operating mode: "operator", "zk", or "optimistic"
- `rollup_genesis_inner_code_commitment` / `rollup_genesis_outer_code_commitment` - Eight-integer code commitments; required to be non-zero for "zk"/"optimistic" with "risc0" or "sp1"
- `debug` - Build in debug mode (default: false) for faster iteration
- `rollup_http_port` - API port (default: 12346)
- `rollup_http_host` - Optional bind host override; defaults to `127.0.0.1` with the proxy role and `0.0.0.0` without it

**Secrets (override in `vars/celestia_secrets.yaml`):**
- `celestia_grpc_auth_token`
- `signer_private_key`

#### 4. Data Availability - Mock
**File:** [`roles/rollup/vars/mock_da.yaml`](roles/rollup/vars/mock_da.yaml)

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

Contains InfluxDB, Grafana Loki, and Tempo credentials. Also supports optional secondary InfluxDB outputs for sending metrics to multiple destinations (e.g., internal InfluxDB + Grafana Cloud):

```yaml
influxdb_token: "YOUR_INFLUXDB_TOKEN"

# Optional: tokens for secondary InfluxDB outputs (keyed by name)
# Output configs are defined in custom_overrides.yaml
influxdb_secondary_tokens:
  grafana-cloud: "YOUR_SECONDARY_TOKEN"
```

Secondary output configs (non-secret) go in `vars/custom_overrides.yaml`:

```yaml
influxdb_secondary_outputs:
  - name: "grafana-cloud"
    url: "https://influx-prod.grafana.net"
    org: "my-org"
    bucket: "prod-metrics"
```

#### Additional OTEL metrics output

Telegraf is pinned to apt package `1.40.0-1` (`telegraf_version`). Running the
common role upgrades an older installation to that version. Changes to the
package or configuration notify the Telegraf restart handler.
Telemetry restart handlers have names specific to each role, so disabled roles
cannot override and suppress another role's Telegraf or Alloy restart.

The optional OTLP/HTTP output is independent of the existing InfluxDB outputs
and Alloy log/trace exporters. Configure these non-secret values:

```yaml
otel_metrics_endpoint: "https://otel.relay.link/v1/metrics"
otel_service_name: "relay-chain"
otel_service_instance_id: "unique-node-id"
```

Supply `otel_token` through protected runtime variables or monitoring secrets.
For CDK deployments, `OtelTokenSecretName` selects the Secrets Manager secret
(mainnet: `Relay/OTLP`), with JSON key `token`. The renderer sets
`otel_service_instance_id` to `<prefix>-<primary|secondary|backup>_<EC2 ID>`.
`OtelServiceInstancePrefix` selects the prefix (mainnet: `relay-chain-prod`);
empty uses `OtelServiceName`. For example: `relay-chain-prod-backup_i-0123456789abcdef0`.
The token
is written only to the separate `root:telegraf`, mode `0640` drop-in
`/etc/telegraf/telegraf.d/otel.conf`; Ansible suppresses its output and diffs.
Defaults are protobuf encoding, gzip compression, and a 10-second timeout.
Setting `otel_metrics_endpoint` to an empty string removes this drop-in.

Publish the Ansible changes to the branch selected by CDK before applying them.
Apply to the backup node first; check `telegraf --version`,
`systemctl status telegraf`, and `journalctl -u telegraf --since '10 minutes ago'`.
Verify fresh metrics in both destinations and continued logs in Grafana before
applying to the other nodes. Logs are sent by Alloy, not Telegraf.

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
    -e switches=cr
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
    -e 'switches=cr' \
    -e 'data_availability_role=mock_da'
```

**What this does:**
- ✅ Sets up common infrastructure (disks, deps, monitoring)
- ✅ Configures Mock DA (SQLite-based, no external dependencies)
- ✅ Uses Mock zkVM (no installation required)
- ✅ Builds and starts rollup

## Switches Explained

The `switches` variable controls which roles run:

- `c` - **Common** - Infrastructure setup (disks, deps, users)
- `r` - **Rollup** - Build and deploy rollup (includes DA configuration)
- `p` - **Proxy** - OpenResty public RPC proxy with optional TLS and secure domains

**Common Combinations:**
- `cr` - Full setup from scratch without the proxy role; public RPC is exposed on port `12346`
- `crp` - Full setup from scratch with the proxy role in front of a loopback-only rollup backend
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

**2. rollup**
- Configures Data Availability (Celestia or Mock DA)
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
curl http://localhost/health        # Via proxy when switches includes "p"
```

## Advanced Usage

### Custom Namespaces (Celestia)

Edit `roles/rollup/vars/celestia.yaml`:
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
