# Costco Price Matcher

Find potential price drops on your recent Costco purchases, using your own Costco account on your Mac.

The app imports warehouse receipts and Costco.com orders, checks available current prices, and writes a report you can open in your browser. It can send macOS notifications and email, and optionally run every morning. You review any potential savings and request an adjustment yourself.

**You need a Mac and a signed-in Costco session in the app's dedicated Google Chrome window.** Signing in to Costco in your everyday browser is not enough. You sign in yourself; there is no Costco password or API key to put in a configuration file.

## What you'll need

- **macOS**, with a desktop session. Windows, Linux, and unattended servers are not supported.
- **Your own Costco account**, with access to your receipts or orders.
- **[Google Chrome](https://www.google.com/chrome/)**, installed in Applications or your home Applications folder.
- **[Node.js](https://nodejs.org/en/download) 22.13.0 or newer**, including npm. An existing NVM installation also works; the launcher selects the version in `.nvmrc`.
- **Apple Command Line Tools**, for Git and native dependencies. To install, run `xcode-select --install` in Terminal and finish Apple's installer.
- **Apple Mail with an enabled email account**, for default email delivery. You can use your own SMTP account instead; see [email settings](#email-settings).

## Set up from one URL

Open **Terminal** (Applications → Utilities → Terminal), paste this command, and press Enter:

```sh
curl -fsSL https://raw.githubusercontent.com/sandeepgangarapu/costco-price-matcher/main/install.sh | sh
```

You can [read the installer](https://github.com/sandeepgangarapu/costco-price-matcher/blob/main/install.sh) first. It checks prerequisites, downloads this repository into `~/costco-price-matcher`, installs the project's dependencies, builds the app, and creates your private local configuration. It stops with instructions if a prerequisite is missing. It does not install Chrome or Node for you.

The setup wizard asks for optional settings:

- **ZIP and nearby address:** only needed for Costco Same-Day estimates. Use an address in the ZIP where you want prices checked. Leave the ZIP blank to skip estimates. If you supply a ZIP, also supply an address. The location is sent to Costco Same-Day to localize pricing.
- **Email recipient:** leave blank to send alerts to the first address on an enabled Apple Mail account, or enter your preferred recipient.

Press Enter to keep the displayed value. Enter `-` to clear a value. No location is built in. Your choices stay in `~/.costco-price-matcher/config.json`, outside the repository. Email is sent only when you later run a live check.

> Already downloaded or cloned this repo? Open its folder in Terminal and run `./costco setup` instead. The launcher takes care of dependencies and building. Rerunning setup preserves existing settings unless you change them.

### 1. Sign in to Costco

```sh
cd ~/costco-price-matcher
./costco login
```

A **separate Google Chrome window** opens. Sign in to Costco yourself and complete any MFA or CAPTCHA. Wait until you are signed in, then **close the dedicated Costco Chrome window** so the command can finish. You can keep your everyday Chrome windows open.

The app keeps this session in `~/.costco-price-matcher/browser-profile/` and reuses it for live checks. It does not ask for your password in Terminal. Treat this profile like any signed-in browser: do not share it or copy it into Git.

**Each person must complete this step on their own Mac.** A session in another Chrome profile, an agent's browser, or a browser preview cannot replace the app's profile. When Costco expires the session, repeat `./costco login`.

### 2. Run your first check

```sh
./costco run
```

Keep the dedicated login window closed during checks. A check contacts Costco, imports recent purchases, and may send notifications and email. The first delivery through Apple Mail may show a macOS permission prompt; choose **Allow**. If needed, check **System Settings → Privacy & Security → Automation**.

Open your report:

```sh
open ~/.costco-price-matcher/reports/latest.html
```

You'll see purchase lines, available current prices, potential savings, and reasons a price could not be found. CSV and JSON copies are in the same folder. Missing prices are normal for some products; they are not treated as price drops.

### 3. Optional: check automatically

After your first check works:

```sh
./costco install-agent
```

By default, this checks daily at **09:00 in your Mac's local time**, with a login trigger and a freshness check to avoid repeating a recent successful run. The Mac needs to be running with your user session available and internet access; it is not a hosted service.

To stop automatic checks:

```sh
./costco uninstall-agent
```

This keeps your configuration, session, and reports. To confirm paths and check local readiness:

```sh
./costco status
./costco doctor
```

These commands are offline. **Doctor checks that the browser profile exists; only a live check verifies that you are still signed in.**

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
open -e ~/.costco-price-matcher/config.json
```

This is JSON: use double quotes, keep commas between entries, and write `null` without quotes. **Do not put your settings in source code.** The app reads this file on each command; `.env` files are not loaded. Local configuration also works for scheduled runs without relying on your Terminal's environment variables.

<details>
<summary>All settings and defaults</summary>

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

</details>

### Email settings

**Apple Mail (default):** open Mail, finish adding an account, and make sure it is enabled. Leave `emailRecipient` null to send to yourself or set it through the wizard. Apple Mail messages are plain text.

**SMTP (optional):** keep credentials outside the repository. Create a private file:

```sh
mkdir -p ~/.costco-price-matcher
(umask 077; touch ~/.costco-price-matcher/smtp.json)
chmod 600 ~/.costco-price-matcher/smtp.json
open -e ~/.costco-price-matcher/smtp.json
```

Fill it with your provider's settings; these are placeholders:

```json
{
  "smtp_host": "smtp.example.com",
  "smtp_port": 587,
  "smtp_user": "you@example.com",
  "smtp_pass": "REPLACE_WITH_YOUR_PROVIDER_PASSWORD",
  "email_from": "you@example.com",
  "email_to": "you@example.com"
}
```

In your local `config.json`, set `smtpConfigPath` to the **full absolute path** of that file. Run `echo "$HOME/.costco-price-matcher/smtp.json"` to see the path; `~` is not expanded inside JSON. Use your provider's app password if required. Port 465 uses implicit TLS; other ports require STARTTLS. SMTP messages include an HTML table and plain-text fallback. `emailRecipient`, if set, overrides `email_to`.

Never paste this file, your password, or your browser session into an issue or a chat.

## What the results mean

- **Warehouse purchases** are compared with verified current prices for the original warehouse and exact item number.
- **Costco.com purchases** are compared with exact Costco.com prices. Online and warehouse comparisons stay separate.
- **Same-Day estimates** are optional, clearly labeled estimates used when verified warehouse pricing is unavailable. They need manual verification at the warehouse.
- **Unresolved** means the app could not obtain a usable price. Costco's services do not expose every price, and their undocumented interfaces can change.

The app does not submit adjustment requests. Verify the item, price, date, quantity, and applicable Costco policy before requesting an adjustment. Identical alerts are suppressed; further price drops or approaching deadlines may produce another alert.

This is an unofficial personal tool, unaffiliated with Costco. Receipt and price coverage can change or stop working.

## Your data and sharing this repo

The app uses this private folder in your home directory:

```text
~/.costco-price-matcher/
  config.json       Your settings
  browser-profile/  Your signed-in Chrome session, cookies, and browser state
  costco.sqlite     Purchase lines, price observations, alert state, and run history
  reports/          HTML, CSV, and JSON reports (including purchase identifiers)
  logs/             Scheduled-run output
  smtp.json         Optional credentials, if you create this file
```

The app creates private directories and owner-only configuration/database/report files. Browser session data is sensitive even without a password file. The app extracts session tokens in memory for Costco requests. It stores normalized purchase fields rather than raw receipt/order responses. Costco requests go to Costco's services; optional emails go through Apple Mail or your chosen SMTP provider.

**Share the Git repository link.** Everyone installs their own copy, chooses their own settings, and signs into their own Costco account. Browser profiles, cookies, caches, local configuration, credentials, databases, reports, and logs are excluded by `.gitignore`. Avoid sending a zip of your working folder: ignored local files could be included.

Current-file cleanup does not erase earlier Git commits. The published repository's history and commit metadata remain visible.

## Troubleshooting

| What you see                                | What to do                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing Node/npm or unsupported Node        | Install Node 22.13.0+ with npm, reopen Terminal, and retry. If you use NVM, the launcher loads it from `NVM_DIR` or `~/.nvm`.                                                                                                                                                       |
| Git or a native dependency fails to install | Run `xcode-select --install`, finish Apple's installer, and retry.                                                                                                                                                                                                                  |
| Installer says the destination exists       | Continue from that checkout with `./costco setup`. It will not overwrite an existing folder. For a new location, use `curl -fsSL https://raw.githubusercontent.com/sandeepgangarapu/costco-price-matcher/main/install.sh \| COSTCO_INSTALL_DIR="$HOME/another-costco-checkout" sh`. |
| Authentication required                     | Run `./costco login`, complete sign-in, close the dedicated window, and retry `./costco run`.                                                                                                                                                                                       |
| Chrome profile is already in use            | Close the app's dedicated Costco Chrome window before running a check.                                                                                                                                                                                                              |
| No receipts or orders                       | Confirm the account has purchase history visible in Costco's account pages using the dedicated login window. Then close it and retry.                                                                                                                                               |
| Many unresolved prices                      | Open the report's source diagnostics. Some items have no usable price; Costco may also have changed an interface.                                                                                                                                                                   |
| Same-Day estimates unavailable              | Supply both your ZIP and a nearby address using `./costco setup`, or leave estimates disabled.                                                                                                                                                                                      |
| Email fails                                 | Check your enabled Apple Mail account and Automation permission, or your private SMTP file. `./costco doctor` does not test actual delivery.                                                                                                                                        |
| Automatic checks stop                       | Run `./costco status` and `./costco doctor`; inspect the private logs under `~/.costco-price-matcher/logs/`. Reinstall the agent if the checkout, Node, or schedule changed.                                                                                                        |
| Invalid configuration                       | Correct the local JSON file. Setup validates input before saving it.                                                                                                                                                                                                                |

A run exits with `0` for success or a skipped fresh scheduled run, `1` for failure, `2` for partial failure, and `3` when sign-in is required. Even with a partial failure, the report may contain useful results from working sources.

## Setting up with a coding agent

Give the agent this repository URL and ask it to follow [AGENTS.md](AGENTS.md). It can install dependencies, create your local configuration, and run offline checks. **You still sign in to Costco in the dedicated Chrome window yourself.** Initial sign-in cannot be completed in an unattended environment, and an agent must not ask you for a Costco password or session token.

## Development

```sh
git clone https://github.com/sandeepgangarapu/costco-price-matcher.git
cd costco-price-matcher
./costco help
```

The launcher installs dependencies from `package-lock.json` as needed and builds. For direct npm commands, select the same supported Node runtime first (`nvm use` if applicable):

```sh
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

Tests use synthetic data and injected browser/network/mail boundaries; they do not require Costco sign-in or send real messages. Historical design notes are in `docs/superpowers/`.

To update a clean checkout, run `git pull --ff-only` and then `./costco help`. Local settings, session, and reports remain in your home folder. Do not delete that folder as part of an update.
