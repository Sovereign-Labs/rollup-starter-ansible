# Testing Guide

Quick reference for testing ansible-pull refactoring locally.

## Prerequisites

- Ubuntu 24.04 (VM or physical machine)
- Root/sudo access
- Internet connection

## Test 1: Bootstrap Script

Test the prerequisites installation:

```bash
# Run bootstrap script
sudo bash bootstrap.sh

# Verify installations
ansible --version    # Should be 2.16+
git --version        # Should show version
python3 --version    # Should show version

# Check log
sudo cat /var/log/sovereign-bootstrap.log
```

**Expected**: All tools installed successfully.

## Test 2: Local Mode with Mock DA

Test ansible-pull locally without Git:

```bash
# 1. Create runtime variables
cat > /tmp/runtime_vars.yaml << 'EOF'
---
data_availability_role: "mock_da"
switches: "cdr"
zkvm_role: "mock_zkvm"
debug: true
rollup_commit_hash: "770a88a25576640b1e76b9385bf61b05452d60dd"
da_start_height: 1
EOF

# 2. Run playbook in local mode (no git pull)
cd /path/to/sov-rollup-starter-ansible
sudo ansible-playbook local.yml \
    -i inventory/localhost.ini \
    -e @/tmp/runtime_vars.yaml \
    -vv

# 3. Verify deployment
sudo systemctl status rollup
curl http://localhost:12346/health
curl http://localhost:8081/health
```

**Expected**: Rollup deploys successfully with Mock DA.

## Test 3: Ansible-Pull from Git (Mock DA)

Test the full ansible-pull flow:

```bash
# 1. Prepare runtime vars
cat > /tmp/runtime_vars.yaml << 'EOF'
---
data_availability_role: "mock_da"
switches: "cdr"
zkvm_role: "mock_zkvm"
debug: true
rollup_commit_hash: "770a88a25576640b1e76b9385bf61b05452d60dd"
da_start_height: 1
EOF

# 2. Run ansible-pull (replace URL with your repo)
sudo ansible-pull \
    -U https://github.com/your-org/sov-rollup-starter-ansible.git \
    -C main \
    -i inventory/localhost.ini \
    -e @/tmp/runtime_vars.yaml \
    local.yml \
    -vv

# 3. Verify
sudo systemctl status rollup
sudo journalctl -u rollup -n 50
```

**Expected**: Git clone, playbook runs, rollup starts.

## Test 4: Ansible-Pull with Celestia DA

Test with Celestia configuration:

```bash
# 1. Create runtime vars with Celestia config
cat > /tmp/runtime_vars.yaml << 'EOF'
---
data_availability_role: "celestia"
switches: "cdr"
zkvm_role: "mock_zkvm"
debug: true
rollup_commit_hash: "770a88a25576640b1e76b9385bf61b05452d60dd"

# Celestia configuration
da_start_height: 8877186
rollup_batch_namespace: "test-bat01"
rollup_proof_namespace: "test-prf01"
celestia_rpc_url: "https://rpc-mocha.pops.one"
celestia_grpc_url: "grpc-mocha.pops.one:443"
da_rollup_address: "celestia1jk6xx55wum73al8f2mp54x92uggqws8ksnjus2"

# Secrets (use your actual credentials)
celestia_grpc_auth_token: "your-token-here"
signer_private_key: "your-key-here"
EOF

# 2. Secure the file
chmod 600 /tmp/runtime_vars.yaml

# 3. Run ansible-pull
sudo ansible-pull \
    -U https://github.com/your-org/sov-rollup-starter-ansible.git \
    -C main \
    -i inventory/localhost.ini \
    -e @/tmp/runtime_vars.yaml \
    local.yml

# 4. Verify Celestia connection
sudo journalctl -u rollup -n 100 | grep -i celestia
```

**Expected**: Rollup connects to Celestia and starts syncing.

## Test 5: Update Rollup Only

Test rollup-only updates (skip infrastructure):

```bash
# 1. Create minimal runtime vars
cat > /tmp/runtime_vars.yaml << 'EOF'
---
data_availability_role: "mock_da"
switches: "r"  # Rollup only!
rollup_commit_hash: "new-commit-hash-here"
EOF

# 2. Run update
sudo ansible-pull \
    -U https://github.com/your-org/sov-rollup-starter-ansible.git \
    -C main \
    -i inventory/localhost.ini \
    -e @/tmp/runtime_vars.yaml \
    local.yml

# 3. Verify new version
sudo systemctl status rollup
```

**Expected**: Only rollup role runs, service restarts with new binary.

## Test 6: Traditional Push Mode (Backward Compatibility)

Test that old method still works:

```bash
# On your local machine (not the server)
ansible-playbook setup.yaml \
    -i 'your-server-ip,' \
    -u ubuntu \
    --private-key ~/.ssh/your-key.pem \
    -e data_availability_role=mock_da \
    -e switches=cdr \
    -vv
```

**Expected**: Deploys successfully via SSH as before.

## Test 7: Idempotency Check

Test that re-running doesn't break anything:

