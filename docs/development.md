# Development

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

An explicitly invoked public HTTP coverage probe is available for manual diagnostics:

```sh
npm run probe:warehouse-coverage -- YOUR_WAREHOUSE_NUMBER YOUR_FIRST_ITEM_NUMBER YOUR_SECOND_ITEM_NUMBER
```

Pass one or more item numbers as plain arguments (works in zsh and bash). It prints aggregate display, savings, strict WH, and comparable-price coverage, blocked/unavailable reason counts for each source, and the count that would need Same-Day. It does not load receipt prices or descriptions, so receipt-based safeguards are exercised by the app rather than this source-coverage probe. It does not read private configuration, access the database, send email or notifications, open a browser/profile, or invoke Same-Day. It contacts Costco, so keep it out of offline tests and run it only when authorized. Report JSON schema 3 adds separate display/WH observations and reconciliation evidence; existing database observations migrate with a nullable evidence column.

To update a clean checkout, run `git pull --ff-only` and then `./costco help`. Local settings, session, and reports remain in your home folder. Do not delete that folder as part of an update.

## Private data and sharing

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

## Watchlist implementation

`src/watch/` contains the ported low policy, check transaction/delivery flow, namespaced store, email rendering, CLI actions, and source composition. `src/costco/product.ts`, `online-page.ts`, and `watch-online-client.ts` port URL resolution and online price evidence. Warehouse/display/coupons, Same-Day, file locking, browser CDP lifecycle, email transports, and shared diagnostic redaction use matcher implementations. Tests under `tests/watch/` cover the port and integration with synthetic boundaries.

`initializeWatchSchema` is called by `Database` initialization using the existing additive CREATE/ALTER pattern. It creates `watch_items`, `watch_runs`, `watch_observations`, `watch_lows` (including unit basis), `watch_alerts`, and `watch_state`, plus active-item and history indexes. Receipt tables and schema-version state are preserved. The migration test builds the current pre-watch schema with synthetic purchases, observations, alert delivery and run rows, applies migration twice, and verifies rows and foreign keys. Older read-only databases without watch tables show an empty watchlist without migration. No checker data migration is needed.

Before sharing, run the gates in [AGENTS.md](../AGENTS.md), including an owner-data scan of the candidate diff. Live probes/checks, browser login, sending messages, LaunchAgent installation, pushing, and merging belong to the authorized maintainer/orchestrator. `docs/superpowers/` is historical and unchanged.
