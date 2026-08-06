# Credential storage

## Providers

The secure setup page offers two explicit providers:

- **OS keychain (recommended):** macOS Keychain, Windows Credential Manager, or a Linux Secret Service-compatible keyring through `@napi-rs/keyring`.
- **Local `.env`:** a gitignored plaintext fallback with owner-only `0600` permissions. It is never selected automatically when the keychain is available.

One bundle contains only the Gate API key and secret. SQLite stores only the profile label, provider, and verification timestamps—not credentials.

Docker cannot access the host keychain. Its explicit fallback is an owner-only `credentials.env` inside the persistent `gate-crossex-data` volume.

## Secure entry flow

React links to `/secure/credentials` but never renders credential fields. The backend-rendered form has no JavaScript, uses a restrictive content security policy, disables framing and caching, limits request size, and requires a short-lived one-use CSRF token.

On submission, the backend:

1. validates local Host/Origin, CSRF, lengths, and characters;
2. locks trading and quiesces locally tracked orders before replacing credentials;
3. verifies the key with one signed `GET /api/v4/crossex/accounts` request;
4. stores the bundle only after successful verification;
5. writes secret-free metadata and an audit event;
6. rolls back the provider and metadata if a later step fails; and
7. invalidates cached authenticated account state.

Deletion and provider changes use the same lock, order-quiescence, and rollback boundary.

## Limitations

OS keychains protect data at rest but not against malware running as the same logged-in user. `.env` is plaintext; filesystem permissions reduce accidental access but do not provide encryption. JavaScript strings cannot be reliably zeroized, so the backend minimizes credential lifetime and references without claiming memory-forensic resistance.
