# Public read-only deployment

The checked-in systemd and Nginx templates publish a read-only research instance at
`https://crossquant.shadowdawn.xyz`. The backend remains bound to `127.0.0.1:17840`.

This deployment intentionally does not install Gate credentials. Nginx blocks credential
management and non-read API operations, while `GCT_PUBLIC_READONLY=1` enforces the same
boundary inside the backend. The only public POST routes are funding-history
queries and the trading-mode acknowledgement required to enter read-only mode. Live mode
cannot be enabled without credentials.

Before enabling authenticated or live use:

1. Put the site behind per-user authentication such as Cloudflare Access.
2. Rotate any API key that has appeared in chat, logs, shell history, or screenshots.
3. Use a dedicated least-privilege Gate APIv4 key without withdrawal permission.
4. Review and intentionally replace the read-only Nginx policy.

The current production-safe deployment should keep these values even after the funding state machine is installed:

```dotenv
GCT_PUBLIC_READONLY=1
GCT_FUNDING_LIVE_ENABLED=0
GCT_FUNDING_MAX_NOTIONAL_PER_LEG_USD=0
GCT_FUNDING_MAX_CONCURRENT_TRADES=0
```

Do not place `GATE_API_KEY` or `GATE_API_SECRET` in systemd unit text or in the repository. The service's credential path must be an owner-only environment file. After deployment, verify migrations, `/health`, authentication redirects, public read-only rejection, and the funding trade list before considering any controlled canary.

Databases larger than 256 MiB do not run SQLite's full-page `quick_check` on the synchronous
startup path, because that scan can saturate the server disk and keep the public endpoint on
502 for minutes. Run `assertDatabaseIntegrity` against a copied database or during an announced
maintenance window instead; migration checksums and the required schema are still validated on
every service start.

The service uses `/home/ubuntu/.local/share/crossquant` for runtime state. Removing the
Nginx site and stopping `crossquant.service` rolls back the deployment without affecting
the existing Crypto-Trader service.
