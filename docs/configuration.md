# Costco Genie: Configuration

The setup wizard asks for optional settings:

- **ZIP and nearby address:** only needed for Costco Same-Day estimates. Use an address in the ZIP where you want prices checked. Leave the ZIP blank to skip estimates. If you supply a ZIP, also supply an address. The location is sent to Costco Same-Day to localize pricing.
- **Email recipient:** leave blank to send alerts to the first address on an enabled Apple Mail account, or enter your preferred recipient.

Press Enter to keep the displayed value. Enter `-` to clear a value. No location is built in. Your choices stay in `~/.costco-genie/config.json`, outside the repository. Email is sent only when you later run a live check.

Already downloaded or cloned this repo? Open its folder in Terminal and run `./costco setup` instead. The launcher takes care of dependencies and building. Rerunning setup preserves existing settings unless you change them.

## Change your settings

Run the wizard any time:

```sh
./costco setup
```

For a coding agent or a noninteractive terminal, pass your own values explicitly. Replace the placeholders before running:

```sh
./costco setup --zip YOUR_ZIP --address "YOUR_NEARBY_ADDRESS" --email you@example.com
```

Or skip Same-Day estimates:

```sh
./costco setup --no-same-day
```

`--email -` resets the email recipient to the mail provider's default. Supplied options change only those settings; other existing choices stay in place. With no options and no interactive terminal, setup creates defaults or preserves the existing configuration without asking questions. The installer skips estimates when it cannot open an interactive terminal.

For scheduling and advanced settings, open your local configuration:

```sh
open -e ~/.costco-genie/config.json
```

This is JSON: use double quotes, keep commas between entries, and write `null` without quotes. **Do not put your settings in source code.** The app reads this file on each command; `.env` files are not loaded. Local configuration also works for scheduled runs without relying on your Terminal's environment variables.

## All settings and defaults

| Setting                        | Default | What it does                                                                                                                                     |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `daysToFetch`                  | `35`    | Days of receipts/orders to import; 1–365.                                                                                                        |
| `adjustmentWindowDays`         | `30`    | Purchase-age window to consider; 1–365. This does not establish Costco eligibility.                                                              |
| `sameDayPostalCode`            | `null`  | Your five-digit ZIP, as a string. Optional.                                                                                                      |
| `sameDayRepresentativeAddress` | `null`  | Nearby address in that ZIP. Both location fields are needed for Same-Day estimates.                                                              |
| `sameDayMarkupPercent`         | `13.5`  | Assumed markup used to estimate warehouse prices from Same-Day prices; greater than 0 and less than 100. It is an estimate, not a verified rate. |
| `emailRecipient`               | `null`  | Alert recipient; null uses the email provider's default.                                                                                         |
| `emailEveryRun`                | `false` | Email a summary after each completed check, including when there are no potential savings.                                                       |
| `smtpConfigPath`               | `null`  | Absolute path to your private SMTP JSON file; null uses Apple Mail.                                                                              |
| `scheduledHour`                | `9`     | Scheduled local hour; 0–23.                                                                                                                      |
| `scheduledMinute`              | `0`     | Scheduled minute; 0–59.                                                                                                                          |
| `scheduledWeekday`             | `null`  | Null for daily; 0 for Sunday through 6 for Saturday for weekly.                                                                                  |
| `scheduledIntervalDays`        | `1`     | Freshness interval between successful scheduled checks; 1–365. Daily triggers skip recent successful checks.                                     |
| `priceBatchSize`               | `25`    | Number of items per sequential price batch; 1–25.                                                                                                |
| `minimumSavingsCents`          | `1`     | Minimum total savings per purchase line for an alert; a nonnegative integer.                                                                     |

After changing the schedule, run `./costco install-agent` again. Also reinstall it after moving the checkout or changing/removing the Node installation: the agent records absolute paths.

## Watch settings

| Setting                | Default | Purpose                                                                                                                                                       |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `watchWarehouseNumber` | `null`  | Physical warehouse for watched items; digit string, neither zero nor online scope. Set with `./costco setup --watch-warehouse YOUR_WAREHOUSE`; `-` clears it. |
| `watchScheduledHour`   | `8`     | Daily watch hour, 0–23 local time.                                                                                                                            |
| `watchScheduledMinute` | `0`     | Daily watch minute, 0–59.                                                                                                                                     |
| `minimumDropCents`     | `1`     | Nonnegative integer threshold for new-low watch alerts. Separate from receipt savings.                                                                        |

Existing configurations load these defaults without changing saved receipt settings. Warehouse selection is per user; the app never supplies a built-in physical warehouse. Watch settings share the existing Same-Day location, markup, recipient, and SMTP path. An item number added with `--no-check` makes no network request; adding a URL still resolves its identity.

See [scheduling](scheduling.md) after changing either schedule, and [email](email.md) for SMTP setup.
