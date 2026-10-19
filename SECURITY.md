# Security

## Reporting a vulnerability

Please report security issues privately if the repository has private vulnerability
reporting enabled (Settings → Code security → Private vulnerability reporting).
Include the version, the route, and a short description of the impact. Do not
open a public issue for an unfixed vulnerability.

## Supported configuration

- Set `DUMBDROP_PIN` (4-10 digits) whenever the service is reachable beyond localhost.
  Production refuses to start without a PIN unless `ALLOW_INSECURE_NO_PIN=true`.
- Behind a reverse proxy, set `TRUST_PROXY=true` and `TRUSTED_PROXY_IPS` to that
  proxy's address so lockouts and rate limits apply per client.
- Prefer `UPLOAD_ONLY=true` for an internet-facing drop box. Holders of the PIN
  can upload, and list/download/rename/delete/share routes return 404.
- Set `MAX_STORAGE_MB` so a leaked PIN cannot fill the disk.
- Publish the container on loopback, or only on a Docker network shared with the proxy.
