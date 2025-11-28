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

# Optional: Monitoring tokens (leave empty to skip monitoring setup)
influxdb_token: ""
grafana_loki_token: ""
grafana_tempo_token: ""
EOF
```

For Celestia DA, you need additional configuration:

```bash
cat > /tmp/runtime_vars.yaml << 'EOF'
---
data_availability_role: "celestia"
switches: "cr"
zkvm_role: "mock_zkvm"
debug: true
rollup_commit_hash: "770a88a25576640b1e76b9385bf61b05452d60dd"

# Celestia configuration
da_start_height: 8877186
rollup_batch_namespace: "your-bat10"  # Exactly 10 chars
rollup_proof_namespace: "your-pro10"  # Exactly 10 chars
celestia_rpc_url: "https://rpc-mocha.pops.one"
celestia_grpc_url: "grpc-mocha.pops.one:443"
da_rollup_address: "celestia1..."

# Celestia secrets (handle securely!)
celestia_grpc_auth_token: "eyJ..."
signer_private_key: "0x..."

# Optional: Monitoring tokens (leave empty to skip monitoring setup)
influxdb_token: ""
grafana_loki_token: ""
grafana_tempo_token: ""
EOF

# Secure the file since it contains secrets
chmod 600 /tmp/runtime_vars.yaml
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

## Files for ansible-pull

### New Files Created

| File                              | Purpose                                                               |
|-----------------------------------|-----------------------------------------------------------------------|
| `local.yml`                       | Main entry point for ansible-pull (replaces setup.yaml for pull mode) |
| `inventory/localhost.ini`         | Localhost inventory configuration                                     |
| `vars/runtime_vars.yaml.template` | Template showing all injectable variables                             |
| `bootstrap.sh`                    | Installs ansible and prerequisites                                    |
| `cloud-init-userdata.sh.example`  | Complete EC2 user-data example for CDK                                |

### Modified Files

| File                 | Changes                                                     |
|----------------------|-------------------------------------------------------------|
| `setup.yaml`         | Updated `delegate_to` to work with both push and pull modes |
| `preconditions.yaml` | Changed `delegate_to: localhost` to `run_once: true`        |

### Backward Compatibility

The traditional push-based deployment with `setup.yaml` **still works**:

```bash
# Traditional SSH push - still supported!
ansible-playbook setup.yaml \
    -i '54.81.181.127,' \
    -u ubuntu \
    --private-key ~/.ssh/YourKey.pem \
    -e data_availability_role=celestia \
    -e switches=cr
```

## CDK Integration

### CDK Responsibilities

Your CDK stack should:

1. **Generate user-data script** based on `cloud-init-userdata.sh.example`
2. **Inject configuration variables** into the user-data
3. **Retrieve secrets** from AWS Secrets Manager or SSM
4. **Attach IAM role** if pulling from private GitHub repo
5. **Configure security groups** (ports 12346, 8081)

### Example CDK Code Snippet (TypeScript)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as fs from 'fs';

// Read the user-data template
const userDataTemplate = fs.readFileSync(
  './ansible/cloud-init-userdata.sh.example',
  'utf-8'
);

// Retrieve secrets
const celestiaSecret = secretsmanager.Secret.fromSecretNameV2(
  this,
  'CelestiaSecret',
  'sovereign/celestia-credentials'
);

// Generate user-data with substitutions
const userData = ec2.UserData.custom(
  userDataTemplate
    .replace('ANSIBLE_REPO_URL="https://github.com/Sovereign-Labs/sov-rollup-starter-ansible.git"',
             'ANSIBLE_REPO_URL="https://github.com/your-org/sov-rollup-starter-ansible.git"')
    .replace('ANSIBLE_REPO_BRANCH="main"', 'ANSIBLE_REPO_BRANCH="production"')
    .replace('DATA_AVAILABILITY_ROLE="mock_da"', 'DATA_AVAILABILITY_ROLE="celestia"')
    .replace('ZKVM_ROLE="mock_zkvm"', 'ZKVM_ROLE="risc0"')
    .replace('DEBUG_BUILD="true"', 'DEBUG_BUILD="false"')
    .replace('ROLLUP_COMMIT_HASH="770a88a25576640b1e76b9385bf61b05452d60dd"',
             `ROLLUP_COMMIT_HASH="${props.rollupCommitHash}"`)
    // Add secret retrieval
    + `\n\n# Retrieve secrets from AWS Secrets Manager\n`
    + `CELESTIA_GRPC_AUTH_TOKEN=$(aws secretsmanager get-secret-value --secret-id ${celestiaSecret.secretArn} --query SecretString --output text | jq -r .grpc_auth_token)\n`
    + `SIGNER_PRIVATE_KEY=$(aws secretsmanager get-secret-value --secret-id ${celestiaSecret.secretArn} --query SecretString --output text | jq -r .private_key)\n`
    + `export CELESTIA_GRPC_AUTH_TOKEN SIGNER_PRIVATE_KEY\n`
);

