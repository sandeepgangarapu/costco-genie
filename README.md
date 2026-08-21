# Costco Price Matcher

Costco Price Matcher is a personal, local macOS tool that looks for **potential** price adjustments on recent Costco warehouse purchases. It imports receipts from an authenticated Costco session, checks exact item numbers against the current price reported for the original warehouse, and sends deduplicated alerts through Notification Center and Apple Mail.

This project is unofficial and is not affiliated with, endorsed by, or supported by Costco. It uses undocumented Costco APIs that can change or stop working without notice. Automated access may be restricted by Costco's terms or account policies; review the applicable terms and use the tool conservatively at your own risk. A match is not proof of eligibility—always verify the item, current price, purchase date, and adjustment policy with the original warehouse.

## Requirements

- macOS with Apple Mail configured with at least one enabled account
- Node.js 22.13.0 or newer
- Google Chrome, used by Playwright for a dedicated Costco login profile
- Xcode Command Line Tools or a compatible native build environment if npm must compile `fs-ext`

## Install and set up

```sh
npm ci
npm run build
npm link
costco setup
costco login
```

`costco setup` creates the local configuration, database, browser-profile, and log directories. `costco login` opens a dedicated Chrome profile. Sign in manually, including any MFA or CAPTCHA, and then close that browser window. The tool never accepts or stores your Costco password. Do not use the profile for general browsing.

Run a readiness check after login:

```sh
costco doctor
```

Doctor is offline and read-only. It checks macOS and Node compatibility, existing data-directory access, the existing database in read-only mode, lock-path readiness, Apple Mail application presence, and whether the dedicated browser-profile directory is present. It does not launch or script Mail, verify Mail accounts or Automation permission, create application paths, create or migrate a database, create a lock file, launch Chrome, contact Costco, or send a notification or email. Mail account and Automation readiness are verified only on the first real alert delivery. A live Costco session is verified only by `costco run` or by completing `costco login`.

## Run manually

```sh
costco run
costco status
```

`costco run` performs a live receipt and price check and may send alerts. `costco status` shows the local paths and last successful run without contacting Costco or sending anything.

Receipt requests and each sequential price batch have a conservative 30-second deadline, and noninteractive helper commands use the same bound. Manual `costco login` browser interaction is intentionally not given this short deadline.

Useful run exit codes are:

- `0`: success, or a fresh scheduled run was skipped
- `1`: failed
- `2`: partial failure, such as an unresolved price batch or notification-channel error
- `3`: Costco authentication required; run `costco login`

## Daily scheduler

Build the project with Node 22.13.0 or newer before installing the agent, then run:

```sh
costco install-agent
```

The generated user LaunchAgent runs at login and daily at 09:00 by default. Its scheduled invocation uses a 20-hour freshness check, so waking or logging in does not duplicate a recent successful run. Change `scheduledHour` or `scheduledMinute` in the configuration before reinstalling the agent to use another time.

The installer pins absolute paths to the current Node executable, compiled CLI, checkout, and logs. It rejects a missing/non-executable Node target, Node older than 22.13.0, or a missing compiled CLI. **Run `costco install-agent` again after moving the checkout or changing, upgrading, or removing the pinned Node installation.**

The installer writes and validates:

```text
~/Library/LaunchAgents/com.costco-price-matcher.daily.plist
```

Replacement is transactional: the installer writes a same-directory temporary plist, validates it with `plutil`, and detects whether the prior label is loaded. Before unloading a loaded service it requires and validates the old plist, then creates and verifies a backup. A missing or invalid old plist aborts replacement without unloading the service. The candidate is atomically renamed into place only after those checks.

If a later step fails, the installer restores the old plist atomically and reloads it only when it was previously loaded. If restoration itself fails, it leaves the service unloaded, does not load from the replacement path, and reports the preserved backup's recovery path. If booting out the replacement during rollback fails, the loaded state is uncertain: the installer stops immediately, does not claim restoration, and does not restore or re-bootstrap either plist. It normally preserves and reports a recovery-copy path; if that copy also fails during a first install, it instead reports the in-place replacement as the recovery artifact. Either case requires manual recovery after inspecting the loaded service. Temporary and backup files are cleaned after a successful install or successful rollback. The installer loads only in the current user's `gui/<uid>` launchd domain and does not require or use `sudo`.

To unload the agent and remove its plist:

```sh
costco uninstall-agent
```

Uninstall boots out `gui/<uid>/com.costco-price-matcher.daily` by label, so it can still unload the service when the plist is missing or corrupt. It then removes the plist if present. It does not delete receipts, observations, configuration, logs, or the dedicated browser profile.

## Apple Mail permission and delivery

