# proxy role

OpenResty-based reverse proxy in front of a Sovereign rollup. Acts as
an Ansible-driven equivalent to the proxy/observability/discovery parts of
[`ubuntu-evm-starter-script`](https://github.com/Sovereign-Labs/ubuntu-evm-starter-script)
(`setup_proxy_monitoring.sh`, `setup_node_discovery.sh`,
`setup-proxy-helpers.sh`, `conf.d/*`, `nginx-*.conf`).

## What it does

- Installs the apt-package OpenResty.
- Renders nginx config in `/usr/local/openresty/nginx/conf/conf.d/`.
- Optionally obtains a Let's Encrypt cert via certbot (webroot challenge),
  with optional S3 sync of `/etc/letsencrypt/` for zero-downtime replacement.
- Optionally builds and runs the `node-discovery` Rust service so backend
  IPs update automatically on Postgres topology changes.
- Telegraf input scraping `/nginx_status`.
- Optional Alloy log export.
- Daily logrotate of `/var/log/nginx/*.log` (28-day gzipped retention).

## Routing

Implemented in `templates/conf.d/backend-select.lua.j2` (a shared module
required from `proxy-location.conf` and `secure-rpc-locations.conf`):

| Request | Target |
|---|---|
| `POST /sequencer/txs` | leader |
| `GET /sequencer/ready` | leader |
| WebSocket upgrades | leader |
| `POST /rpc` (or `POST /`, which is rewritten to `/rpc`) with `eth_sendRawTransaction*` | leader |
| Everything else | follower (then leader, then static fallback) |

## Key variables (defaults in `defaults/main.yaml`)

- `proxy_rollup_leader_ip` — required; primary node IP (writes).
- `proxy_rollup_follower_ip` — optional; defaults to leader IP.
- `proxy_ssl_enabled`, `proxy_domain_name`, `proxy_certbot_email` — Let's
  Encrypt setup.
- `proxy_unlimited_domains` — additional public domains (covered by the
  cert as SANs; exempt from rate limiting).
- `proxy_cloudflare_real_ip` — set true when behind Cloudflare; trusts
  `CF-Connecting-IP` from the bundled CF edge CIDRs.
- `proxy_api_key_auth_enabled`, `proxy_api_keys`,
  `proxy_secure_domain_names` — when enabled, only `/rpc/<key>` is allowed
  on the secure domains; everything else returns 401. The cert (if SSL is
  on) is extended to cover the secure domains.
- `proxy_node_discovery_enabled` — opt in to dynamic backends.
- `proxy_geoip_enabled` — opt in to GeoIP2 country blocking. When true, the
  role builds `ngx_http_geoip2_module` as a dynamic `.so` against the
  matching OpenResty source, seeds the MaxMind GeoLite2-Country mmdb, and
  installs a daily cron refresh. Requires `proxy_geoip_account_id` and
  `proxy_geoip_license_key`; pair with `proxy_geoip_blocked_countries`
  (list of ISO 3166-1 alpha-2 codes). Public server blocks return 403 for
  blocked countries; API-key-protected (`proxy_secure_domain_names`) blocks
  deliberately bypass GeoIP.

See `defaults/main.yaml` and `vars/runtime_vars.yaml.template` for the
full list.

## Required collections

```sh
ansible-galaxy collection install -r requirements.yml
```

(`community.crypto` is used by `tasks/s3_certs.yaml` for cert SAN
validation.)

## Known gaps vs. the bash repo

The apt-package OpenResty install doesn't include `nginx-module-vts`, so:

- **VTS metrics** are not available. Telegraf scrapes `/nginx_status`
  (stub_status) only, so per-vhost / per-upstream / per-status-code
  metrics aren't exposed. Dashboards built on bash's `nginx_vts` input
  will show empty panels. Adding it would require either a source-build
  path for OpenResty or a separate dynamic-module build like the one
  `tasks/geoip.yaml` does for `ngx_http_geoip2_module`.

GeoIP2 country blocking *is* ported (opt-in via `proxy_geoip_enabled`,
implemented as a dynamic module build — see `tasks/geoip.yaml`).
