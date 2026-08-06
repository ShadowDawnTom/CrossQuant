# Threat model

Primary assets are Gate API credentials, order intent, reconciled exchange state, local strategy state, audit integrity, and user privacy.

| Threat | Primary controls |
| --- | --- |
| Credential theft | OS keychain by default; explicit owner-only `.env` fallback; script-free credential form; secrets excluded from React, SQLite, and logs |
| Malicious local webpage or DNS rebinding | Loopback binding, Host/Origin validation, CSRF tokens, and intent headers |
| XSS or untrusted upstream data | Restrictive credential-page CSP, React isolation, and runtime validation of exchange responses |
| Dependency compromise | Committed lockfile, constrained install scripts, pinned release actions, CI tests, and dependency audit |
| Stale, replayed, or ambiguous exchange state | Timestamps, freshness checks, WebSocket recovery, REST reconciliation, persisted unresolved states, and terminal-state confirmation |
| Unsafe strategy exposure | Fresh-quote requirements, acknowledged-fill accounting, bounded hedge recovery, and pause-on-failure behavior |
| Database corruption | Checksummed migrations, integrity-checked backup/restore, WAL checkpoints, and preservation before restore/update |
| Log or diagnostic leakage | Structured redaction, bounded logs, and explicit user guidance before sharing diagnostics |
| Compromised release download | SHA-256 and manifest verification, immutable version directories, activation health check, and rollback |
| Docker exposure | Loopback-only publication, non-root user, read-only root filesystem, dropped capabilities, and persistent data volume |

The application protects a single local user boundary. It cannot protect against malware or an attacker already operating as the same logged-in OS user, a compromised exchange, or a user granting excessive API permissions. Prebuilt archives are not yet Apple-notarized or Windows Authenticode-signed.
