# Security policy

## Supported versions

Security fixes are applied to the latest release and the current `main` branch. Older source snapshots may not receive backports.

## Reporting a vulnerability

Do not open a public issue containing an exploit, API credential, account identifier, trading history, unredacted log, or database.

Use GitHub's private vulnerability reporting for this repository from the **Security** tab. If private reporting is unavailable, open a minimal public issue asking the maintainer for a private contact channel; include no sensitive or exploit details in that issue.

Please include the affected commit/version, operating system, impact, reproduction prerequisites, and a minimal proof of concept using fake credentials and fake gateways. State whether the issue can place or cancel orders, expose credentials, bypass the loopback boundary, or corrupt reconciliation state.

You should receive an acknowledgement within seven days. Disclosure timing will be coordinated after the issue is reproduced and a fix is available.

## Scope reminders

Gate's exchange infrastructure and APIs are outside this project's security boundary and should be reported through Gate's own security program. This project has no hosted service, telemetry backend, user-account system, or maintainer-operated API.
