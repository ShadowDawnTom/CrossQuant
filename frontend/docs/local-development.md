# Local development

## Requirements and startup

The README bootstrap installs a private Node.js runtime and dependencies for normal local use. Contributors who clone the repository manually should use Node.js 20.19+, 22.13+, or 24 with npm, then run the launcher; it installs the lockfile-pinned dependencies when needed.

```bash
./run          # production build on macOS/Linux
./run dev      # hot reload on macOS/Linux
```

```powershell
.\run.ps1      # production build on Windows
.\run.ps1 dev  # hot reload on Windows
```

The launcher prefers `.runtime`, when present, over a system Node.js installation. It verifies dependency state against `package-lock.json`, builds the workspaces, applies checksummed migrations, selects an available loopback port, waits for health, and opens the UI. Production normally starts at `http://127.0.0.1:17840`.

Docker is an optional local-only path:

```bash
docker compose up --build
```

The container publishes loopback only and stores data in the `gate-crossex-data` volume. It cannot use the host OS keychain.

## Verification

```bash
npm ci --no-audit --no-fund
npx playwright install chromium
npm run verify
npm audit --audit-level=high
```

Tests use temporary databases, an in-memory credential vault, and fake gateways. They must never read local credentials or submit authenticated exchange requests.

## Local files

```text
.local-data/config.json          Selected ports and non-secret preferences
.local-data/runtime.json         Recorded process ownership
.local-data/gate-crossex.sqlite  Local database
.local-data/backend.lock         Single-backend lock
.local-data/dependencies.sha256  Lockfile used for the installed dependency tree
.runtime/                        Bootstrap-managed private Node.js runtime
logs/backend.log                 Backend log
logs/frontend.log                Development frontend log
```

These paths and `.env` are ignored by Git. Never share credentials, account identifiers, trading history, databases, or unredacted logs.

## Launcher commands

```text
./run                 Build and start
./run dev             Start hot reload
./run doctor          Print sanitized diagnostics
./run stop            Stop recorded local processes
./run logs            Print bounded recent logs
./run update          Back up, refresh source/runtime/dependencies, and build
./run backup [path]   Create and verify a SQLite backup
./run restore <path>  Validate and restore a backup
./run maintenance     Checkpoint, optimize, vacuum, and verify
./run reset           Delete local state after explicit confirmation
```

Use the corresponding `.\run.ps1` commands on Windows.

For bootstrap-managed source snapshots, `update` stages and validates a fresh source tree before activation and preserves `.local-data`, logs, and `.env`. For a normal Git checkout, it retains the fast-forward-only `git pull` workflow.

## Development rules

- Add new migrations; never edit a migration that may already have been released. Startup rejects checksum changes.
- Keep exchange fixtures synthetic and secret-free.
- Use the secure setup page for manual Gate testing and a dedicated least-privilege APIv4 key. Never grant withdrawal permission.
- Every backend start is trading-locked; enabling live mode is session-only.
- Keep the service on loopback. Do not expose it with `GCT_HOST=0.0.0.0`.

## Troubleshooting

- Run `./run doctor`, then `./run stop` and `./run`.
- If dependency installation fails, remove only `node_modules` and rerun; do not delete `.local-data`.
- Let the launcher choose another loopback port when the preferred port is occupied.
- Review `./run logs` locally and redact private trading data before sharing any excerpt.
