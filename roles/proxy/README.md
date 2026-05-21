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

The proxy classifies every hostname it serves into one of two peer lists,
matching the CDK parameters of the same names. Either list can be empty;
at least one must be non-empty when `proxy_ssl_enabled` is true. The lists
drive every domain-aware behavior in the role (server blocks, SSL cert
SANs, rate limiting, API-key auth).

| Variable | Rate-limited? | API key required? | Notes |
|---|---|---|---|
| `proxy_public_domains` | yes | no | The "normal" RPC entry points. Maps to CDK `DomainName`. |
| `proxy_unlimited_domains` | no (exempt by `$host`) | yes | Only `/rpc/<api_key>` is allowed; every other path returns 401. Non-empty requires a non-empty `proxy_api_keys` (asserted at play start). Maps to CDK `UnlimitedDomainNames`. |

If you need a rate-limit bypass without API-key auth (e.g. a partner
domain fronted by your own CDN), use `proxy_rate_limit_exempt_ips` (IP
allowlist) or terminate at the CDN. The role no longer ships an
"exempt-without-auth" tier — that combination existed only briefly during
porting and was removed for parity with the CDK and the upstream
`ubuntu-evm-starter-script`.

### TLS / Let's Encrypt

- Set `proxy_ssl_enabled: true` and `proxy_certbot_email` to obtain a
  Let's Encrypt cert via the webroot challenge.
- With SSL on, **at least one** of the two lists must be non-empty.
- A **single** multi-SAN certificate is issued covering
  `proxy_public_domains + proxy_unlimited_domains`.
- The cert lives in `/etc/letsencrypt/live/<first-domain>/`, where
  `<first-domain>` is the first entry across the concatenation
  `proxy_public_domains + proxy_unlimited_domains` (public list wins if
  non-empty). Reordering the YAML lists therefore renames the cert
  directory on the next certbot run — see the pitfall below.
- Optional zero-downtime cert reuse: set `proxy_cert_s3_bucket` (with
  `proxy_cert_s3_region`) and the role syncs `/etc/letsencrypt/` to/from
  S3 around certbot. Replacement instances skip certbot and boot straight
  into HTTPS.

### Use cases

Every row below is a valid configuration. `cert dir` is
`/etc/letsencrypt/live/<...>/`; `SANs` is the set of domains on that one
cert. Everyone in `SANs` is served over HTTPS.

| Public | Unlimited | API keys | What you get |
|---|---|---|---|
| `[api]` | `[]` | `[]` | One public block on `api` (cert dir `live/api/`, SANs `{api}`). The classic single-domain rollup. |
| `[]` | `[unlimited]` | `[k1]` | Only the API-key-gated block: `https://unlimited/rpc/k1` works, everything else 401s. Cert dir `live/unlimited/`, SANs `{unlimited}`. |
| `[api]` | `[unlimited]` | `[k1]` | Full surface: rate-limited public and rate-exempt key-gated. Cert dir `live/api/`, SANs `{api, unlimited}`. |

### Pitfalls

- **No domain overlaps across lists.** A hostname listed in both lists
  causes two nginx `server` blocks to claim the same `server_name`. nginx
  matches the first and silently drops the rest, so the API-key-gated
  block is bypassed. The role asserts disjointness at play start and
  refuses to run.
- **`proxy_unlimited_domains` requires `proxy_api_keys`, and vice versa.**
  Either both are non-empty or both are empty. The role asserts the
  bi-implication at play start — there is no "unlimited but
  unauthenticated" or "API keys without a host to consume them" tier.
- **List order determines the cert directory.** The cert lives at
  `/etc/letsencrypt/live/<first-domain>/`, where "first" walks
  `public → unlimited`. Renaming the first domain — or moving it to a
  different list — causes certbot to create a new directory at the next
  renewal and leave the old one orphaned. If you sync certs via
  `proxy_cert_s3_bucket`, the old S3 prefix is also orphaned until you
  prune it manually.
- **`proxy_unlimited_domains` exempts the global rate limit by `Host`.**
  Any client hitting that hostname bypasses the global limit regardless
  of source IP (failed-auth attempts are still per-IP throttled). Don't
  put a domain there unless you actually want it unmetered for valid
  API-key holders.
- **HTTP-only mode (`proxy_ssl_enabled: false`).** The role still listens
  on port 80 and serves the same server blocks, but with no certbot run.
  Useful for internal proxies or development.

