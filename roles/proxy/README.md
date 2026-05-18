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

## Domain configuration

The proxy classifies every hostname it serves into one of three peer lists.
There is no "primary" domain — any combination of non-empty lists is valid,
and the lists drive every domain-aware behavior in the role (server blocks,
SSL cert SANs, rate limiting, API-key auth).

| Variable | Public? | Rate-limited? | API key required? | Notes |
|---|---|---|---|---|
| `proxy_public_domains` | yes | yes | no | The "normal" RPC entry points. |
| `proxy_unlimited_domains` | yes | no (exempt by `$host`) | no | For partners/integrations that should bypass the global rate limit. |
| `proxy_secure_domains` | yes (TLS) | yes | yes | Only `/rpc/<api_key>` is allowed; every other path returns 401. Requires `proxy_api_key_auth_enabled: true` and a non-empty `proxy_api_keys`. |

### TLS / Let's Encrypt

- Set `proxy_ssl_enabled: true` and `proxy_certbot_email` to obtain a
  Let's Encrypt cert via the webroot challenge.
- With SSL on, **at least one** of the three lists must be non-empty.
- A **single** multi-SAN certificate is issued. It covers every domain
  in `proxy_public_domains + proxy_unlimited_domains`, plus
  `proxy_secure_domains` when `proxy_api_key_auth_enabled` is on.
- The cert lives in `/etc/letsencrypt/live/<first-domain>/`, where
  `<first-domain>` is the first entry across the concatenation
  `proxy_public_domains + proxy_unlimited_domains + proxy_secure_domains`.
  Reordering the YAML lists therefore renames the cert directory on the
  next certbot run — see the pitfall below.
- Optional zero-downtime cert reuse: set `proxy_cert_s3_bucket` (with
  `proxy_cert_s3_region`) and the role syncs `/etc/letsencrypt/` to/from
  S3 around certbot. Replacement instances skip certbot and boot straight
  into HTTPS.

### Use cases

Every row below is a valid configuration. The Public/Unlimited/Secure
columns show the lists; `cert dir` is `/etc/letsencrypt/live/<...>/`;
`SANs` is the set of domains on that one cert. Everyone in `SANs` is
served over HTTPS.

| Public | Unlimited | Secure | API auth | What you get |
|---|---|---|---|---|
| `[api]` | `[]` | `[]` | off | One public block on `api` (cert dir `live/api/`, SANs `{api}`). The classic single-domain rollup. |
| `[api]` | `[partner]` | `[]` | off | Public block serves both `api` and `partner`; `partner` is exempt from the global rate limit. SANs `{api, partner}`. |
| `[]` | `[partner]` | `[]` | off | Only unlimited domains: useful when the public RPC is fronted by Cloudflare and you only point this proxy at integration domains. Cert dir `live/partner/`. |
| `[]` | `[]` | `[secure]` | on | Only the API-key-gated block: `https://secure/rpc/<key>` works, everything else 401s. Cert dir `live/secure/`. |
| `[]` | `[partner]` | `[secure]` | on | Mixed: public exempt domain plus a key-gated domain, no plain public surface. Single cert covers both. |
| `[api]` | `[partner]` | `[secure]` | on | Full surface: rate-limited public, exempt public, and key-gated. SANs `{api, partner, secure}`. |

### Pitfalls

- **No domain overlaps across lists.** A hostname listed in two lists
  causes two nginx `server` blocks to claim the same `server_name`. nginx
  matches the first and silently drops the rest, so the stricter block
  (rate limit, API-key) is bypassed. The role asserts pairwise
  disjointness for all three lists at play start and refuses to run.
- **`proxy_secure_domains` without API-key auth is rejected.** Without
  `proxy_api_key_auth_enabled: true`, the secure server block is not
  rendered and secure domains are excluded from the cert. The role
  fails fast rather than silently dropping the entries.
- **List order determines the cert directory.** The cert lives at
  `/etc/letsencrypt/live/<first-domain>/`, where "first" walks
  `public → unlimited → secure`. Renaming the first domain — or moving
  it to a different list — causes certbot to create a new directory at
  the next renewal and leave the old one orphaned. If you sync certs via
  `proxy_cert_s3_bucket`, the old S3 prefix is also orphaned until you
  prune it manually.
- **`proxy_unlimited_domains` exempts by `Host` header.** The rate-limit
  bypass keys on `$host`, so any client hitting that hostname bypasses
  the global limit regardless of source IP. Don't put a domain there
  unless you actually want it unmetered.
- **HTTP-only mode (`proxy_ssl_enabled: false`).** The role still listens
  on port 80 and serves the public + secure (when API auth is on)
  server blocks, but with no certbot run. Useful for internal proxies
  or development.

## Other key variables (defaults in `defaults/main.yaml`)

- `proxy_rollup_leader_ip` — required; primary node IP (writes).
- `proxy_rollup_follower_ip` — optional; defaults to leader IP.
- `proxy_cloudflare_real_ip` — set true when behind Cloudflare; trusts
  `CF-Connecting-IP` from the bundled CF edge CIDRs so `$remote_addr`
  (and therefore rate limiting + access logs) reflect the real client IP.
- `proxy_rate_limit_enabled`, `proxy_rate_limit_rate`,
  `proxy_rate_limit_burst`, `proxy_rate_limit_exempt_ips` — global rate
  limit knobs; `proxy_unlimited_domains` are exempt by hostname,
  `proxy_rate_limit_exempt_ips` are exempt by source IP.
- `proxy_node_discovery_enabled` — opt in to dynamic backends.
- `proxy_geoip_enabled` — opt in to GeoIP2 country blocking. When true, the
  role builds `ngx_http_geoip2_module` as a dynamic `.so` against the
  matching OpenResty source, seeds the MaxMind GeoLite2-Country mmdb, and
  installs a daily refresh helper (`/usr/local/bin/update-geoip-dbs.sh`)
  invoked from cron. Requires
  `proxy_geoip_account_id` and `proxy_geoip_license_key`; pair with
  `proxy_geoip_blocked_countries` (list of ISO 3166-1 alpha-2 codes).
  Blocked countries get a 403 on every server block — both public and the
  API-key-protected `proxy_secure_domains` blocks — short-circuited
  before authentication.

See `defaults/main.yaml` and `vars/runtime_vars.yaml.template` for the
full list.

## Required collections

```sh
ansible-galaxy collection install -r requirements.yml
```

(`community.crypto` is used by `tasks/s3_certs.yaml` for cert SAN
validation; `community.postgresql` is also required by the rollup role when
it provisions the local PostgreSQL instance.)

## Dynamic-module builds

The apt-package OpenResty install can't be relinked, so anything the bash
repo statically linked is ported as a dynamic `.so` built once per host:

- **VTS** (`nginx-module-vts`) — built by `tasks/vts.yaml`. Powers
  Telegraf's `inputs.nginx_vts` (per-vhost / per-upstream /
  per-status-code metrics). Defaults on; toggle with `proxy_vts_enabled`.
- **GeoIP2** (`ngx_http_geoip2_module`) — built by `tasks/geoip.yaml`.
  Defaults off (requires MaxMind creds); toggle with `proxy_geoip_enabled`.
