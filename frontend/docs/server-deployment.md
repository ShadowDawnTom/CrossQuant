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

The service uses `/home/ubuntu/.local/share/crossquant` for runtime state. Removing the
Nginx site and stopping `crossquant.service` rolls back the deployment without affecting
the existing Crypto-Trader service.
