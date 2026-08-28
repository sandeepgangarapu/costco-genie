# Costco Price Matcher

## What is this?

Costco has price-adjustment policies for eligible purchases. If an item you bought goes on sale soon after your purchase, you may be able to request the difference—but only if you notice and ask.

Costco Price Matcher is a free, personal tool that does that noticing for you. It runs entirely on your own Mac:

1. It imports recent warehouse receipts and Costco.com orders from your own logged-in Costco session.
2. It compares warehouse purchases only with a verified current price at the same warehouse, and Costco.com purchases only with an exact current Costco.com price.
3. When a supported comparison is lower, it sends you a macOS notification and a plain-text email listing the potential savings.
4. You review the evidence and contact the appropriate Costco channel if you decide to request an adjustment.

It repeats this automatically every morning (or on any interval you choose), and it never alerts twice about the same purchase and price.

**Important:** this project is unofficial and is not affiliated with, endorsed by, or supported by Costco. It uses undocumented Costco APIs that can change or stop working without notice. Automated access may be restricted by Costco's terms or account policies; review the applicable terms and use the tool conservatively at your own risk. The tool reports potential savings only: it does not submit a price-adjustment request or guarantee Costco eligibility. Always verify the item, current price, purchase date, active quantity, and applicable policy before acting.

---

## First-time setup (do these once, then forget about it)

**What you need:**

- A Mac running macOS, with **Apple Mail** set up and at least one enabled account
- **NVM** (recommended), or **Node.js 22.13.0 or newer** with npm
- **Google Chrome** (used once so you can sign in to Costco; your password is never seen or stored by the tool)
- **Xcode Command Line Tools**, if `npm` needs to compile native modules (`xcode-select --install`)

The checked-in `./costco` launcher is the only command entry point you need. When NVM is installed, it installs and selects the Node version pinned in `.nvmrc`. It also refreshes native dependencies when the Node ABI or lockfile changes, builds the CLI, and then runs the requested command. This prevents a dependency compiled by one Node version from being loaded by another.

These are the **one-time** things you have to do yourself. After this, everything runs on its own.

1. **Set up the tool** — from the project checkout, run one command:

   ```sh
   ./costco setup
   ```

2. **Sign in to Costco once** — run:

   ```sh
   ./costco login
   ```

   A dedicated Chrome window opens. Sign in manually—including any MFA or CAPTCHA—then close that window. This is the only time your Costco account is involved interactively. The tool never sees or stores your password; the session lives in that Chrome profile.

3. **Allow Mail automation** — the first time an alert is delivered, macOS may ask whether the terminal can control Apple Mail. Click **Allow**. (If you miss the prompt, grant it later under **System Settings → Privacy & Security → Automation**.)

4. **Turn on automatic runs** — run:

   ```sh
   ./costco install-agent
   ```

5. **Check everything is ready** (optional but recommended):

   ```sh
   ./costco doctor
   ```

