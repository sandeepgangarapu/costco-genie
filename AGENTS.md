# Working on Costco Price Matcher

## Help someone set up the app

This is a local macOS CLI for receipt adjustments and unpurchased-item watchlists. Read [README.md](README.md) first. It requires macOS, Google Chrome, Node.js 22.13.0+ with npm (or an existing NVM installation), and Apple Command Line Tools for native dependencies. Apple Mail with an enabled account is the default email transport; a private SMTP file is an alternative.

1. Check prerequisites without printing environment variables or reading private account files.
2. From this checkout, run `./costco setup --no-same-day` for noninteractive setup with no location. If the user has supplied their own location, use `./costco setup --zip YOUR_ZIP --address "YOUR_NEARBY_ADDRESS"`. Add `--email you@example.com` only with the user's chosen recipient. A user running `./costco setup` in Terminal gets an optional settings wizard. Never invent a location or reuse another person's settings.
3. **A signed-in Costco browser session is required for every live check.** Run `./costco login` and let the user sign in themselves in the dedicated Google Chrome window, including MFA or CAPTCHA. Ask them to close that dedicated window when finished. A session in their everyday Chrome profile, a collaborative browser preview, or another agent browser does not satisfy this requirement.
4. The application reuses its own persistent profile at `~/.costco-price-matcher/browser-profile/`. Do not copy cookies, tokens, saved passwords, browser caches, or other Chrome profiles into this checkout. Never ask for a Costco password, MFA code, session token, or cookie in chat. Do not bypass MFA or CAPTCHA.
5. `./costco doctor` and `./costco status` are offline checks. Doctor confirms profile presence, **not** whether Costco authentication is valid. Setup does not log in. An unattended or headless environment cannot complete the initial interactive sign-in: report that prerequisite and leave the login step for the user.
6. A live `./costco run` contacts Costco and can deliver email and local notifications. Run it only when the user has requested a live check or authorized it as part of setup. Review aggregate output; do not paste purchase data or reports into chat. The HTML report is `~/.costco-price-matcher/reports/latest.html`.
7. Install automatic checks with `./costco install-agent` only if the user wants a schedule. One agent: daily watches at 08:00 plus the configured receipt schedule (daily 09:00 by default). Preserve receipt weekday and freshness settings. This creates a per-user macOS LaunchAgent. Do not use sudo. Reinstall the agent after moving the checkout, changing Node, or changing the schedule.

When Costco authentication expires, repeat `./costco login`; never substitute a stored password or an automated login script. Close the dedicated login window before running a check to avoid a profile lock.

## Keep the shared repository private-data free

- All per-user settings belong in `~/.costco-price-matcher/config.json`, outside Git. Use setup options or the interactive wizard; do not edit source defaults for a particular user. `.env` files are ignored but are not loaded by this app.
- Location defaults must remain `null`. Same-Day estimates need both a user-provided ZIP and a nearby address in that ZIP; leave both null to skip. The location is sent to Costco Same-Day to localize estimates. Never substitute an arbitrary ZIP.
- Keep SMTP credentials in an owner-only file outside the checkout, usually `~/.costco-price-matcher/smtp.json`, and reference its absolute path in `smtpConfigPath`. Never put credentials into source, a LaunchAgent, logs, fixtures, or documentation.
- Do not read or publish the user's home data to diagnose routine setup. Browser state, database, reports, logs, raw requests/responses, account identifiers, receipts, order exports, screenshots, and private configuration must stay out of Git. Share the Git repository, rather than a zip of a working folder.
- Test fixtures must be synthetic. `TEST-*` order IDs, receipt barcodes made of leading zeros, `example.com` emails, and addresses on Example Street are examples, not real account data. The public Costco storefront application ID is not a member credential.
- Before sharing changes, inspect `git status --short`, `git diff --check`, `git diff --stat`, and `git ls-files -ci --exclude-standard` (the last should be empty). `.gitignore` does not remove files already tracked. If Gitleaks is available, scan a clean export of the candidate files with `gitleaks dir --redact PATH` and scan history with `gitleaks git --redact --log-opts=--all .`; inspect findings without printing secret values. Synthetic JWTs in diagnostic-redaction tests are intentional.
- Removing a secret from the current tree does not revoke it or remove it from history. Report any real credential exposure without repeating the secret; the owner must revoke/rotate it. Do not rewrite Git history unless asked.