Alerts use the first address on an enabled Apple Mail account unless `emailRecipient` is set in the configuration. Mail content is deliberately plain text: Apple Mail's supported scripting property does not reliably turn an assigned string into HTML.

On the first attempted delivery, macOS may ask whether the Node or terminal process can automate Mail. Allow it under **System Settings → Privacy & Security → Automation**. If the prompt appeared during a manual run but scheduled delivery still fails, inspect the logs and verify the relevant process has Mail permission. The tool never sends mail during `setup`, `status`, or `doctor`.

## Local data and security model

All state stays on this Mac under:

```text
~/.costco-price-matcher/config.json
~/.costco-price-matcher/costco.sqlite
~/.costco-price-matcher/browser-profile/
~/.costco-price-matcher/logs/stdout.log
~/.costco-price-matcher/logs/stderr.log
~/.costco-price-matcher/run.lock
```

The application root, browser profile, and log directories are created and hardened to mode `0700`; configuration, database, and lock files are mode `0600`. Mutating commands reject symbolic-link and wrong-type targets at these boundaries. Existing owned paths are hardened when a mutating command opens them, while read-only `status` and `doctor` checks do not change permissions. SQLite uses its non-WAL default so no persistent `-wal` or `-shm` state is expected.

The configuration contains non-secret settings only. Costco session data remains in the dedicated Chrome profile, which should be protected like a logged-in browser. SQLite stores normalized receipt lines, relevant product observations, alert state, sanitized failure diagnostics, and run summaries; it does not retain whole account responses. Apple Mail supplies the sender identity at runtime.

The default configuration is:

```json
{
  "daysToFetch": 35,
  "adjustmentWindowDays": 30,
  "scheduledHour": 9,
  "scheduledMinute": 0,
  "emailRecipient": null,
  "priceBatchSize": 25,
  "minimumSavingsCents": 1
}
```

## Coverage limits

Matching is intentionally strict: exact Costco item number, original warehouse number, a positive current price, and the `WH` program marker are all required. Receipt discounts are associated only when their referenced item number exactly matches a purchase line; unresolved discount lines are skipped instead of being guessed from adjacency. Purchases are never compared across warehouses, and fuzzy or AI matching is not used.

The product service does not expose a usable warehouse price for every receipt item. Missing, online-only, zero-price, malformed, and failed results are counted as unresolved and never become an alert. The default import covers 35 days of receipts and applies a 30-calendar-day candidate window. Both windows use the Mac's current local calendar date and the leading `YYYY-MM-DD` printed on the warehouse receipt; a `Z` or numeric offset never shifts that printed purchase into another day. Returns, refunds, malformed lines, and invalid identifiers are excluded. Reported savings remain potential until verified at the original warehouse.

## Troubleshooting

- **`costco login` recovery appears:** run `costco login`, complete sign-in manually, close the dedicated window, and retry `costco run`. Doctor can confirm that the profile directory exists, but intentionally does not contact Costco to validate the live session. The tool does not bypass MFA or CAPTCHA.
- **Chrome profile is already in use:** close the dedicated Costco Chrome window before running a live check. Doctor only checks whether the profile directory exists and does not launch Chrome.
- **`install-agent` rejects Node:** use Node 22.13.0 or newer, rebuild, and reinstall. The scheduler intentionally refuses an older, missing, directory-valued, or non-executable Node target and a missing compiled CLI.
- **Checkout or Node moved after installation:** rebuild if needed and run `costco install-agent` again so launchd receives the new absolute paths.
- **Plist is missing or corrupt during uninstall:** `costco uninstall-agent` unloads the known service label directly and does not depend on parsing the plist.
- **Mail account is not visible:** open Mail, finish account setup, confirm the account is enabled, and review Automation permission in System Settings.
- **Scheduled run has no output:** inspect `~/.costco-price-matcher/logs/stdout.log` and `stderr.log`, then run `costco status` and `costco doctor` interactively.
- **Many unresolved items:** this can be a normal provider coverage limitation. It may also indicate that Costco changed its unofficial API; unresolved results are intentionally not treated as price drops.
- **Native module installation fails:** install or update Xcode Command Line Tools, use a supported Node version, remove `node_modules`, and rerun `npm ci`.
- **Another run holds the lock:** wait for it to finish. If no process is running, the stable lock file may remain; that is harmless because only the kernel-held lock denotes ownership.
- **Configuration is invalid:** correct `~/.costco-price-matcher/config.json` using the documented ranges, or move it aside and rerun `costco setup`.

For command help:

```sh
costco --help
```

To run the unauthenticated, read-only public coverage sample directly from the checkout:

```sh
npm run probe:live-price
```

The probe reports the sample as resolved or unresolved; it does not claim general warehouse-price coverage.
