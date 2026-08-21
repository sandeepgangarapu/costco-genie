# Costco Price Matcher

## What is this?

Costco has a price-adjustment policy: if an item you bought goes on sale soon after your purchase, the warehouse can refund you the difference—but only if you notice and ask.

Costco Price Matcher is a free, personal tool that does that noticing for you. It runs entirely on your own Mac:

1. It imports your recent Costco receipts from your own logged-in Costco session.
2. For every item you bought, it checks the item's **current price at the same warehouse** where you purchased it.
3. When something you bought is now cheaper, it sends you a macOS notification and a plain-text email listing the potential savings.
4. You then visit the original warehouse and ask for the adjustment.

It repeats this automatically every morning (or on any interval you choose), and it never alerts twice about the same purchase and price.

**Important:** this project is unofficial and is not affiliated with, endorsed by, or supported by Costco. It uses undocumented Costco APIs that can change or stop working without notice. Automated access may be restricted by Costco's terms or account policies; review the applicable terms and use the tool conservatively at your own risk. A match is not proof of eligibility—always verify the item, current price, purchase date, and adjustment policy with the original warehouse.

---

## First-time setup (do these once, then forget about it)

**What you need:**

- A Mac running macOS, with **Apple Mail** set up and at least one enabled account
- **Node.js 22.13.0 or newer**
- **Google Chrome** (used once so you can sign in to Costco; your password is never seen or stored by the tool)
- **Xcode Command Line Tools**, if `npm` needs to compile native modules (`xcode-select --install`)

These are the **one-time** things you have to do yourself. After this, everything runs on its own.

1. **Install the tool** — from the project checkout, run:

   ```sh
   npm ci && npm run build && npm link && costco setup
   ```

2. **Sign in to Costco once** — run:

   ```sh
   costco login
   ```

   A dedicated Chrome window opens. Sign in manually—including any MFA or CAPTCHA—then close that window. This is the only time your Costco account is involved interactively. The tool never sees or stores your password; the session lives in that Chrome profile.

3. **Allow Mail automation** — the first time an alert is delivered, macOS may ask whether the terminal can control Apple Mail. Click **Allow**. (If you miss the prompt, grant it later under **System Settings → Privacy & Security → Automation**.)

4. **Turn on automatic runs** — run:

   ```sh
   costco install-agent
   ```

5. **Check everything is ready** (optional but recommended):

   ```sh
   costco doctor
   ```