// Create EC2 instance
const instance = new ec2.Instance(this, 'RollupNode', {
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.C5AD, ec2.InstanceSize.XLARGE4),
  machineImage: ec2.MachineImage.fromSsmParameter(
    '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id'
  ),
  vpc: vpc,
  userData: userData,
  blockDevices: [
    {
      deviceName: '/dev/sda1',
      volume: ec2.BlockDeviceVolume.ebs(100, {
        volumeType: ec2.EbsDeviceVolumeType.GP3,
      }),
    },
  ],
});

// Grant secret access
celestiaSecret.grantRead(instance);
```

## Required Variables

### Minimal Required (always needed)

```yaml
data_availability_role: "celestia"  # or "mock_da"
switches: "cr"                       # or "r"
```

### Recommended for Production

```yaml
rollup_commit_hash: "770a88a25576640b1e76b9385bf61b05452d60dd"
zkvm_role: "risc0"        # or "mock_zkvm"
debug: false              # true for development
da_start_height: 8877186  # Celestia block height
```

### Celestia DA (required if data_availability_role=celestia)

```yaml
# Configuration
rollup_batch_namespace: "my-batch1"  # Exactly 10 chars
rollup_proof_namespace: "my-proof1"  # Exactly 10 chars
celestia_rpc_url: "https://rpc-mocha.pops.one"
celestia_grpc_url: "grpc-mocha.pops.one:443"
da_rollup_address: "celestia1..."

# Secrets (inject securely)
celestia_grpc_auth_token: "eyJ..."
signer_private_key: "0x..."
```

### Infrastructure Overrides (optional)

```yaml
# Disk setup
raw_disk_list: ["/dev/nvme1n1", "/dev/nvme2n1"]
setup_disks: true

# Directories
rollup_storage_dir: "/mnt/rollup"
rollup_log_dir: "/mnt/logs"

# Monitoring
custom_host_label: "prod-rollup-01"
grafana_telemetry_enabled: true
```

### Complete Variable Reference

See `vars/runtime_vars.yaml.template` for all available variables with descriptions.

## Testing Locally

There are two ways to test the deployment locally:

### Method 1: Test ansible-pull (Production-like)

This simulates the production EC2 deployment workflow.

1. **Spin up Ubuntu 24.04 VM** (Vagrant, Multipass, or EC2)

2. **Bootstrap ansible**:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Sovereign-Labs/rollup-starter-ansible/main/bootstrap.sh | sudo bash
   ```

3. **Create test runtime_vars.yaml**:
   ```bash
   cat > /tmp/runtime_vars.yaml << 'EOF'
   ---
   data_availability_role: "mock_da"
   switches: "cr"
   zkvm_role: "mock_zkvm"
   debug: true
   rollup_commit_hash: "770a88a25576640b1e76b9385bf61b05452d60dd"
   da_start_height: 1
   EOF
   ```

4. **Run ansible-pull**:
   ```bash
   sudo ansible-pull \
       -U https://github.com/Sovereign-Labs/rollup-starter-ansible.git \
       -C main \
       -i inventory/localhost.ini \
       -e @/tmp/runtime_vars.yaml \
       local.yml
   ```

5. **Verify deployment**:
   ```bash
   # Check service
   sudo systemctl status rollup

   # Check logs
   sudo journalctl -u rollup -f

   # Test API
   curl http://localhost:12346/health
   ```

### Method 2: Test Locally Without Git (Development)

If you're developing the playbooks locally and want to test changes without committing:

1. **Clone the repo locally**:
   ```bash
   git clone https://github.com/Sovereign-Labs/rollup-starter-ansible.git
   cd rollup-starter-ansible
   ```

2. **Create runtime vars from template**:
   ```bash
   cp vars/runtime_vars.yaml.template vars/runtime_vars.yaml
   vim vars/runtime_vars.yaml
   ```

3. **Run with ansible-playbook (not ansible-pull)**:
   ```bash
   sudo ansible-playbook local.yml \
       -i inventory/localhost.ini \
       -e @vars/runtime_vars.yaml
   ```

This method runs the playbook directly from your local checkout, which is useful for:
- Testing playbook changes before committing
- Debugging ansible tasks
- Developing new roles

## Troubleshooting

### Check Cloud-Init Logs

```bash
# View cloud-init output
sudo cat /var/log/cloud-init-output.log

# View custom log (if using example script)
sudo cat /var/log/cloud-init-sovereign.log

# Check cloud-init status
cloud-init status --long
```