> **What happens after setup — no action needed from you:**
>
> - Every day at 09:00 (your Mac's local time), the tool checks recent warehouse receipts and Costco.com orders against channel-correct current prices by itself.
> - It also runs whenever you log in to or wake your Mac—but only if the last successful check was more than 20 hours ago, so unlocking your Mac does not cause duplicate checks.
> - When it finds something you bought that is now cheaper, you get a **macOS notification** and a **plain-text email** with the item, prices, and potential savings.
> - The same purchase is never alerted twice for the same price.
> - If your Costco sign-in ever expires, you get one notification telling you to run `./costco login` again. That is the only maintenance you may ever need to redo.
> - Nothing else touches Costco: `./costco status` and `./costco doctor` are offline, and all your data stays in `~/.costco-price-matcher/`.

### Run your first check right now (optional)

You don't have to wait until tomorrow's scheduled run:

```sh
./costco run
```

This contacts Costco, imports up to 35 days of warehouse receipts and Costco.com orders, checks current prices, and may send notifications and email right away.

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
| `daysToFetch`                  | `35`                                    | How many days of warehouse receipts and Costco.com orders to import                   |
| `adjustmentWindowDays`         | `30`                                    | Purchases within this many calendar days are adjustment candidates                    |
| `scheduledHour`                | `9`                                     | Hour of day for scheduled runs (local time)                                           |
| `scheduledMinute`              | `0`                                     | Minute of day for scheduled runs                                                      |
| `scheduledIntervalDays`        | `1`                                     | Minimum days between scheduled runs (e.g., `3` = roughly every 3 days)                |
| `emailRecipient`               | `null`                                  | Where alert emails go; defaults to the first address on an enabled Apple Mail account |
| `priceBatchSize`               | `25`                                    | Item numbers checked per sequential price batch (max 25)                              |
| `minimumSavingsCents`          | `1`                                     | Smallest total purchase-line savings worth alerting about                             |
| `sameDayMarkupPercent`         | `13.5`                                  | Markup applied to warehouse prices for Same-Day estimates                             |
| `sameDayPostalCode`            | `'98029'`                               | Postal code used for Same-Day price estimates                                         |
| `sameDayRepresentativeAddress` | `'2520 NE Park Dr, Issaquah, WA 98029'` | Representative warehouse address for Same-Day estimates                               |

The configuration contains non-secret settings only. After changing scheduling-related values (`scheduledHour`, `scheduledMinute`, `scheduledIntervalDays`), run `./costco install-agent` again.

### Run manually

```sh
./costco run     # live receipt and price check; may send alerts
./costco status  # local paths and last successful run; contacts nothing
```

Warehouse-receipt requests and each sequential price batch have a conservative 30-second deadline, and noninteractive helper commands use the same bound. Manual `./costco login` browser interaction is intentionally not given this short deadline.

Useful run exit codes are:

- `0`: success, or a fresh scheduled run was skipped
- `1`: failed
- `2`: partial failure, such as an unresolved price batch or notification-channel error
- `3`: Costco authentication required; run `./costco login`

For command help:

```sh
./costco --help
```

### Full reports

Every terminal run writes owner-only JSON, CSV, and self-contained HTML reports under `~/.costco-price-matcher/reports/`. Timestamped files preserve individual runs; `latest.json`, `latest.csv`, `latest.html`, and `latest-manifest.json` identify the latest complete report set. Latest-file replacement is atomic, and partial delivery is cleaned up rather than advertised as a complete snapshot.

The detailed purchase-line fields include purchase channel, receipt or order identifier, item number and description, purchase date, active quantity, paid unit price, comparison channel and price, unit delta, total potential savings, days remaining, status, reason, and each evidence channel. JSON uses schema version `2`. CSV and JSON use stable channel values such as `warehouse`, `costco_com`, and `same_day`; HTML uses friendly labels such as “Warehouse,” “Costco.com,” and “Same-Day estimate.” The report summary separates warehouse and Costco.com line coverage and includes source diagnostics, including `costco_online_orders`.

A valid current comparison is shown even when it is not lower or its savings fall below the alert threshold. Potential savings are never negative: they are the positive unit delta multiplied by active quantity, or zero when the current price is not lower. When the relevant current price is unavailable or invalid, comparison price, delta, and potential savings are unavailable rather than borrowed from another channel.

To run the unauthenticated, read-only public coverage sample directly from the checkout:

```sh
npm run probe:live-price
```

The probe reports the sample as resolved or unresolved; it does not claim general warehouse-price coverage.

### Scheduler

Run `./costco install-agent`. The launcher selects the pinned supported Node runtime and builds the project before the agent is installed.

The generated user LaunchAgent runs at login and daily at 09:00 by default. Its scheduled invocation uses a freshness check of four hours less than `scheduledIntervalDays` days (20 hours by default), so waking or logging in does not duplicate a recent successful run. With `scheduledIntervalDays` set to 3, a successful run suppresses the next two daily triggers and the next run happens on the third day at 09:00.

The installer pins absolute paths to the current Node executable, compiled CLI, checkout, and logs. It rejects a missing/non-executable Node target, Node older than 22.13.0, or a missing compiled CLI. **Run `./costco install-agent` again after moving the checkout or changing, upgrading, or removing the pinned Node installation.**

The installer writes and validates:

```text
~/Library/LaunchAgents/com.costco-price-matcher.daily.plist
```

Replacement is transactional: the installer writes a same-directory temporary plist, validates it with `plutil`, and detects whether the prior label is loaded. Before unloading a loaded service it requires and validates the old plist, then creates and verifies a backup. A missing or invalid old plist aborts replacement without unloading the service. The candidate is atomically renamed into place only after those checks.

If a later step fails, the installer restores the old plist atomically and reloads it only when it was previously loaded. If restoration itself fails, it leaves the service unloaded, does not load from the replacement path, and reports the preserved backup's recovery path. If booting out the replacement during rollback fails, the loaded state is uncertain: the installer stops immediately, does not claim restoration, and does not restore or re-bootstrap either plist. It normally preserves and reports a recovery-copy path; if that copy also fails during a first install, it instead reports the in-place replacement as the recovery artifact. Either case requires manual recovery after inspecting the loaded service. Temporary and backup files are cleaned after a successful install or successful rollback. The installer loads only in the current user's `gui/<uid>` launchd domain and does not require or use `sudo`.

To unload the agent and remove its plist:

```sh
./costco uninstall-agent
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
~/.costco-price-matcher/reports/
```

The application root, browser profile, and log directories are created and hardened to mode `0700`; configuration, database, and lock files are mode `0600`. Mutating commands reject symbolic-link and wrong-type targets at these boundaries. Existing owned paths are hardened when a mutating command opens them, while read-only `status` and `doctor` checks do not change permissions. SQLite uses its non-WAL default so no persistent `-wal` or `-shm` state is expected.

Costco session data remains in the dedicated Chrome profile, which should be protected like a logged-in browser. SQLite stores normalized warehouse and Costco.com purchase lines, relevant product observations, alert state, sanitized failure diagnostics, and run summaries. Raw receipt or order responses, addresses, payment details, member data, and other order PII are never stored in SQLite, logs, or reports. The normalized receipt/order identifiers and product fields needed for matching do appear in owner-only local state and reports. Apple Mail supplies the sender identity at runtime.

### Coverage limits

Matching is intentionally strict and channel-separated. Warehouse purchases require the exact Costco item number, original warehouse number, a positive verified current warehouse price, and the `WH` program marker. Costco.com purchases require the exact item number and usable exact current Costco.com evidence. Costco.com evidence is never used to compare a warehouse purchase, warehouse evidence is never used to compare an online purchase, and Same-Day estimates apply only to warehouse purchases when verified warehouse pricing is unavailable. Receipt discounts are associated only when their referenced item number exactly matches a warehouse purchase line; unresolved discount lines are skipped instead of being guessed from adjacency. Fuzzy or AI matching is not used.

Costco.com imports include merchandise lines only after fulfillment evidence (shipped, delivered, pickup completed, or a fulfilled line status). Their active quantity is the ordered quantity minus cancelled units and the greater returned count, clamped between zero and the ordered quantity; zero-active, fee, wholly cancelled, wholly returned, malformed, or unfulfilled lines are excluded.

The product services do not expose a usable price for every item. Missing, wrong-channel, zero-price, malformed, and failed results are counted as unresolved and never become an alert. A warehouse purchase with no verified warehouse price can produce a separately labeled Same-Day estimated opportunity, but it requires manual warehouse verification. Both adjustment windows use the Mac's current local calendar date and the leading `YYYY-MM-DD` on the source purchase; a `Z` or numeric offset never shifts that printed purchase into another day.

Warehouse receipt import and Costco.com order import fail independently. If one source fails, the run continues with current data from the other source, writes the available rows and sanitized source diagnostics, and reports `partial_failure`; one failed source does not suppress the other. A failed detail or price batch is similarly isolated where possible.

All reported savings are potential. The tool can alert on exact lower warehouse prices, exact lower Costco.com prices, and separately labeled Same-Day warehouse estimates. It does not submit any request, determine every policy exception, or guarantee that Costco will approve an adjustment.

### Troubleshooting

- **`./costco login` recovery appears:** run `./costco login`, complete sign-in manually, close the dedicated window, and retry `./costco run`. Doctor can confirm that the profile directory exists, but intentionally does not contact Costco to validate the live session. The tool does not bypass MFA or CAPTCHA.
- **Chrome profile is already in use:** close the dedicated Costco Chrome window before running a live check. Doctor only checks whether the profile directory exists and does not launch Chrome.
- **The launcher rejects Node:** install NVM, or install Node 22.13.0 or newer with npm, then rerun the same `./costco` command.
- **Checkout or Node moved after installation:** run `./costco install-agent` again so launchd receives the new absolute paths.
- **Plist is missing or corrupt during uninstall:** `./costco uninstall-agent` unloads the known service label directly and does not depend on parsing the plist.
- **Mail account is not visible:** open Mail, finish account setup, confirm the account is enabled, and review Automation permission in System Settings.
- **Scheduled run has no output:** inspect `~/.costco-price-matcher/logs/stdout.log` and `stderr.log`, then run `./costco status` and `./costco doctor` interactively.
- **Many unresolved items:** this can be a normal provider coverage limitation. It may also indicate that Costco changed its unofficial API; unresolved results are intentionally not treated as price drops.
- **Native module installation fails:** install or update Xcode Command Line Tools, then rerun the same `./costco` command. The launcher will retry the dependency refresh.
- **Another run holds the lock:** wait for it to finish. If no process is running, the stable lock file may remain; that is harmless because only the kernel-held lock denotes ownership.
- **Configuration is invalid:** correct `~/.costco-price-matcher/config.json` using the documented ranges, or move it aside and rerun `./costco setup`.
