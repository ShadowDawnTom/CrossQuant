# Releasing Gate CrossEx

Prebuilt releases support macOS and Windows on ARM64 and x64. Each archive contains the compiled application, production dependencies, migrations, native modules, license notices, and a private Node.js runtime. End users do not need Node.js or administrator access.

## Before tagging

1. Resolve release blockers and run:

   ```bash
   npm ci --no-audit --no-fund
   npx playwright install chromium
   npm run verify
   npm audit --audit-level=high
   ```

2. Keep the root and workspace versions synchronized and update `package-lock.json`.
3. Confirm `git status --short` is empty and no `.env`, `.local-data`, logs, databases, credentials, build output, or release archives are tracked.
4. Review migration, trading-safety, credential, dependency, and installer changes.
5. Confirm the package version matches the intended tag exactly (`0.1.0` → `v0.1.0`).

Prefer a signed annotated tag when signing is configured; otherwise use an annotated tag:

```bash
git tag -a v0.1.0 -m "Gate CrossEx v0.1.0"
git push origin v0.1.0
```

## Release workflow

A `v*` tag runs `.github/workflows/release.yml`:

1. Verify the complete project on Linux.
2. Build and smoke-test native macOS ARM64/x64 bundles.
3. Build, install, start, health-check, uninstall, and purge native Windows ARM64/x64 bundles.
4. Download the official Node.js runtime and verify Node's published SHA-256 value.
5. Publish these assets with a combined `SHA256SUMS` file:

   ```text
   gate-crossex-darwin-arm64.tar.gz
   gate-crossex-darwin-x64.tar.gz
   gate-crossex-win32-arm64.zip
   gate-crossex-win32-x64.zip
   SHA256SUMS
   ```

A manual workflow run builds temporary downloadable artifacts but does not create a GitHub Release.

## Installer behavior

The recommended source bootstrap scripts (`bootstrap.sh` and `bootstrap.ps1`):

- download a source snapshot without requiring Git;
- download Node.js 24.18.0 for the detected operating system and architecture;
- verify the runtime using Node.js's published SHA-256 manifest;
- install exactly the dependency tree in `package-lock.json` and build the application;
- stage the complete replacement before stopping an existing checkout; and
- preserve `.local-data`, logs, and `.env`, including a verified pre-update database backup.

They install into `~/gate-crossex` by default and do not start the application or register a system service. Users start it explicitly with `./run` or `.\run.ps1`.

The older packaged-release installers (`install.sh` and `install.ps1`) remain available for release validation. They:

- detect architecture and download the matching release asset;
- verify the archive SHA-256 and internal product/platform/version/commit manifest;
- use immutable version directories and an atomic active-version pointer;
- back up the database before an update;
- start the per-user loopback service and run a product health check; and
- roll back activation if the new version fails.

Normal uninstall removes application code and startup integration while preserving the database, credentials, logs, and backups. `--purge` on macOS or `-Purge` on Windows removes the marked installation root completely.

## Signing status

The archives are checksum-verified but are not yet Apple Developer ID signed/notarized or Windows Authenticode-signed. Checksums detect download corruption or asset mismatch; they are not a substitute for platform signing. Do not describe the packages as signed, notarized, or automatically updated.