## Other key variables (defaults in `defaults/main.yaml`)

- `proxy_rollup_leader_ip` — required; primary node IP (writes).
- `proxy_rollup_follower_ip` — optional; defaults to leader IP.
- `proxy_cloudflare_real_ip` — set true when behind Cloudflare; trusts
  `CF-Connecting-IP` from the bundled CF edge CIDRs so `$remote_addr`
  (and therefore rate limiting + access logs) reflect the real client IP.
- `proxy_rate_limit_enabled`, `proxy_rate_limit_rate`,
  `proxy_rate_limit_burst`, `proxy_rate_limit_exempt_ips` — global rate
  limit knobs. `proxy_unlimited_domains` hosts are exempt by `Host` header
  (and require API-key auth); `proxy_rate_limit_exempt_ips` are exempt by
  source IP (no auth requirement).
- `proxy_node_discovery_enabled` — opt in to dynamic backends.
- `proxy_geoip_enabled` — opt in to GeoIP2 country blocking. When true, the
  role builds `ngx_http_geoip2_module` as a dynamic `.so` against the
  matching OpenResty source, seeds the MaxMind GeoLite2-Country mmdb, and
  installs a daily refresh helper (`/usr/local/bin/update-geoip-dbs.sh`)
  invoked from cron. Requires
  `proxy_geoip_account_id` and `proxy_geoip_license_key`; pair with
  `proxy_geoip_blocked_countries` (list of ISO 3166-1 alpha-2 codes).
  Blocked countries get a 403 on every server block — both
  `proxy_public_domains` and the API-key-protected
  `proxy_unlimited_domains` blocks — short-circuited before authentication.

See `defaults/main.yaml` and `vars/runtime_vars.yaml.template` for the
full list.

## Migration from ubuntu-evm-starter-script

