# relay-devnet-test — hard-fork rehearsal on Celestia Mocha

Rehearses the first relay-devnet hard fork (multisig upgrade, state_version
0 → 1) on a fresh single-host deployment against **Celestia Mocha**:

| | commit | runs | notes |
|---|---|---|---|
| v0 | `11e17237` | genesis → height 999 | the exact build relay-devnet-01 runs today |
| migration | `rollup-db-migration` (built from v1) | at the boundary | manager invokes it with `--rollup-config-path`; migrates on-disk state 0 → 1 |
| v1 | `45ae5be4` | height 1000 → ∞ | STATE_VERSION = 1 |

The version spec lives at the root of `rollup-starter` branch
`nikolai/relay-devnet-multisig-upgrade` (`versions.yaml` + `version_vars/`);
`params.yaml` here points `rollup_config_repo` at it. Everything else mirrors
relay-devnet-01 (`relay_devnet_params.json`) except the DA network, namespaces
(`relay-tst1`/`relay-tsp1`), `deployment_name`, and no proxy.

## Prerequisites

- Fresh Ubuntu 24.04 host (same class as devnet rollup nodes; needs CPU/disk
  for two cargo builds).
- Mocha celestia-node RPC + consensus gRPC endpoints.
- Celestia account funded on **mocha** (faucet: https://faucet.celestia-mocha.com/).
- `sov-rollup-manager` branch `nikolai/migration-config-arg` pushed to
  GitHub (params pins `rollup_manager_branch` to it). Once merged to master,
  drop that line from `params.yaml`.

## Deploy

```bash
# 1. Bootstrap ansible
curl -fsSL https://raw.githubusercontent.com/Sovereign-Labs/rollup-starter-ansible/nikolai/updates-for-multisig-upgrade/bootstrap.sh | sudo bash

# 2. Clone this repo at the multi-version branch
git clone -b nikolai/updates-for-multisig-upgrade \
  https://github.com/Sovereign-Labs/rollup-starter-ansible.git ~/rollup-starter-ansible
cd ~/rollup-starter-ansible

# 3. Secrets (gitignored; shape in vars/celestia_secrets.yaml.example at repo root)
#    - vars/celestia_secrets.yaml: MOCHA rpc/grpc endpoints + a mocha-funded
#      signer key and its da_rollup_address (NOT the mainnet devnet values!)
#    - vars/monitoring_secrets.yaml: same influxdb_token / grafana_*_token as
#      devnet (RELAY_DEVNET_INFLUX_TOKEN / RELAY_DEVNET_ALLOY_PASSWORD)
$EDITOR vars/celestia_secrets.yaml vars/monitoring_secrets.yaml

# 4. Run (builds v0, v1 and rollup-db-migration, then starts the manager)
sudo ansible-playbook local.yml -i inventory/localhost.ini \
  -e runtime_vars_file=$HOME/rollup-starter-ansible/vars/relay-devnet-test/params.yaml
```

One run builds both versions (v0 with the `cdk-deployment-april-2026` ansible
templates — genesis rendered exactly as devnet's, no `state_version` field —
and v1 + migration with the new branch), renders
`/home/sovereign/rollup-manager-config.json`, and starts `rollup.service`
(the manager). The fork happens unattended at the 999/1000 boundary —
roughly 1h40m after start at ~6s mocha blocks.

## Watch the fork

```bash
# sanity after deploy
cat /home/sovereign/rollup-manager-config.json   # two versions, 999/1000, migration_path -> versions/v1/rollup-db-migration
journalctl -u rollup -f                          # v0 producing blocks

# the boundary, in order:
#   1. v0 logs "Rollup completed at expected stop height" (999) and exits 0
#   2. manager logs "Running migration" with the v1 config path
#   3. rollup-db-migration prints its report (accounts migrated, 0 -> 1)
#   4. v1 starts with --start-at-rollup-height 1000; heights advance past 1000
curl -s http://127.0.0.1:12346/ledger/slots/latest | head -c 300   # height check
```

Failure modes: a non-zero migration exit halts the manager (checkpoint file
keeps the version index; fixing the issue and `systemctl restart rollup`
retries the boundary). v1 refuses to start if on-disk state_version ≠ 1.

## Re-running from scratch

`wipe: false` in params keeps state across re-runs of the playbook. To restart
the rehearsal from genesis add `-e wipe=true` to the command above (wipes
`/mnt/rollup` **and** the manager checkpoint) — never do this against a real
deployment.