### Common Issues

#### 1. Ansible not found after bootstrap

**Symptom**: `ansible-pull: command not found`

**Solution**:
```bash
# Manually install
sudo apt-get update
sudo apt-get install -y software-properties-common
sudo add-apt-repository --yes --update ppa:ansible/ansible
sudo apt-get install -y ansible
```

#### 2. Git repository authentication failed

**Symptom**: `fatal: could not read Username for 'https://github.com'`

**Solution**: Use personal access token or deploy key
```bash
# Option 1: Public repo (easiest)
# Make your ansible repo public

# Option 2: Personal access token
ansible-pull -U https://username:token@github.com/org/repo.git ...

# Option 3: Deploy key (add to ~/.ssh/config on instance)
ansible-pull -U git@github.com:org/repo.git ...
```

#### 3. Variables not defined

**Symptom**: `data_availability_role is undefined`

**Solution**: Ensure runtime_vars.yaml is correctly formatted and loaded:
```bash
# Verify file exists
ls -la /tmp/ansible-sovereign/vars/runtime_vars.yaml

# Verify YAML syntax
python3 -c "import yaml; yaml.safe_load(open('/tmp/ansible-sovereign/vars/runtime_vars.yaml'))"

# Check ansible sees the vars
ansible-playbook local.yml -i inventory/localhost.ini -e @vars/runtime_vars.yaml --check --diff
```

#### 4. Disk setup fails

**Symptom**: `Failed to mount /dev/nvme1n1`

**Solution**: Verify disks exist or disable disk setup:
```bash
# Check available disks
sudo fdisk -l

# Option 1: Update raw_disk_list in runtime_vars.yaml
raw_disk_list: ["/dev/xvdb", "/dev/xvdc"]

# Option 2: Disable disk setup
setup_disks: false
```

#### 5. Service fails to start

**Symptom**: `rollup.service: Failed with result 'exit-code'`

**Solution**: Check service logs:
```bash
# View detailed service status
sudo systemctl status rollup -l

# View journal logs
sudo journalctl -u rollup -n 100 --no-pager

# Check rollup log file
sudo tail -100 /mnt/logs/rollup.log.*
```

### Debugging ansible-pull

Run with verbose output:

```bash
sudo ansible-pull \
    -U https://github.com/your-org/sov-rollup-starter-ansible.git \
    -C main \
    -i inventory/localhost.ini \
    -e @vars/runtime_vars.yaml \
    -vvv \
    local.yml
```

### Manual Playbook Run (Skip Git Pull)

If you've already cloned the repo manually:

```bash
cd /var/lib/ansible-pull/sov-rollup-starter-ansible

sudo ansible-playbook local.yml \
    -i inventory/localhost.ini \
    -e @/path/to/runtime_vars.yaml \
    -vv
```

## Security Considerations

### Secrets Management

**❌ Don't**: Hardcode secrets in user-data or Git

**✅ Do**: Use AWS Secrets Manager or SSM Parameter Store

```bash
# In user-data script
CELESTIA_GRPC_AUTH_TOKEN=$(aws secretsmanager get-secret-value \
    --secret-id sovereign/celestia/grpc-token \
    --query SecretString --output text)

SIGNER_PRIVATE_KEY=$(aws secretsmanager get-secret-value \
    --secret-id sovereign/celestia/signer-key \
    --query SecretString --output text)
```

### IAM Permissions

Grant EC2 instance role access to secrets:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": [
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:sovereign/*"
      ]
    }
  ]
}
```

### Network Security

- Run ansible-pull from private subnets with NAT gateway
- Restrict GitHub repository access
- Use VPC endpoints for AWS services (Secrets Manager, SSM)

## Performance Optimization

### Reduce Deploy Time

1. **Use release builds in development**: `debug: false` (faster runtime)
2. **Skip unnecessary roles**: Use `switches=r` for rollup-only updates
3. **Pre-bake AMI**: Create AMI after common role, use `switches=r` for instances
4. **Use mock_zkvm in dev**: Switch to `risc0` only for production

### Pre-Baked AMI Workflow

1. Deploy once with `switches=c` (common only)
2. Create AMI from that instance
3. Launch new instances from AMI with `switches=r` (skip common)
4. Reduces instance boot time from ~20min to ~5min

## Next Steps

- Review `cloud-init-userdata.sh.example` for CDK integration
- Test ansible-pull locally before CDK deployment
- Set up AWS Secrets Manager for Celestia credentials
- Create monitoring dashboards for deployed nodes

## Support

- Issues: https://github.com/Sovereign-Labs/sov-rollup-starter-ansible/issues
- Traditional deployment: See [README.md](README.md)