> **What happens after setup — no action needed from you:**
>
> - Every day at 09:00 (your Mac's local time), the tool checks your receipts against current warehouse prices by itself.
> - It also runs whenever you log in to or wake your Mac—but only if the last successful check was more than 20 hours ago, so unlocking your Mac does not cause duplicate checks.
> - When it finds something you bought that is now cheaper, you get a **macOS notification** and a **plain-text email** with the item, prices, and potential savings.
> - The same purchase is never alerted twice for the same price.
> - If your Costco sign-in ever expires, you get one notification telling you to run `costco login` again. That is the only maintenance you may ever need to redo.
> - Nothing else touches Costco: `costco status` and `costco doctor` are offline, and all your data stays in `~/.costco-price-matcher/`.

### Run your first check right now (optional)

You don't have to wait until tomorrow's scheduled run:

```sh
costco run
```

This contacts Costco, imports up to 35 days of receipts, checks current prices, and may send notifications and email right away.

---

## Details

### Configuration (optional)

You do not need to configure anything to start. If you want to change behavior, edit:

```text
~/.costco-price-matcher/config.json
```

Defaults:

| Setting                        | Default                                 | Meaning                                                                               |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------- |
| `daysToFetch`                  | `35`                                    | How many days of receipts to import                                                   |
| `adjustmentWindowDays`         | `30`                                    | Purchases within this many calendar days are adjustment candidates                    |
| `scheduledHour`                | `9`                                     | Hour of day for scheduled runs (local time)                                           |
| `scheduledMinute`              | `0`                                     | Minute of day for scheduled runs                                                      |
| `scheduledIntervalDays`        | `1`                                     | Minimum days between scheduled runs (e.g., `3` = roughly every 3 days)                |
| `emailRecipient`               | `null`                                  | Where alert emails go; defaults to the first address on an enabled Apple Mail account |
| `priceBatchSize`               | `25`                                    | Item numbers checked per sequential price batch (max 25)                              |
| `minimumSavingsCents`          | `1`                                     | Smallest per-item savings worth alerting about                                        |
| `sameDayMarkupPercent`         | `13.5`                                  | Markup applied to warehouse prices for Same-Day estimates                             |
| `sameDayPostalCode`            | `'98029'`                               | Postal code used for Same-Day price estimates                                         |
| `sameDayRepresentativeAddress` | `'2520 NE Park Dr, Issaquah, WA 98029'` | Representative warehouse address for Same-Day estimates                               |

The configuration contains non-secret settings only. After changing scheduling-related values (`scheduledHour`, `scheduledMinute`, `scheduledIntervalDays`), run `costco install-agent` again.

### Run manually

```sh
costco run     # live receipt and price check; may send alerts
costco status  # local paths and last successful run; contacts nothing
```

Receipt requests and each sequential price batch have a conservative 30-second deadline, and noninteractive helper commands use the same bound. Manual `costco login` browser interaction is intentionally not given this short deadline.

Useful run exit codes are:

- `0`: success, or a fresh scheduled run was skipped
- `1`: failed
- `2`: partial failure, such as an unresolved price batch or notification-channel error
- `3`: Costco authentication required; run `costco login`

For command help:

```sh
costco --help
```

To run the unauthenticated, read-only public coverage sample directly from the checkout:

```sh
npm run probe:live-price
```

The probe reports the sample as resolved or unresolved; it does not claim general warehouse-price coverage.

### Scheduler

Build the project with Node 22.13.0 or newer before installing the agent, then run `costco install-agent`.

The generated user LaunchAgent runs at login and daily at 09:00 by default. Its scheduled invocation uses a freshness check of four hours less than `scheduledIntervalDays` days (20 hours by default), so waking or logging in does not duplicate a recent successful run. With `scheduledIntervalDays` set to 3, a successful run suppresses the next two daily triggers and the next run happens on the third day at 09:00.

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

### Apple Mail permission and delivery

Alerts use the first address on an enabled Apple Mail account unless `emailRecipient` is set in the configuration. Mail content is deliberately plain text: Apple Mail's supported scripting property does not reliably turn an assigned string into HTML.

On the first attempted delivery, macOS may ask whether the Node or terminal process can automate Mail. Allow it under **System Settings → Privacy & Security → Automation**. If the prompt appeared during a manual run but scheduled delivery still fails, inspect the logs and verify the relevant process has Mail permission. The tool never sends mail during `setup`, `status`, or `doctor`.

### Local data and security model

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

Costco session data remains in the dedicated Chrome profile, which should be protected like a logged-in browser. SQLite stores normalized receipt lines, relevant product observations, alert state, sanitized failure diagnostics, and run summaries; it does not retain whole account responses. Apple Mail supplies the sender identity at runtime.

### Coverage limits

Matching is intentionally strict: exact Costco item number, original warehouse number, a positive current price, and the `WH` program marker are all required. Receipt discounts are associated only when their referenced item number exactly matches a purchase line; unresolved discount lines are skipped instead of being guessed from adjacency. Purchases are never compared across warehouses, and fuzzy or AI matching is not used.

The product service does not expose a usable warehouse price for every receipt item. Missing, online-only, zero-price, malformed, and failed results are counted as unresolved and never become an alert. Both windows use the Mac's current local calendar date and the leading `YYYY-MM-DD` printed on the warehouse receipt; a `Z` or numeric offset never shifts that printed purchase into another day. Returns, refunds, malformed lines, and invalid identifiers are excluded. Reported savings remain potential until verified at the original warehouse.

### Troubleshooting

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
