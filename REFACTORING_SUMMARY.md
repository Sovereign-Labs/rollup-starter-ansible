# Ansible-Pull Refactoring Summary

## Overview

This refactoring adds **ansible-pull support** for automated EC2 instance configuration while maintaining full backward compatibility with traditional SSH-based deployments.

## What Changed

### New Files Created

| File | Purpose |
|------|---------|
| **`local.yml`** | Main entry point for ansible-pull deployments. Configures connection: local and hosts: localhost |
| **`inventory/localhost.ini`** | Localhost inventory file with ansible_connection=local |
| **`vars/runtime_vars.yaml.template`** | Complete template showing all variables that can be injected at runtime, with detailed comments |
| **`bootstrap.sh`** | Shell script to install ansible, git, and python3 prerequisites on fresh Ubuntu instances |
| **`cloud-init-userdata.sh.example`** | Complete EC2 user-data script example showing end-to-end deployment flow |
| **`ANSIBLE_PULL.md`** | Comprehensive guide covering ansible-pull usage, testing, troubleshooting, and security |
| **`CDK_INTEGRATION.md`** | AWS CDK integration guide with TypeScript examples and deployment patterns |
| **`REFACTORING_SUMMARY.md`** | This file - summary of all changes |

### Modified Files

| File | Change | Reason |
|------|--------|--------|
| **`setup.yaml`** | Changed `delegate_to: localhost` to `delegate_to: "{{ 'localhost' if ansible_connection != 'local' else omit }}"` | Makes file checking work in both SSH and local modes |
| **`preconditions.yaml`** | Changed `delegate_to: localhost` to `run_once: true` | Removes localhost delegation, works in local mode |
| **`README.md`** | Added section on deployment modes and links to new docs | Documents both deployment approaches |
| **`.gitignore`** | Added `vars/runtime_vars.yaml` exception for `inventory/localhost.ini` | Prevents committing secrets, allows localhost inventory |

### No Changes Required

The following files work as-is with ansible-pull:
- All role tasks and templates
- All variable defaults
- All handlers
- Directory structure

## Backward Compatibility

**✅ 100% backward compatible**

Traditional SSH-based deployments continue to work exactly as before:

```bash
# This still works!
ansible-playbook setup.yaml \
    -i '54.81.181.127,' \
    -u ubuntu \
    --private-key ~/.ssh/YourKey.pem \
    -e data_availability_role=celestia \
    -e switches=cdr
```

## New Capabilities

### 1. Self-Configuring EC2 Instances

Instances configure themselves on first boot via cloud-init:

```bash
# In EC2 user-data
ansible-pull \
    -U https://github.com/your-org/sov-rollup-starter-ansible.git \
    -i inventory/localhost.ini \
    -e @vars/runtime_vars.yaml \
    local.yml
```

### 2. CDK Integration

Easy integration with AWS CDK for Infrastructure as Code:

```typescript
const userData = ec2.UserData.custom(userDataScript);
const instance = new ec2.Instance(this, 'RollupNode', {
  vpc,
  userData,
  // ...
});
```

### 3. No SSH Required

- No SSH keys to manage
- No network access needed for deployment control
- Works in private subnets with NAT
- Simpler security group rules

### 4. Immutable Infrastructure

- Instances provision themselves from version-controlled config
- Easy to replace/rebuild instances
- Consistent deployments across environments

## How It Works

### Traditional Push Mode (Existing)

```
Developer Machine → SSH → Remote Server → Execute Playbook
```

### New Pull Mode

```
EC2 Launch → User Data → ansible-pull → Git Clone → Execute Locally
```

## Variable Injection

### Push Mode (Existing)

Variables passed via command line:

```bash
-e data_availability_role=celestia -e zkvm_role=risc0
```

### Pull Mode (New)

Variables injected via runtime_vars.yaml:

```yaml
# vars/runtime_vars.yaml
data_availability_role: celestia
zkvm_role: risc0
rollup_commit_hash: abc123
# ... etc
```

CDK generates this file in user-data based on stack parameters.

## Required Variables for CDK

### Minimal

```typescript
{
  data_availability_role: 'celestia' | 'mock_da',
  switches: 'cdr' | 'dr' | 'r',
}
```

### Recommended

```typescript
{
  rollup_commit_hash: string,
  zkvm_role: 'risc0' | 'mock_zkvm',
  debug: boolean,
  da_start_height: number,
}
```

