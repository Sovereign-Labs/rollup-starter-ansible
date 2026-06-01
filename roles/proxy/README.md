# proxy role

OpenResty-based reverse proxy in front of a Sovereign rollup. Replaces the
proxy / observability / node-discovery surface of
[`ubuntu-evm-starter-script`](https://github.com/Sovereign-Labs/ubuntu-evm-starter-script).

## What it does

- Installs the apt-package OpenResty.
- Renders nginx config under `/usr/local/openresty/nginx/conf/`.
- Optionally obtains a Let's Encrypt cert via certbot (webroot challenge),
  with optional S3 backup of `/etc/letsencrypt/` (as a tarball) for
  zero-downtime replacement.
- Optionally builds dynamic `.so` modules (VTS metrics, GeoIP2 country blocking).
- Optionally builds and runs the `node-discovery` Rust service for automatic
  backend updates on Postgres topology changes.
- Telegraf input + optional Alloy log export + hourly-checked, size-capped (1G) logrotate.

## Routing

Implemented in `templates/conf.d/backend-select.lua.j2` (required from
`proxy-location.conf` and `secure-rpc-locations.conf`):

| Request | Target |
|---|---|
| `POST /sequencer/txs` | leader |
| `GET /sequencer/ready` | leader |
| WebSocket upgrades | leader |
| `POST /rpc` (or `POST /`, rewritten to `/rpc`) with `eth_sendRawTransaction*` | leader |
| Everything else | follower → leader → static fallback |

## Domains

Two peer lists; each hostname appears in exactly one. Either may be empty;
at least one must be non-empty when `proxy_ssl_enabled` is true.

| Variable | Rate-limited? | API key required? |
|---|---|---|
| `proxy_public_domains` | yes | no |
| `proxy_unlimited_domains` | no (host-exempt) | yes — `/rpc/<api_key>` only; other paths 401 |

A **single** multi-SAN Let's Encrypt cert covers
`proxy_public_domains + proxy_unlimited_domains`, stored under
`/etc/letsencrypt/live/<first-domain>/`. The role asserts:

- `proxy_unlimited_domains` and `proxy_api_keys` are both empty or both non-empty.
- The two lists do not overlap (nginx would silently drop one server block).

### Pitfalls

- **List order picks the cert directory.** Reordering renames it on the next
  certbot run, so the next replacement re-issues via certbot once. The S3 backup
  is a single fixed-key tarball, so nothing is orphaned — the restored bundle's
  directory name just no longer matches and is rebuilt.
- **`proxy_unlimited_domains` is rate-exempt by `Host`** — valid API-key
  traffic is unmetered; failed-auth attempts remain per-IP throttled.
- **Only-unlimited deployments expose no anonymous endpoint.** With
  `proxy_public_domains` empty, no `server_name _;` catch-all is rendered, so
  raw-IP / unmatched-`Host` requests fall through to the secure server and get
  401 — the backend is never reachable without an API key.

## Key variables

See `defaults/main.yaml` and `vars/runtime_vars.yaml.template` for the full list.

- `proxy_rollup_leader_ip` — required.
- `proxy_rollup_follower_ip` — optional; defaults to leader.
- `proxy_cloudflare_real_ip` — trust `CF-Connecting-IP` from CF edge CIDRs.
- `proxy_rate_limit_*` — global rate limit knobs.
- `proxy_cert_s3_bucket` + `proxy_cert_s3_region` — optional S3 cert backup
  (tarball at the bucket root, key `proxy_cert_s3_key`).
- `proxy_require_https_ready` — when SSL is on, fail the play if no valid cert
  came up (defaults to `proxy_ssl_enabled`) rather than silently serving HTTP.
  Set `false` for the first bootstrap run (DNS not yet pointed at the host).
- `proxy_node_discovery_enabled` — opt in to dynamic backends (Rust service).
- `proxy_vts_enabled` — opt in to per-vhost / per-upstream metrics (~5–10 min
  source build on first deploy).
- `proxy_geoip_enabled` — opt in to GeoIP2 country blocking; requires
  MaxMind credentials and `proxy_geoip_blocked_countries`.

## Required collections

```sh
ansible-galaxy collection install -r requirements.yml
```

`community.crypto` is used for cert SAN validation. `community.postgresql` is
required by the rollup role when it provisions PostgreSQL locally.
