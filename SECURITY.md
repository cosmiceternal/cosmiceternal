# Security Policy

## Scope and nature of this project

Crypt Casino is a **play-money** application. Balances are fun credits with no
monetary value, there is no real-money wagering, and the default configuration
settles deposits and withdrawals in a simulated play-money processor. Please
keep this in mind when assessing impact.

## Reporting a vulnerability

Please report suspected security issues **privately** — do not open a public
issue, pull request, or discussion for them.

Use GitHub's private vulnerability reporting for this repository:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected endpoint or file, and the steps to
   reproduce it.

If private reporting is not available to you, open a minimal public issue that
says only that you have a security report and asks for a private contact — do
not include details, a proof of concept, or affected endpoints in the public
issue.

Please give a reasonable window to investigate and fix before any public
disclosure.

## What to include

A good report usually has:

- the affected URL / endpoint / file,
- a clear description of the vulnerability class (e.g. XSS, auth bypass,
  injection),
- concrete reproduction steps or a small proof of concept,
- the impact you believe it has.

## Out of scope

The following are generally **not** treated as reportable vulnerabilities here:

- Denial-of-service / resource-exhaustion reports (the app is rate-limited per
  IP; please do not run load or stress tests against a live instance).
- Missing security hardening that has no demonstrated exploit (e.g. "header X
  could also be set").
- Reports that depend on controlling server environment variables, the host,
  or the deployment itself.
- Findings in third-party dependencies that are already tracked by `npm audit`
  — these are updated separately.
- Anything that requires a user to already be compromised (malware on their
  device, a stolen unlocked session on their own machine, etc.).

## Good-faith research

We support good-faith security research. Please do not access, modify, or
exfiltrate other users' data; do not degrade the service for others; and only
test against your own accounts.
