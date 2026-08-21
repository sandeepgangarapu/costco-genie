# Full Price Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate truthful JSON, CSV, and HTML all-item price reports on every run.

**Architecture:** Normalize gross and discount receipt lines into net purchases, model price observations by channel, build report rows separately from alert candidates, and atomically persist timestamped plus latest artifacts. Refresh Costco receipt authorization from the authenticated Orders request while keeping online and warehouse prices semantically separate.

**Tech Stack:** TypeScript 5.8, Node.js 22, Playwright, Vitest, SQLite.

**Spec:** `docs/superpowers/specs/2026-08-21-full-price-report-design.md`

## Global Constraints

- Item number plus warehouse number is the matching identity; description is display-only.
- Online and Same-Day prices never qualify a warehouse adjustment.
- Missing prices remain unavailable with explicit reasons.
- Write JSON, CSV, and self-contained HTML on every run under `~/.costco-price-matcher/reports/`.
- Preserve existing user changes and do not commit or push.
- Follow TDD: observe each new test fail before production changes.

---

### Task 1: Correct receipt discounts and derive report rows

**Files:**
- Modify: `src/costco/receipt-client.ts`
- Modify: `src/core/normalize-receipts.ts`
- Modify: `src/domain/types.ts`
- Create: `src/core/report-rows.ts`
- Test: `tests/receipt-client.test.ts`
- Test: `tests/normalize-receipts.test.ts`
- Create: `tests/report-rows.test.ts`

**Interfaces:**
- Produces: `Purchase` fields `grossUnitCents`, `couponCents`, and existing `paidUnitCents`.
- Produces: `buildReportRows(purchases, priceSnapshots, now, config): ReportRow[]`.

- [ ] Add failing fixtures for item-array discount lines whose description identifies the associated item number, including quantity two and malformed lines.
- [ ] Run `npm test -- tests/receipt-client.test.ts tests/normalize-receipts.test.ts tests/report-rows.test.ts` and confirm the new assertions fail for missing allocation/report behavior.
- [ ] Adapt valid negative discount lines into coupons, allocate discounts exactly, retain gross/net fields, and derive one report row per purchase line.
- [ ] Re-run the targeted tests and confirm they pass.

### Task 2: Model price channels and render durable reports

**Files:**
- Modify: `src/domain/types.ts`
- Create: `src/notifications/full-report.ts`
- Modify: `src/config/paths.ts`
- Test: `tests/full-report.test.ts`
- Modify: `tests/config.test.ts`

**Interfaces:**
- Produces: `FullRunReport` with metadata, rows, source diagnostics, and outcome.
- Produces: `writeFullReport(paths, report): Promise<{ htmlFile: string; csvFile: string; jsonFile: string }>`.

- [ ] Write failing tests for complete columns, null/unavailable values, CSV quoting, HTML escaping, timestamped filenames, atomic latest replacements, and an empty auth-required report.
- [ ] Run `npm test -- tests/full-report.test.ts tests/config.test.ts` and confirm failures are caused by missing report behavior.
- [ ] Implement JSON, CSV, and self-contained accessible HTML renderers plus private report-directory creation and atomic writes.
- [ ] Re-run the targeted tests and confirm they pass.

### Task 3: Integrate current authentication, observations, and every-run output

**Files:**
- Modify: `src/costco/browser-session.ts`
- Modify: `src/costco/price-client.ts`
- Modify: `src/app/run.ts`
- Modify: `src/cli/actions.ts`
- Modify: `src/cli.ts`
- Test: `tests/browser-session.test.ts`
- Test: `tests/price-client.test.ts`
- Test: `tests/run.test.ts`
- Test: `tests/cli-composition.test.ts`

**Interfaces:**
- `readCostcoTokens(paths)` returns current `{ clientId, idToken }` from the authenticated Orders request without logging values.
- `runPriceCheckLocked` persists a full report for all terminal outcomes and returns report paths in `RunSummary`.

- [ ] Write failing tests for dynamic Orders authorization capture, separated online/warehouse observations, exact-item Warehouse Savings evidence, receipt-derived historical price evidence, successful all-row output, and auth/failure empty reports.
- [ ] Run the four targeted test files and confirm expected failures.
- [ ] Implement the smallest session-capture and integration changes, including live Warehouse Savings parsing by exact item number, while keeping warehouse eligibility conservative and price-source failures isolated.
- [ ] Re-run targeted tests and confirm they pass.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm run build`.
- [ ] Run one live scan and inspect `latest.html`, `latest.csv`, and `latest.json` for source labels, discounts, and candidate accuracy.
