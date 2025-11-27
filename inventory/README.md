# Inventory Management

This directory contains Ansible inventory files that define which servers to deploy to.

## Quick Start

```bash
# 1. Copy the example
cp inventory/hosts.ini.example inventory/hosts.ini

# 2. Edit with your server IPs and settings
vi inventory/hosts.ini

# 3. Run playbook with inventory
ansible-playbook setup.yaml -i inventory/hosts.ini --limit production
```

## Inventory Format (INI)

The INI format is simple and easy to maintain:

```ini
# Define hosts
[production]
server-01 ansible_host=1.2.3.4
server-02 ansible_host=5.6.7.8

# Define variables for all hosts in group
[production:vars]
ansible_user=ubuntu
ansible_ssh_private_key_file=~/.ssh/key.pem
da_role=celestia
zkvm_role=risc0
debug=false
```

## Usage Examples

### Deploy to all production servers
```bash
ansible-playbook setup.yaml -i inventory/hosts.ini --limit production
```

### Deploy to specific server
```bash
ansible-playbook setup.yaml -i inventory/hosts.ini --limit rollup-prod-01
```

### Deploy to multiple groups
```bash
ansible-playbook setup.yaml -i inventory/hosts.ini --limit "production,staging"
```

### Run in parallel on multiple servers
```bash
ansible-playbook setup.yaml -i inventory/hosts.ini --limit production --forks 5
```

### Update only rollup (skip common/DA setup)
```bash
ansible-playbook setup.yaml -i inventory/hosts.ini --limit production -e switches=r
```

## Variables Priority

Variables set in inventory files have higher priority than role defaults:

1. **Command line** `-e debug=false` (highest)
2. **Inventory group vars** `[production:vars]`
3. **Inventory host vars** `server-01 ansible_host=1.2.3.4 debug=false`
4. **vars/custom_overrides.yaml**
5. **Role defaults** (lowest)

## Managing Multiple Environments

You can create separate inventory files for each environment:

```bash
inventory/
├── production.ini       # Production servers
├── staging.ini          # Staging servers
├── development.ini      # Dev servers
└── hosts.ini.example    # Template
```

Then use the appropriate inventory:

```bash
# Deploy to production
ansible-playbook setup.yaml -i inventory/production.ini

# Deploy to staging
ansible-playbook setup.yaml -i inventory/staging.ini
```

## Programmatic Generation

The INI format is easy to generate from scripts or infrastructure-as-code tools:

```bash
# Example: Generate from Terraform outputs
terraform output -json instances | jq -r '.value[] |
  "\(.name) ansible_host=\(.public_ip)"' > inventory/generated.ini
```

## Security

- Actual inventory files (*.ini) are gitignored
- Only *.ini.example files are committed
- Never commit files with production IPs or sensitive data
