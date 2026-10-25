# Costco Genie: Troubleshooting

## Sign in

```sh
cd ~/costco-genie
./costco login
```

A **separate Google Chrome window** opens. Sign in to Costco yourself and complete any MFA or CAPTCHA. Wait until you are signed in, then **close the dedicated Costco Chrome window** so the command can finish. You can keep your everyday Chrome windows open.

The app keeps this session in `~/.costco-genie/browser-profile/` for receipt runs and member-gated Costco.com watch prices. Other watch sources are public and do not require sign-in. It does not ask for your password in Terminal. Treat this profile like any signed-in browser: do not share it or copy it into Git.

**Each person who needs sign-in must complete this step on their own Mac.** A session in another Chrome profile, an agent's browser, or a browser preview cannot replace the app's profile. When Costco expires the session, repeat `./costco login`.

## First receipt check

```sh
./costco run
```

Keep the dedicated login window closed during checks. A check contacts Costco, imports recent purchases, and may send notifications and email. The first delivery through Apple Mail may show a macOS permission prompt; choose **Allow**. If needed, check **System Settings → Privacy & Security → Automation**.

Open your report:

```sh
open ~/.costco-genie/reports/latest.html
```

You'll see purchase lines, available current prices, potential savings, and reasons a price could not be found. CSV and JSON copies are in the same folder. Missing prices are normal for some products; they are not treated as price drops.

| What you see                                | What to do                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing Node/npm or unsupported Node        | Install Node 22.13.0+ with npm, reopen Terminal, and retry. If you use NVM, the launcher loads it from `NVM_DIR` or `~/.nvm`.                                                                                                                                               |
| Git or a native dependency fails to install | Run `xcode-select --install`, finish Apple's installer, and retry.                                                                                                                                                                                                          |
| Installer says the destination exists       | Continue from that checkout with `./costco setup`. It will not overwrite an existing folder. For a new location, use `curl -fsSL https://raw.githubusercontent.com/sandeepgangarapu/costco-genie/main/install.sh \| COSTCO_INSTALL_DIR="$HOME/another-costco-checkout" sh`. |
| Authentication required                     | Run `./costco login`, complete sign-in, close the dedicated window, and retry `./costco run`.                                                                                                                                                                               |
| Chrome profile is already in use            | Close the app's dedicated Costco Chrome window before running a check.                                                                                                                                                                                                      |
| No receipts or orders                       | Confirm the account has purchase history visible in Costco's account pages using the dedicated login window. Then close it and retry.                                                                                                                                       |
| Many unresolved prices                      | Open the report's source diagnostics. Some items have no usable price; Costco may also have changed an interface.                                                                                                                                                           |
| Same-Day estimates unavailable              | Supply both your ZIP and a nearby address using `./costco setup`, or leave estimates disabled.                                                                                                                                                                              |
| Email fails                                 | Check your enabled Apple Mail account and Automation permission, or your private SMTP file. `./costco doctor` does not test actual delivery.                                                                                                                                |
| Automatic checks stop                       | Run `./costco status` and `./costco doctor`; inspect the private logs under `~/.costco-genie/logs/`. Reinstall the agent if the checkout, Node, or schedule changed.                                                                                                        |
| Invalid configuration                       | Correct the local JSON file. Setup validates input before saving it.                                                                                                                                                                                                        |

A run exits with `0` for success or a skipped fresh scheduled run, `1` for failure, `2` for partial failure, and `3` when sign-in is required. Even with a partial failure, the report may contain useful results from working sources.

## Setting up with a coding agent

Give the agent this repository URL and ask it to follow [AGENTS.md](../AGENTS.md). It can install dependencies, create your local configuration, and run offline checks. **You still sign in to Costco in the dedicated Chrome window yourself.** Initial sign-in cannot be completed in an unattended environment, and an agent must not ask you for a Costco password or session token.

Watch `check` exits 1 on failure and 0 on success, a fresh scheduled skip, or dry-run. If every watch price is unavailable, the check fails without lowering lows. Look at `watch history ITEM`, `status`, and private logs. Failed scheduled checks send one failure email per job per local day; interactive checks send no failure email. Only explicit item-price sign-in gates/redirects add session-expiry guidance to the watch failure email. Generic Sign In / Register navigation cannot. An authenticated or no-gate result resets local expiry state; ambiguous pages and browser failures cannot trigger stale notices. Repeat `./costco login`, sign in yourself, and close the dedicated window when a session expires. No password, cookie, or token belongs in chat.