## Development and verification

- Use the existing TypeScript, npm lockfile, Vitest, ESLint, and Prettier workflows. Do not introduce a different JavaScript package manager. If Python is needed for an auxiliary task, use `uv` for its environment and dependencies.
- `./costco help` selects Node through NVM when available, runs `npm ci` if the runtime or lockfile changed, and builds. It does not log in, check Costco, or send email. For direct npm commands, first select a supported Node with matching native dependencies.
- Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm run build` after behavior changes. Keep tests offline: inject the browser, network, notification, mail, and scheduling boundaries. Never run a live Costco check or probe as a substitute for tests.
- Preserve owner-only filesystem permissions and symlink protection. Preserve existing local settings when rerunning setup. Keep warehouse prices, Costco.com prices, and Same-Day estimates separate; an estimate is not a verified warehouse price or an approved adjustment.
- `docs/superpowers/` contains historical design notes. The current code and focused docs below describe shipped behavior. Do not modify historical notes as part of routine changes.

## Watchlist development

- Commands are `./costco watch add|list|remove|history|check`; numeric `add --no-check` is offline, while URLs still need identity resolution. Live watch adds/checks contact Costco and may deliver mail (checks only), so require explicit live authorization. Keep verification offline with injected boundaries.
- Watch data uses additive `watch_*` tables in the existing `costco.sqlite`. Preserve receipt data and test migration from the current schema. No sibling checkout/data/LaunchAgent is needed by the merged app.
- Reuse matcher warehouse display, savings reconciliation, Same-Day client, mail transports, and `run.lock`. Never introduce a duplicate warehouse client. Keep online, verified warehouse, and raw Same-Day lows separate. Watch rate comparisons require matching unit basis; receipt package safeguards remain unchanged.
- `watchWarehouseNumber` defaults to null; never hardcode an owner's warehouse. Watch schedule defaults to 08:00; thresholds and schedules are validated. Baselines are silent, sub-threshold drops accumulate, implausible/conflicting drops remain unverified, and failed mail stays queued.
- Scheduled dispatch checks watches and receipts independently and sequentially under the shared lock. Every profile lifecycle, including watch member-price fallback, must finish before releasing that lock. Only explicit member gates may open the signed-in watch fallback. Dry-run must not write configuration/database/notice state or deliver mail.

## Documentation map

Keep README concise and human-facing. Agent/implementation details belong one level down:

- [Configuration](docs/configuration.md): every setting/default and setup behavior.
- [Price sources](docs/price-sources.md): source precedence, endpoint facts, coupons, units, estimates, and coverage limits.
- [Watchlist](docs/watchlist.md): commands, baselines, new-low rules, plausibility and notices.
- [Scheduling](docs/scheduling.md): one LaunchAgent, independent dispatch, freshness and catch-up.
- [Email](docs/email.md): Apple Mail, SMTP file setup, and retry semantics.
- [Troubleshooting](docs/troubleshooting.md): login, setup, diagnostic and recovery details.
- [Development](docs/development.md): offline gates, storage migration, private data and probes.

## Maintainer workflow

This section applies only to the maintainer's own sessions; other users' agents should ignore it. When the maintainer orchestrates from T3 Code, the orchestrator plans, reviews, and performs account-touching or outward steps. It delegates most implementation and review to **GPT-6.1** subagents at **Extra High** reasoning through T3 `delegate_task`, with `providerInstanceId: "codex"`, `model: "gpt-6.1-sol"`, and `options: { reasoningEffort: "xhigh" }`. Implementation subagents keep live checks, mail, LaunchAgent installation, pushes, and merging with the orchestrator.