The role replaces the proxy + observability + node-discovery surface of
[`ubuntu-evm-starter-script`](https://github.com/Sovereign-Labs/ubuntu-evm-starter-script)
— specifically `setup_proxy_monitoring.sh`, `setup_node_discovery.sh`,
`setup-proxy-helpers.sh`, the `conf.d/*` and `nginx-*.conf` templates, and
the `try_restore_certs` / S3 backup helpers. Schema-wise the role is a strict
superset of the shell starter: every shell variable maps to one or more
ansible vars, and the role adds capabilities the shell starter never had
(see "What's new in the ansible role" below).

### Variable mapping

| Shell variable | Ansible variable | Notes |
|---|---|---|
| `DOMAIN_NAME` | `proxy_public_domains[0]` | Shell accepted a single value; the role takes a list. Migrate single → one-element list. |
| `SECURE_DOMAIN_NAMES` (CSV) | `proxy_unlimited_domains` (YAML list) | Split on comma. Same combined semantics: rate-exempt by Host AND only `/rpc/<api_key>` honored. Pair with a non-empty `proxy_api_keys` — the role asserts the bi-implication at play start. |
| `API_KEYS` (CSV) | `proxy_api_keys` (YAML list) | Split on comma. Required iff `proxy_unlimited_domains` is non-empty. |
| `PROXY_GEO_IP_IGNORE_IPS` (CSV) | `proxy_rate_limit_exempt_ips` (YAML list) | Despite the shell name, these are rate-limit exemptions, not GeoIP. |
| `GEOIP_BLOCKED_COUNTRIES` (CSV) | `proxy_geoip_blocked_countries` (YAML list) | ISO 3166-1 alpha-2 codes. Empty list = block nothing. |
| `GEOIP_ACCOUNT` | `proxy_geoip_account_id` | MaxMind account ID. Required when `proxy_geoip_enabled: true`. |
| `GEOIP_LICENSE` | `proxy_geoip_license_key` | MaxMind license key. Required when `proxy_geoip_enabled: true`. |
| (GeoIP toggle: presence of `GEOIP_ACCOUNT`+`GEOIP_LICENSE`) | `proxy_geoip_enabled` | Explicit boolean; required by the role even when creds are set. |
| `CERT_BUCKET_NAME` | `proxy_cert_s3_bucket` | Empty disables S3 sync. Role uses per-file `aws s3 sync` (vs the shell's single `letsencrypt.tar.gz` tarball) — with a one-shot migration step that ingests an existing tarball on first run. |
| `REGION` (for S3 cert ops) | `proxy_cert_s3_region` | Required when `proxy_cert_s3_bucket` is set; the role asserts. |
| `ROLLUP_LEADER_IP` | `proxy_rollup_leader_ip` | Required unless `proxy_node_discovery_enabled: true`. |
| `ROLLUP_FOLLOWER_IP` | `proxy_rollup_follower_ip` | Defaults to leader IP when empty. |
| `NGINX_BASE_URL` | n/a | Templates ship inside the role; no remote fetch. |
| `STACK_NAME` (ASG lookup) | n/a | Backend IPs come pre-resolved (`proxy_rollup_*_ip`) or from node-discovery via Postgres — no in-role AWS API calls. |
| `DB_SECRET_ARN` / `DB_HOST` / `DB_PORT` / `DB_NAME` | `rollup_sequencer_postgres_connection_string` + `proxy_node_discovery_enabled: true` | node-discovery consumes the rollup role's shared Postgres connection string. CDK assembles the URL once and passes it in `runtime_vars.yaml`. |
| `MONITORING_URL` | `influxdb_remote_url` | Set in `runtime_vars.yaml`; defaults are in `roles/common/defaults/main.yaml`. |
| `INFLUX_TOKEN` | `influxdb_token` | Same. Required for output. |
| `INFLUX_ORG` | `influxdb_org` | Same. |
| `INFLUX_BUCKET` | `influxdb_bucket` | Same. |
| (secondary InfluxDB outputs, shell N/A) | `influxdb_secondary_outputs` / `influxdb_secondary_tokens` | Multi-destination mirroring the shell never supported. |
| `INSTANCE_ID` | n/a (telegraf auto-populates `host` tag) | Not set explicitly; telegraf uses the instance hostname. |
| `DEPLOYMENT_NAME` | `deployment_name` | Top-level runtime var; flows into telegraf global tags. |
| (cloudflare front, shell always on) | `proxy_cloudflare_real_ip` (default `false`) | Opt-in in the role. Set to `true` when the proxy sits behind Cloudflare; CIDRs live in `roles/proxy/vars/main.yaml`. |
| (DNS resolver, shell hardcodes AWS VPC DNS) | `proxy_dns_resolver` (default empty) | Set to `"169.254.169.253"` on AWS to match shell behavior. |
| (logs export, shell N/A) | `proxy_enable_logs_export` | Opt-in Alloy → Grafana Loki shipping. |

### What's new in the ansible role

These behaviors have no equivalent in `ubuntu-evm-starter-script`; the role
adds them by design and keeps them through this migration.

- **API-key URI redaction in the access log** — the `$logged_request_uri`
  map rewrites `/rpc/<key>` to `/rpc/[redacted]` so secrets don't land in
  log files. Shell logs the raw URI.
- **GeoIP block applied on the API-key-protected block too** —
  defense-in-depth, the shell starter only blocked geo on the public block.
- **Per-file S3 cert sync with SAN-coverage validation** — restores reject
  certs that don't cover every current SAN, in addition to expiry checks.
  Shell only checked expiry.
- **Legacy tarball migration** — the role auto-ingests an existing
  `letsencrypt.tar.gz` from the same bucket on first run, then writes back
  in per-file layout.
- **Extra backend fallback layers** in `backend-select.lua` (follower_1 →
  follower → leader → template-baked static fallback) instead of returning
  503 when the cache is empty.
- **`/nginx_status` (stub_status)** on `127.0.0.1` in the HTTP redirect
  block, for local debugging / fallback telegraf scrape if VTS is off.

### Out-of-scope deviations (deferred to follow-up)

Two shell-starter behaviors are deliberately **not** ported in this PR
because adopting either changes which `server` block answers unmatched SNI
and warrants a separate review:

- `listen 443 ssl default_server;` on the public HTTPS block.
- `_` catchall token in the secure block's `server_name`.

### CDK-side handoff

[`sov-rollup-cdk-starter`](https://github.com/Sovereign-Labs/sov-rollup-cdk-starter)'s
proxy user-data already wires every variable in the table above into
`runtime_vars.yaml` before invoking `ansible-pull`, so existing CDK
deployments need no schema change as a result of this PR. The mapping above
is what an operator porting a hand-rolled `ubuntu-evm-starter-script`
deployment to the ansible role would use directly.

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