```bash
# Run once
sudo ansible-pull \
    -U https://github.com/your-org/sov-rollup-starter-ansible.git \
    -i inventory/localhost.ini \
    -e @/tmp/runtime_vars.yaml \
    local.yml

# Run again with same config
sudo ansible-pull \
    -U https://github.com/your-org/sov-rollup-starter-ansible.git \
    -i inventory/localhost.ini \
    -e @/tmp/runtime_vars.yaml \
    local.yml
```

**Expected**: Second run shows "ok" for most tasks, "changed" minimal.

## Verification Commands

After any deployment:

```bash
# Service status
sudo systemctl status rollup
sudo systemctl status nginx

# Logs
sudo journalctl -u rollup -f          # Follow rollup logs
sudo tail -f /mnt/logs/rollup.log.*   # Application logs

# API health
curl http://localhost:12346/health    # Direct to rollup
curl http://localhost:8081/health     # Via nginx proxy

# Disk mounts
df -h | grep /mnt

# Process check
ps aux | grep rollup

# Port check
sudo netstat -tlnp | grep -E '12346|8081'
```

## Troubleshooting Commands

```bash
# Check cloud-init (if using EC2)
sudo cat /var/log/cloud-init-output.log
sudo cat /var/log/cloud-init-sovereign.log
cloud-init status --long

# Check Ansible logs
ls -ltr ~/.ansible/pull/

# Verify runtime vars loaded
ansible-playbook local.yml \
    -i inventory/localhost.ini \
    -e @/tmp/runtime_vars.yaml \
    --list-tasks

# Syntax check
ansible-playbook local.yml \
    -i inventory/localhost.ini \
    --syntax-check

# Dry run
ansible-playbook local.yml \
    -i inventory/localhost.ini \
    -e @/tmp/runtime_vars.yaml \
    --check
```

## Clean Up Between Tests

```bash
# Stop services
sudo systemctl stop rollup
sudo systemctl stop nginx

# Remove data (WARNING: destructive)
sudo rm -rf /mnt/rollup/*
sudo rm -rf /mnt/logs/*
sudo rm -rf /mnt/da/*

# Remove sovereign user (if testing user creation)
sudo userdel -r sovereign

# Remove ansible-pull cache
sudo rm -rf ~/.ansible/pull/
```

## Test Matrix

| Test | DA | zkVM | Debug | Switches | Expected Time |
|------|-----|------|-------|----------|---------------|
| 1 | Mock | Mock | true | cdr | ~15 min |
| 2 | Celestia | Mock | true | cdr | ~18 min |
| 3 | Mock | Risc0 | false | cdr | ~25 min |
| 4 | Celestia | Risc0 | false | cdr | ~30 min |
| 5 | Any | Any | Any | r | ~5 min |

## Success Criteria

✅ **Bootstrap succeeds**: Ansible, git, python3 installed

✅ **Playbook completes**: No failed tasks, only skipped/changed/ok

✅ **Service running**: `systemctl status rollup` shows active (running)

✅ **API responsive**: Health endpoints return 200 OK

✅ **Logs clean**: No errors in journalctl or log files

✅ **Idempotent**: Re-run doesn't break anything

✅ **Backward compatible**: Traditional SSH push still works

## Quick Test Script

Save this as `test-ansible-pull.sh`:

```bash
#!/bin/bash
set -e

echo "=== Testing Ansible-Pull Deployment ==="

# Check prerequisites
command -v ansible >/dev/null || { echo "ERROR: ansible not found"; exit 1; }
command -v git >/dev/null || { echo "ERROR: git not found"; exit 1; }

# Create test config
cat > /tmp/test-runtime-vars.yaml << 'EOF'
---
data_availability_role: "mock_da"
switches: "cdr"
zkvm_role: "mock_zkvm"
debug: true
rollup_commit_hash: "770a88a25576640b1e76b9385bf61b05452d60dd"
da_start_height: 1
EOF

echo "✓ Runtime vars created"

# Run ansible-pull
echo "Running ansible-pull..."
ansible-pull \
    -U https://github.com/your-org/sov-rollup-starter-ansible.git \
    -C main \
    -i inventory/localhost.ini \
    -e @/tmp/test-runtime-vars.yaml \
    local.yml

echo "✓ Ansible-pull completed"

# Verify
echo "Verifying deployment..."
systemctl is-active rollup >/dev/null || { echo "ERROR: rollup not running"; exit 1; }
curl -f http://localhost:12346/health >/dev/null 2>&1 || { echo "ERROR: API not responding"; exit 1; }

echo "✓ All checks passed!"
echo "=== Test Complete ==="
```

Run with:
```bash
sudo bash test-ansible-pull.sh
```

## Next Steps

1. Test locally with Mock DA first
2. Validate with Celestia DA (requires credentials)
3. Test update scenarios (rollup only)
4. Integrate with CDK
5. Deploy to production

## Support

- Full documentation: [ANSIBLE_PULL.md](ANSIBLE_PULL.md)
- CDK integration: [CDK_INTEGRATION.md](CDK_INTEGRATION.md)
- Issues: https://github.com/Sovereign-Labs/sov-rollup-starter-ansible/issues
