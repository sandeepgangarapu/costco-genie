# Costco Price Matcher

Find potential price adjustments on recent Costco warehouse receipts and Costco.com orders, and watch items you have not bought for new price lows. This local Mac app writes purchase reports and can email receipt savings and watchlist drops. You verify prices and request any adjustment yourself.

## Requirements

- macOS with a desktop session and your own Costco account.
- Google Chrome, Node.js 22.13.0+ with npm (or NVM), and Apple Command Line Tools.
- Apple Mail with an enabled account, or your own [SMTP configuration](docs/email.md).

## Setup

Open Terminal and run:

```sh
curl -fsSL https://raw.githubusercontent.com/sandeepgangarapu/costco-price-matcher/main/install.sh | sh
```

You can [read the installer](https://github.com/sandeepgangarapu/costco-price-matcher/blob/main/install.sh) first. It checks prerequisites, downloads the app, installs dependencies, and runs setup. Already cloned? Run `./costco setup` in that checkout.

```sh
cd ~/costco-price-matcher
./costco login
```

Sign in yourself in the app's dedicated Chrome window, complete any MFA/CAPTCHA, then **close that window**. Your everyday Chrome session does not replace this login. Repeat `./costco login` when the session expires.

Setup asks for optional Same-Day location and email settings; Enter keeps a value and `-` clears it. Warehouse watches need your warehouse number:

```sh
./costco setup --watch-warehouse YOUR_WAREHOUSE
```

See [configuration](docs/configuration.md) for noninteractive options and all defaults.

## Daily use

Check recent purchases and open the report:

```sh
./costco run
open ~/.costco-price-matcher/reports/latest.html
```

Watch items you have not bought (replace the placeholders):

```sh
./costco watch add ITEM_NUMBER --name "Item to watch"
./costco watch add 'https://www.costco.com/example.product.100000000.html' --channel online
./costco watch list
./costco watch history ITEM_NUMBER
./costco watch check
./costco watch check --dry-run
./costco watch remove ITEM_NUMBER
```

The default channel is `both`; choose `online` or `warehouse` with `--channel`. Adding silently records available baselines; `--no-check` skips that lookup. Subsequent new lows can email you. See [watchlist behavior](docs/watchlist.md).

Install automatic checks after your manual checks work:

```sh
./costco install-agent
```

One LaunchAgent checks watches daily at 08:00 and receipts at their configured time (09:00 by default), with catch-up and freshness guards. Weekly receipt settings are preserved. Reinstall after changing schedules, Node, or the checkout location; see [scheduling](docs/scheduling.md).

```sh
./costco status
./costco doctor
./costco uninstall-agent
./costco help
```

Status and doctor are offline; profile presence does not prove you are signed in. Uninstalling the agent keeps your data.

Private data lives in `~/.costco-price-matcher/`, including settings, database, browser profile, reports, and logs.

Share the Git repository; keep your account data, browser session, credentials, and reports private.

## Details

- [Configuration and setup options](docs/configuration.md)
- [Price sources and limitations](docs/price-sources.md)
- [Watchlist rules](docs/watchlist.md) and [scheduling](docs/scheduling.md)
- [Apple Mail and SMTP](docs/email.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md) and [agent instructions](AGENTS.md)

Unofficial personal tool, unaffiliated with Costco. Verified quotations still need stock, shelf-price, and eligibility checks; Same-Day prices are estimates.
