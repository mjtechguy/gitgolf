# Portable HTTPS edge

The opt-in Caddy overlay terminates TLS for Golf's compiled UI and API. It removes the published Golf HTTP port, retains encrypted-session PostgreSQL persistence, and uses `__Host-golf_session` with Secure, HttpOnly, SameSite=Lax, host-only scope and persistent expiry. Internal CI, health and metrics paths are blocked at this edge; workers continue using their private Golf network namespace. No edge cache or write retries are added. Unknown Host headers receive 421; HTTP redirects use the configured canonical origin.

## Local use

The existing `make dev` HTTP installation is unchanged until this profile is selected. To switch the retained installation:

```sh
cp .env.https.example .env.https
chmod 600 .env.https
make local-https-up
make local-https-status
make local-https-certificate
```

Open `https://localhost:8443`; `http://localhost:8081` redirects there. Golf port 8080 is no longer published in this profile. Use the same enrolled email/password; an HTTP-profile cookie does not become a secure-profile session. Sign in again.

Caddy's internal CA is stored in `caddy-data`. The export command copies only its public root certificate to ignored `.tmp/https/root.crt`. No tool installs trust on the host. Deliberately trust this development CA in your chosen browser/system store if desired, or verify without changing system trust:

```sh
curl --cacert .tmp/https/root.crt -H 'Accept: text/html' https://localhost:8443/
```

Do not bypass certificate validation. Keep the CA private key inside its protected volume; replace/remove any manually installed trust if that CA is rotated or retired. See [Caddy TLS](https://caddyserver.com/docs/caddyfile/directives/tls).

To switch back, stop the selected edge profile before starting HTTP:

```sh
make local-https-stop
make local-up
```

Volumes and private credentials are retained. Use the profile-specific stop/status commands while HTTPS is selected; the core-only `make down` does not manage the edge volumes. Do not remove the CA volume during routine restarts.

## Public-domain configuration and remaining gates

The same overlay can request public certificates by selecting `GOLF_CADDY_TLS_FILE=./deploy/caddy/tls-public.caddy`, using an actual DNS name in `GOLF_HTTPS_HOST`, `GOLF_PUBLIC_URL=https://your-domain.example` (no default-port suffix), ports 443/80 and the intended bind address. The origin URL and published/listening HTTPS port must agree; localhost defaults are 8443/8081. Public ACME issuance/renewal requires suitable DNS and inbound challenge connectivity. Do not put provider tokens into Caddy configuration or enable broad trusted-proxy ranges. The stock image has no Cloudflare DNS challenge plugin.

Only the local internal-CA path is qualified here. Public ACME issuance/renewal, external-proxy origin authentication, Kubernetes ingress, load/HA limits, certificate-volume recovery and OAuth callbacks require separate deployment qualification. The current canonical recovery tool accepts exactly the three-service core and does not back up these edge volumes or the RustFS/worker topology.

This edge publishes Golf UI/API, not native Git HTTPS/SSH. Native operator/Git ports remain loopback-only in Compose; complete public Git routing and Golf-specific write-policy enforcement remain P0.8 gates. Do not expose those backend ports as a shortcut. TLS does not turn the local trusted Docker worker into hostile-tenant isolation.

## Runnable qualification

```sh
make qualify-https
# Uses the running golf-golf-1 image by default. Or select an already-built image:
python3 scripts/https-compose-smoke.py --image golf-recovery-qualified:development
```

The proof uses fresh disposable PostgreSQL/native/Golf/Caddy services, random loopback ports and a supported native fixture identity. It verifies the CA rather than disabling TLS validation; checks real email/password login, cookie flags/persistence, no HTTP cookie transmission, Origin/fetch guards, RPC no-store, blocked internal paths, unknown-host rejection, redirect preservation, backend port removal, sessions and CA identity across backend/edge restarts, and server-side revocation on logout. It removes its containers, network and volumes without changing the retained development installation or host trust.

## Direct coordinator TLS (source increment)

An optional second application listener supplies real TLS request state to machine APIs. Configure `GOLF_INTERNAL_TLS_LISTEN_ADDR`, `GOLF_INTERNAL_TLS_CERT_FILE` and `GOLF_INTERNAL_TLS_KEY_FILE` together. It loads the certificate before database startup and binds all enabled listeners before any start serving. Incomplete settings, invalid files, expired/not-yet-valid certificates and occupied ports fail startup with bounded diagnostics. It requires TLS 1.3 and retains the same application authorization. It does not authenticate a worker by itself, add mutual TLS, or trust a forwarded header as encrypted machine transport.

The optional `deploy/compose/compose.runner-tls.yaml` overlays `compose.yaml` and `deploy/compose/compose.ci.yaml`. Existing server certificate/key and CA files must be supplied; missing bind sources are never created. Its default listener is `127.0.0.1:8443` inside the shared Golf/runner network namespace, and its default runner URL is `https://127.0.0.1:8443`; the server certificate therefore needs that IP SAN. Operator overrides must keep listener, URL, SAN and trust root consistent. The server key is mounted only into Golf, while the runner receives only the CA. No additional host port is published.

The runner CA setting is `GOLF_RUNNER_TLS_CA_FILE`. Its consumer is being implemented with the execution credential broker. Until that runner source and an actual controlled TLS job are qualified, this overlay is prepared configuration, not working secret-bearing CI evidence. Existing loopback HTTP shell CI and Caddy browser HTTPS retain their separate qualifications. Caddy currently forwards plain HTTP to Golf; its public TLS termination does not satisfy a broker gate requiring direct request TLS. No retained local stack has been switched to this listener.
