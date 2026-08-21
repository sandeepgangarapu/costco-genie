# Costco Price Matcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested local macOS automation that imports recent Costco warehouse receipts, checks exact same-warehouse prices, and sends deduplicated Notification Center and Apple Mail alerts.

**Architecture:** A TypeScript CLI coordinates an authenticated receipt client, an unauthenticated warehouse-scoped product GraphQL client, deterministic normalization and matching, SQLite persistence, local notification adapters, and a generated LaunchAgent. External boundaries use dependency injection so tests never log in, send mail, or display notifications.

**Tech Stack:** Node.js 22, TypeScript, Playwright, better-sqlite3, Vitest, Commander, Zod, ESLint, Prettier, macOS AppleScript, launchd.

**Spec:** `docs/superpowers/specs/2026-08-18-costco-price-matcher-design.md`

## Global Constraints

- Run locally on macOS with no cloud services.
- Use a dedicated Playwright browser profile; never store or automate a Costco password, MFA, or CAPTCHA.
- Query at most 25 exact item numbers per warehouse-price batch and run at most once in 20 hours when scheduled.
- A price is usable only when it is positive and its product declares the `WH` program type.
- Missing, zero, online-only, malformed, or failed price results are unresolved and never alert.
- Store money as integer cents and compare warehouse purchases only to the same warehouse number.
- Use the receipt's printed calendar date and the Mac's current local calendar date for fetch and adjustment windows.
- Use Notification Center and Apple Mail with plain-text email content and without sending messages during automated tests.
- Keep `status` and default `doctor` offline and read-only; they must not create app data or launch Chrome.
- Do not create git commits.

---