### Celestia-Specific (if using Celestia DA)

```typescript
celestia: {
  rollup_batch_namespace: string,  // 10 chars
  rollup_proof_namespace: string,  // 10 chars
  celestia_rpc_url: string,
  celestia_grpc_url: string,
  da_rollup_address: string,
  grpcAuthTokenSecretArn: string,  // AWS Secrets Manager
  signerPrivateKeySecretArn: string,
}
```

See `vars/runtime_vars.yaml.template` for complete list.

## Testing

### Test Push Mode (Existing - Still Works)

```bash
ansible-playbook setup.yaml \
    -i 'localhost,' \
    -c local \
    -e data_availability_role=mock_da \
    -e switches=cdr
```

### Test Pull Mode (New)

```bash
# 1. Bootstrap
sudo bash bootstrap.sh

# 2. Create runtime vars
cp vars/runtime_vars.yaml.template vars/runtime_vars.yaml
# Edit vars/runtime_vars.yaml

# 3. Run ansible-pull
sudo ansible-pull \
    -U https://github.com/your-org/sov-rollup-starter-ansible.git \
    -i inventory/localhost.ini \
    -e @vars/runtime_vars.yaml \
    local.yml
```

### Test Locally Without Git

```bash
sudo ansible-playbook local.yml \
    -i inventory/localhost.ini \
    -e @vars/runtime_vars.yaml
```

## Migration Path

### For Existing Deployments

**No migration needed!** Continue using `setup.yaml` as before.

### For New EC2 Deployments

1. **Development**: Test locally with ansible-playbook
2. **Staging**: Test ansible-pull on EC2 instance manually
3. **Production**: Integrate with CDK using `CDK_INTEGRATION.md`

## Documentation

| Document | Audience | Purpose |
|----------|----------|---------|
| **README.md** | Everyone | General overview, push-mode examples |
| **ANSIBLE_PULL.md** | DevOps/SRE | Complete ansible-pull guide |
| **CDK_INTEGRATION.md** | Infrastructure engineers | CDK integration patterns |
| **REFACTORING_SUMMARY.md** | Maintainers | Summary of changes |

## Benefits

### For Development
- ✅ Maintain flexibility with SSH-based deployments
- ✅ Test ansible-pull locally before committing
- ✅ Quick iteration with local ansible-playbook

### For Production
- ✅ Fully automated EC2 deployments
- ✅ No SSH key management
- ✅ Immutable infrastructure patterns
- ✅ Easy CDK/Terraform integration
- ✅ Consistent deployments

### For Portability
- ✅ Still works on Hetzner, bare metal, any Linux
- ✅ Both push and pull modes supported
- ✅ Same playbooks, different execution methods
- ✅ No vendor lock-in

## Security Improvements

1. **No SSH keys** - One less credential to secure
2. **Secrets from AWS Secrets Manager** - Not hardcoded
3. **IAM-based access** - Instance profile for permissions
4. **Audit trail** - CloudWatch logs capture deployment
5. **Immutable** - Instance user-data captured in CloudFormation

## Next Steps

1. **Read the docs**
   - [ANSIBLE_PULL.md](ANSIBLE_PULL.md) - How to use ansible-pull
   - [CDK_INTEGRATION.md](CDK_INTEGRATION.md) - CDK integration

2. **Test locally**
   - Run `bash bootstrap.sh`
   - Create `vars/runtime_vars.yaml`
   - Test with `ansible-pull` or `ansible-playbook local.yml`

3. **Integrate with CDK**
   - Use `cloud-init-userdata.sh.example` as template
   - Set up Secrets Manager for Celestia credentials
   - Deploy test stack

4. **Deploy to production**
   - Validate in staging first
   - Monitor cloud-init logs
   - Verify rollup service starts correctly

## Support

- **Issues**: https://github.com/Sovereign-Labs/sov-rollup-starter-ansible/issues
- **Questions**: Check documentation first, then open an issue
- **Contributions**: PRs welcome!

## Summary

This refactoring successfully adds ansible-pull support while maintaining:
- ✅ 100% backward compatibility
- ✅ Same role structure
- ✅ Same variable system
- ✅ Same deployment outcomes

The only difference is **how** Ansible runs (push vs pull), not **what** it does.