### Task 1: Project foundation, configuration, and domain contracts

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.gitignore`
- Create: `src/domain/types.ts`
- Create: `src/config/paths.ts`
- Create: `src/config/config.ts`
- Create: `src/lib/money.ts`
- Test: `tests/config.test.ts`
- Test: `tests/money.test.ts`

**Interfaces:**
- Produces: `AppConfig`, `Purchase`, `PriceObservation`, `AdjustmentCandidate`, `RunSummary`, `appPaths(homeDir)`, `loadConfig(paths)`, `parseMoneyToCents(value)`.

- [ ] Write `tests/money.test.ts` asserting `parseMoneyToCents("19.99") === 1999`, comma support, negative values, and invalid input returning `null`; run it and confirm failure because the module is absent.
- [ ] Implement `parseMoneyToCents(value: unknown): number | null` with decimal-string parsing that avoids floating-point multiplication errors; run the test and confirm it passes.
- [ ] Write `tests/config.test.ts` asserting defaults, Zod rejection of invalid ranges, automatic directory creation, and merge of a partial JSON config; run it and confirm failure because config modules are absent.
- [ ] Implement immutable domain contracts, platform paths, and `loadConfig`; run configuration tests.
- [ ] Install dependencies and add scripts for `test`, `test:watch`, `typecheck`, `lint`, `format:check`, `build`, and `start`; run all Task 1 checks.

### Task 2: Receipt normalization and SQLite persistence

**Files:**
- Create: `src/costco/receipt-schema.ts`
- Create: `src/core/normalize-receipts.ts`
- Create: `src/storage/database.ts`
- Test: `tests/normalize-receipts.test.ts`
- Test: `tests/database.test.ts`
- Create: `tests/fixtures/receipt.json`

**Interfaces:**
- Consumes: `Purchase`, `parseMoneyToCents`.
- Produces: `normalizeReceipts(rawReceipts, now): Purchase[]`, `Database.open(path)`, `upsertPurchases`, `recordPriceObservations`, `recentPurchases`, `beginRun`, `finishRun`, `getLastSuccessfulRun`, `getAlertState`, `saveAlertState`.

- [ ] Write a sanitized receipt fixture containing two quantities, a coupon mapped by item number, a malformed item, and a refund transaction.
- [ ] Write normalization tests proving deterministic IDs, cents-only arithmetic, coupon subtraction, quantity handling, malformed-line rejection, and refund rejection; run and confirm expected failures.
- [ ] Implement receipt Zod schemas and `normalizeReceipts`; run normalization tests.
- [ ] Write database tests using a temporary SQLite file to prove schema creation, idempotent purchase upsert, warehouse separation, unresolved observation storage, run history, and alert-state round trips; run and confirm failure because `Database` is absent.
- [ ] Implement the synchronous SQLite wrapper with prepared statements and transactions; run Task 2 and full tests.

### Task 3: Costco session, receipt API, and warehouse price API

**Files:**
- Create: `src/costco/errors.ts`
- Create: `src/costco/browser-session.ts`
- Create: `src/costco/receipt-client.ts`
- Create: `src/costco/price-client.ts`
- Test: `tests/browser-session.test.ts`
- Test: `tests/receipt-client.test.ts`
- Test: `tests/price-client.test.ts`
- Create: `scripts/live-price-probe.ts`

**Interfaces:**
- Consumes: `AppPaths`, `AppConfig`, raw receipt schema, `PriceObservation`.
- Produces: `openLoginBrowser(paths): Promise<void>`, `readCostcoTokens(paths, launcher): Promise<CostcoTokens>`, `fetchReceipts(tokens, startDate, endDate, fetchFn): Promise<unknown[]>`, `fetchWarehousePrices(requests, options): Promise<PriceObservation[]>`.

- [ ] Write browser-session tests with an injected launcher proving token extraction and `AuthRequiredError` when storage lacks either token; run and confirm failure.
- [ ] Implement dedicated-profile login and scheduled token extraction without credential storage; run browser-session tests.
- [ ] Write receipt-client tests that assert endpoint, headers, 35-day variables, GraphQL error handling, and response validation through an injected fetch function; run and confirm failure.
- [ ] Implement the receipt GraphQL query and validated client; run receipt-client tests.
- [ ] Write price-client tests proving grouping by warehouse, batches of 25, digit validation, exact result mapping, `WH` enforcement, positive-price enforcement, and unresolved output for failures; run and confirm failure.
- [ ] Implement the product GraphQL client with bounded sequential batches and per-batch failure isolation; run price-client tests.
- [ ] Add a live-safe probe using sample item `100978861` and warehouse `129`; the script must print structured coverage without asserting that the sample is currently stocked.

### Task 4: Matching, alert state, and reports

**Files:**
- Create: `src/core/matcher.ts`
- Create: `src/core/alert-policy.ts`
- Create: `src/notifications/report.ts`
- Test: `tests/matcher.test.ts`
- Test: `tests/alert-policy.test.ts`
- Test: `tests/report.test.ts`

**Interfaces:**
- Consumes: `Purchase`, `PriceObservation`, `AdjustmentCandidate`, persisted alert state.
- Produces: `findAdjustments(purchases, observations, now, config)`, `urgencyBucket(candidate)`, `selectAlerts(candidates, states)`, `renderTextReport(summary)`, `renderHtmlReport(summary)`.

- [ ] Write matcher tests for exact item number, same-warehouse requirement, 30-day boundary, lower-price-only behavior, quantity savings, latest-observation selection, and unresolved exclusion; run and confirm failure.
- [ ] Implement `findAdjustments`; run matcher tests.
- [ ] Write alert-policy tests proving first alert, identical suppression, lower-price re-alert, and `normal → 3-days → 1-day` escalation; run and confirm failure.
- [ ] Implement urgency bucketing, alert fingerprints, and selection; run alert-policy tests.
- [ ] Write report tests asserting escaped HTML, original warehouse, paid/current price, total savings, days remaining, and "potential" disclaimer; run and confirm failure.
- [ ] Implement compact plain-text and HTML renderers; run Task 4 and full tests.

### Task 5: Notification adapters and application orchestration

**Files:**
- Create: `src/lib/process.ts`
- Create: `src/notifications/macos.ts`
- Create: `src/notifications/apple-mail.ts`
- Create: `src/app/run.ts`
- Test: `tests/macos-notification.test.ts`
- Test: `tests/apple-mail.test.ts`
- Test: `tests/run.test.ts`

**Interfaces:**
- Consumes: report renderers, database, receipt and price clients, alert policy.
- Produces: `MacOsNotifier.send(title, body)`, `AppleMailNotifier.resolveSelfRecipient()`, `AppleMailNotifier.send(recipient, subject, text)`, `runPriceCheck(dependencies, options): Promise<RunSummary>`.

- [ ] Write process-adapter tests proving `osascript` receives report content through argv rather than interpolated source; run and confirm failure.
- [ ] Implement Notification Center and Apple Mail adapters with injected `execFile`, recipient discovery, plain-text email, and channel-specific errors; run adapter tests.
- [ ] Write orchestration tests for success, stale scheduled skip, auth-required local alert, partial price failure, no-op run, mail failure retry state, and successful alert persistence; run and confirm failure.
- [ ] Implement `runPriceCheck` with a lock, run history, 20-hour freshness rule, per-channel results, and alert-state updates only after successful channel delivery; run orchestration and full tests.

### Task 6: CLI, launchd installer, documentation, and verification

**Files:**
- Create: `src/scheduler/launchd.ts`
- Create: `src/cli.ts`
- Create: `tests/launchd.test.ts`
- Create: `tests/cli.test.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: application paths/config, login browser, orchestration.
- Produces CLI commands `setup`, `login`, `run`, `status`, `install-agent`, `uninstall-agent`, and `doctor`; produces `renderLaunchAgent(options): string`.

- [ ] Write launchd tests asserting XML escaping, absolute paths, `RunAtLoad`, 09:00 calendar interval, stdout/stderr paths, and a valid `plutil -lint` result; run and confirm failure.
- [ ] Implement plist rendering plus install/uninstall functions that use `launchctl bootout/bootstrap` with explicit user-domain targets; run launchd tests without loading an agent.
- [ ] Make installation transactional: validate a temporary plist, atomically replace it, and restore the prior plist and loaded state if replacement fails. Refuse unsupported Node versions or missing runtime/CLI targets.
- [ ] Write CLI tests for help, command routing, useful exit codes, and recovery text containing `costco login`; run and confirm failure.
- [ ] Implement the CLI and add a Unix shebang to the compiled entry point; run CLI tests.
- [ ] Write `README.md` with security model, setup/login/run/install commands, Apple Mail permission note, data paths, coverage limitation, troubleshooting, and uninstall instructions.
- [ ] Run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, compiled CLI help, `plutil -lint` on a generated plist, and the live-safe price probe.
