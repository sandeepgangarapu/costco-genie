# Costco.com Online Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Import fulfilled Costco.com order lines, compare each exact item only with its latest Costco.com price, and include eligible savings in the existing alerts and full reports without changing warehouse matching semantics.

**Architecture:** Add an explicit purchase channel to the normalized purchase model and database, then add a minimal authenticated online-order GraphQL client. Keep warehouse and Costco.com matching as separate channel-specific paths that converge only at persistence, candidate delivery, and report generation. Fetch receipt and online-order sources independently so either can fail without suppressing the other.

**Tech Stack:** TypeScript, Node.js, Zod, better-sqlite3, Vitest, authenticated Costco GraphQL APIs, existing HTML/CSV/JSON reporting and notification adapters.

**Spec:** `docs/superpowers/specs/2026-08-27-online-orders-design.md`

## Global Constraints

- Do not request, persist, log, test-fixture, or report names, addresses, email addresses, phone numbers, membership numbers, payment data, tracking numbers, raw auth headers, or raw online-order responses.
- Preserve the current warehouse-receipt matcher and Same-Day fallback behavior. A Costco.com observation must never qualify a warehouse purchase, and warehouse or Same-Day evidence must never qualify a Costco.com purchase.
- Use Costco's observed online-order warehouse identifier `847` only as API/source metadata. Display `Costco.com` to users and dispatch matching on `purchaseChannel`.
- Keep exact item-number validation for current Costco.com prices. An unavailable, ambiguous, zero, malformed, or mismatched catalog result cannot become a candidate.
- Preserve existing alert-delivery state by keeping warehouse purchase IDs unchanged. Generate deterministic channel-qualified IDs only for newly imported Costco.com lines.
- Existing databases must migrate in place with `purchase_channel TEXT NOT NULL DEFAULT 'warehouse'`.
- Work around unrelated user files and never add `.DS_Store` files to commits.
- Follow TDD for each task: add the failing test, demonstrate the expected failure, implement the smallest complete behavior, and rerun the focused test before broader verification.
- Commit each completed task separately with the commit message given below.

---

## Task 1: Make Purchase Channel Explicit and Migrate Storage

**Files:**

- Modify: `src/domain/types.ts`
- Modify: `src/core/normalize-receipts.ts`
- Modify: `src/storage/database.ts`
- Modify: `tests/receipt-client.test.ts`
- Modify: `tests/database.test.ts`

### 1. Add failing normalization and migration tests

- [ ] In `tests/receipt-client.test.ts`, assert every normalized warehouse receipt line has `purchaseChannel: 'warehouse'`.
- [ ] In `tests/database.test.ts`, add a migration test that creates a legacy `purchases` table without `purchase_channel`, opens it with `Database.open`, and verifies all legacy rows read back as `warehouse`.
- [ ] Add a round-trip/upsert test for a `costco_com` purchase and assert the channel remains `costco_com` after an update.
- [ ] Run `npm test -- tests/receipt-client.test.ts tests/database.test.ts` and confirm the new assertions fail because the field/column is absent.

The core type added in the failing tests should be:

```ts
export type PurchaseChannel = 'warehouse' | 'costco_com';

export interface Purchase {
  readonly description?: string;
  readonly id: string;
  readonly receiptId: string;
  readonly itemNumber: string;
  readonly warehouseNumber: string;
  readonly purchasedAt: string;
  readonly grossUnitCents?: number;
  readonly paidUnitCents: number;
  readonly quantity: number;
  readonly couponCents: number;
  readonly purchaseChannel: PurchaseChannel;
}
```

### 2. Implement the domain and warehouse adapter changes

- [ ] Add `PurchaseChannel` and required `purchaseChannel` to `Purchase` in `src/domain/types.ts`.
- [ ] Set `purchaseChannel: 'warehouse'` in `normalizeReceipts` in `src/core/normalize-receipts.ts`. Do not change the existing deterministic receipt purchase ID.
- [ ] Update any receipt-client test fixtures that compare full normalized objects.

### 3. Implement the in-place database migration

- [ ] Add `purchase_channel` to the fresh `CREATE TABLE purchases` statement.
- [ ] Call `ensureColumn('purchases', 'purchase_channel', "TEXT NOT NULL DEFAULT 'warehouse'")` after schema creation.
- [ ] Add `purchase_channel` to `PurchaseRow`, insert/upsert SQL, select SQL, and row-to-domain mapping.
- [ ] Persist only the two `PurchaseChannel` values accepted by TypeScript; do not infer channel from warehouse number.
- [ ] Ensure `Database.openReadOnly` remains compatible with legacy read-only databases by selecting `'warehouse' AS purchase_channel` when the column is absent, analogous to the existing optional run-column selections.

The row mapping must remain explicit:

```ts
function toPurchase(row: PurchaseRow): Purchase {
  return {
    couponCents: row.coupon_cents,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.gross_unit_cents === null
      ? {}
      : { grossUnitCents: row.gross_unit_cents }),
    id: row.id,
    itemNumber: row.item_number,
    paidUnitCents: row.paid_unit_cents,
    purchaseChannel: parsePurchaseChannel(row.purchase_channel),
    purchasedAt: row.purchased_at,
    quantity: row.quantity,
    receiptId: row.receipt_id,
    warehouseNumber: row.warehouse_number,
  };
}
```

`parsePurchaseChannel` must accept only `warehouse` and `costco_com`; corrupt values fail closed instead of being cast into the domain type.

### 4. Verify and commit Task 1

- [ ] Run `npm test -- tests/receipt-client.test.ts tests/database.test.ts`.
- [ ] Run `npm run typecheck`; add `purchaseChannel: 'warehouse'` to existing typed test fixtures or helpers that must compile, without changing their behavior.
- [ ] Run `git diff --check`.
- [ ] Commit only Task 1 files with `git commit -m "feat: add purchase channel persistence"`.

---

## Task 2: Add the Minimal Authenticated Online-Order Client

**Files:**

- Create: `src/costco/online-order-client.ts`
- Create: `tests/online-order-client.test.ts`

### 1. Write failing client-contract tests

- [ ] Add a pagination test with 11 sanitized orders. Assert list pages are requested as pages 1 and 2 with page size 10.
- [ ] Assert detail requests are split into batches of at most 10 order numbers.
- [ ] Inspect serialized GraphQL request bodies in the test and assert they contain only the approved list/detail fields from the spec. Add negative assertions for `address`, `email`, `phone`, `membership`, `payment`, `card`, and `tracking`.
- [ ] Assert auth headers are passed through, but never include their values in assertion messages or snapshots.
- [ ] Add normalization cases for fulfilled, pickup-completed, fee, wholly cancelled, partially cancelled, wholly returned, partially returned, invalid item, invalid price, and invalid quantity lines.
- [ ] Assert returned quantity uses `max(totalReturnedQuantity, returnedStatusQuantity)` and cannot reduce active quantity below zero.
- [ ] Assert re-imported lines receive the same deterministic purchase ID derived from channel, order number, and stable line identifier.
- [ ] Add 401/403, timeout, non-2xx, malformed-payload, pagination-inconsistency, and one-failed-detail-batch tests. Auth failures must throw `AuthRequiredError`; sanitized API errors must not contain tokens or order numbers; later detail batches must continue after one batch fails.
- [ ] Run `npm test -- tests/online-order-client.test.ts` and confirm it fails because the module does not exist.

### 2. Define the public client contract

- [ ] Create these interfaces in `src/costco/online-order-client.ts`:

```ts
export interface OnlineOrderFetchOptions {
  readonly createTimeoutSignal?: (timeoutMilliseconds: number) => AbortSignal;
  readonly fetchFn?: typeof fetch;
  readonly pageSize?: number;
  readonly detailBatchSize?: number;
  readonly timeoutMilliseconds?: number;
}

export interface OnlineOrderFetchResult {
  readonly purchases: readonly Purchase[];
  readonly diagnostic: ReportSourceDiagnostic;
  readonly failedDetailBatches: number;
}

export async function fetchOnlineOrderPurchases(
  tokens: CostcoTokens,
  startDate: string,
  endDate: string,
  options?: OnlineOrderFetchOptions,
): Promise<OnlineOrderFetchResult>;
```

- [ ] Use `source: 'costco_online_orders'`, `channel: null`, and only sanitized fixed/count-based text in the returned diagnostic.
- [ ] Default list page size and detail batch size to 10, rejecting unsafe overrides outside `1..10`.

### 3. Implement minimal GraphQL operations and strict parsing

- [ ] POST to `https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql` using the captured authenticated headers and existing abort/timeout conventions.
- [ ] Own two minimal query documents named `GetOnlineOrders` and `GetOrderDetails`. Request no identity, contact, address, payment, tracking, membership, or raw order metadata fields.
- [ ] Use Zod schemas that accept only fields needed for pagination and line normalization. Parse each HTTP response before reading it as an order.
- [ ] Stop pagination only when `totalNumberOfRecords` is exhausted or a page contains fewer records than requested. Reject repeated pages, a non-advancing record count, or missing order numbers as sanitized pagination errors.
- [ ] Deduplicate order numbers before batching details.
- [ ] Treat a failed list request as a source-level exception. Treat a failed detail batch as partial coverage: increment `failedDetailBatches`, continue remaining batches, and return an `error` diagnostic after processing successes.

### 4. Implement privacy-safe line normalization

- [ ] Normalize one `Purchase` per usable merchandise line with `purchaseChannel: 'costco_com'`, `warehouseNumber: '847'`, `couponCents: 0`, and `grossUnitCents === paidUnitCents`.
- [ ] Convert money to integer cents with a decimal-safe helper and reject non-positive values.
- [ ] Require a positive integer ordered quantity and calculate:

```ts
const returned = Math.max(totalReturnedQuantity, returnedStatusQuantity);
const activeQuantity = Math.max(
  0,
  Math.min(orderedQuantity, orderedQuantity - cancelledQuantity - returned),
);
```

- [ ] Accept a line only if shipment/status data proves shipped, delivered, or pickup completed.
- [ ] Use a channel-qualified internal receipt/order identifier in the form `costco.com:<order number>` and a SHA-256 ID over an unambiguous channel/order/line tuple. Never put order numbers in errors or diagnostics.
- [ ] Retain a line when merchandise total differs from unit price times ordered quantity, but allocate no inferred discount.

### 5. Verify and commit Task 2

- [ ] Run `npm test -- tests/online-order-client.test.ts`.
- [ ] Run `npm run typecheck` and `npm run lint`.
- [ ] Run `git diff --check` and scan `src/costco/online-order-client.ts` for forbidden field names.
- [ ] Commit Task 2 with `git commit -m "feat: import Costco.com order lines"`.

---

## Task 3: Separate Price Collection and Eligibility by Purchase Channel

**Files:**

- Modify: `src/domain/types.ts`
- Modify: `src/costco/price-client.ts`
- Modify: `src/core/matcher.ts`
- Modify: `tests/price-client.test.ts`
- Modify: `tests/matcher.test.ts`

### 1. Add failing channel-isolation price tests

- [ ] Add `purchaseChannel` to the price-request test fixtures.
- [ ] For a mixed warehouse/Costco.com request list, assert warehouse, receipt-history, Warehouse Savings, and Same-Day fetches receive only warehouse requests while the Costco.com catalog fetch receives both exact items.
- [ ] Assert a Costco.com evidence row returns `not_applicable` observations for warehouse, Warehouse Savings, and Same-Day without invoking those sources. Receipt-history is assembled later in `fullReportRows` and receives the same `not_applicable` treatment there.
- [ ] Assert request deduplication distinguishes the same item in `warehouse` and `costco_com` scopes.
- [ ] Assert an online item-number mismatch or ambiguous/zero/malformed Costco.com price stays unavailable.
- [ ] Run `npm test -- tests/price-client.test.ts` and confirm the new channel-isolation tests fail.

### 2. Make price requests/evidence channel-aware

- [ ] Replace the warehouse-only request name with a channel-neutral `PriceRequest`, or provide a temporary exported alias while updating call sites:

```ts
export interface PriceRequest {
  readonly purchaseChannel: PurchaseChannel;
  readonly description?: string;
  readonly itemNumber: string;
  readonly warehouseNumber: string;
}

export interface ReportPriceEvidenceItem {
  readonly purchaseChannel: PurchaseChannel;
  readonly itemNumber: string;
  readonly warehouseNumber: string;
  readonly prices: ReportPriceChannels;
}
```

- [ ] Key evidence by `purchaseChannel`, item number, and warehouse/online scope. Never merge an online item into a warehouse evidence row even when item numbers match.
- [ ] In `fetchReportPriceEvidence`, partition requests by channel before starting network work. Keep current warehouse fan-out unchanged. For Costco.com purchases call only the exact Costco.com catalog lookup.
- [ ] Construct explicit `not_applicable` observations for online rows' warehouse, Warehouse Savings, and Same-Day channels with `unitPriceCents: null`, `source: null`, and `unavailableReason: 'not_applicable'`.
- [ ] Keep source diagnostics accurate when a source has no applicable requests; do not describe skipped online-only warehouse sources as errors.

### 3. Add failing online eligibility tests

- [ ] In `tests/matcher.test.ts`, add cases proving an exact lower Costco.com price creates a candidate with the active quantity savings, inclusive minimum-savings threshold, and local-calendar days remaining.
- [ ] Add non-candidate cases for equal/higher price, unavailable price, insufficient savings, outside-window order, item mismatch, and warehouse/Same-Day observations presented to an online purchase.
- [ ] Assert warehouse candidates retain their current behavior.
- [ ] Run `npm test -- tests/matcher.test.ts` and confirm the online tests fail.

### 4. Implement comparison-channel matching

- [ ] Add a domain type and fields that make the qualifying source explicit:

```ts
export type ComparisonChannel = 'warehouse' | 'costco_com' | 'same_day';

export interface AdjustmentCandidate {
  readonly comparisonChannel: ComparisonChannel;
  readonly purchase: Purchase;
  readonly observation: PriceObservation;
  readonly currentUnitCents: number;
  readonly savingsCents: number;
  readonly daysRemaining: number;
  readonly estimated?: boolean;
}
```

- [ ] Keep the existing verified warehouse matcher as the warehouse path and set `comparisonChannel: 'warehouse'` for verified observations and `'same_day'` for estimated opportunities.
- [ ] Add an online matcher that accepts only `purchaseChannel === 'costco_com'` purchases and exact usable Costco.com report observations. Reuse the existing date-window and minimum-savings policy helpers rather than duplicating boundary arithmetic.
- [ ] Calculate total online savings as `(paidUnitCents - currentUnitCents) * purchase.quantity`.
- [ ] Reject cross-channel inputs defensively even when upstream partitioning is wrong.

### 5. Verify and commit Task 3

- [ ] Run `npm test -- tests/price-client.test.ts tests/matcher.test.ts`.
- [ ] Run `npm run typecheck` and `npm run lint`.
- [ ] Run `git diff --check`.
- [ ] Commit Task 3 with `git commit -m "feat: match latest prices by purchase channel"`.

---

## Task 4: Orchestrate Independent Purchase Sources and Online Alerts

**Files:**

- Modify: `src/app/run.ts`
- Modify: `src/notifications/report.ts`
- Modify: `tests/run.test.ts`
- Modify: `tests/report.test.ts`
- Modify: `tests/cli-composition.test.ts`

### 1. Add failing mixed-source workflow tests

- [ ] Extend `RunDependencies` fixtures with `fetchOnlineOrderPurchases`.
- [ ] Add a successful mixed run: one warehouse purchase and one online purchase are imported, persisted, priced through their own channels, and counted separately.
- [ ] Add a lower exact Costco.com price case and assert an online candidate reaches both local/email notification filtering and delivery deduplication.
- [ ] Add receipt-source failure with online success, and online-source failure with receipt success. Each must generate reports, process only the successful source's current-window purchases, record the source-specific diagnostic, and finish `partial_failure`.
- [ ] Add both-source failure cases: shared authentication failure returns `auth_required`; otherwise the run returns `failure`.
- [ ] Add a partially failed detail-batch result and assert successful online lines continue while the run is `partial_failure`.
- [ ] Add a Costco.com price failure for one online item and assert all other items continue.
- [ ] Run `npm test -- tests/run.test.ts tests/cli-composition.test.ts` and confirm failures at the missing dependency/orchestration behavior.

### 2. Fetch and normalize purchase sources independently

- [ ] Add `fetchOnlineOrderPurchases` to `RunDependencies` and production composition.
- [ ] After one successful token capture, start warehouse receipt retrieval and online-order retrieval as separate settled operations using the same configured date window.
- [ ] Adapt warehouse receipts only when that source succeeded. Use online purchases only when the online source succeeded. Upsert the successful union in one database operation.
- [ ] When selecting recent purchases for this run, exclude cached rows from a purchase channel whose current source failed. This prevents a failed import from silently masquerading as current coverage.
- [ ] Merge the `costco_online_orders` diagnostic with existing source diagnostics.
- [ ] Derive the run outcome exactly as the spec states: one purchase source succeeds/one fails -> `partial_failure`; both fail -> `failure`; no successful purchase source and shared auth failure -> `auth_required`; individual detail/price/report/notification failure -> `partial_failure` as applicable.

### 3. Build mixed price requests, report rows, and candidates

- [ ] Update `uniquePriceRequests` to carry descriptions and purchase channel, deduplicating by channel/item/scope.
- [ ] Pair price evidence to purchases with the same channel-aware key.
- [ ] In `fullReportRows`, assign receipt-history evidence only for warehouse purchases and construct a `not_applicable` receipt-history observation for Costco.com purchases.
- [ ] Generate warehouse verified/estimated candidates only from warehouse purchases and online candidates only from Costco.com purchases, then merge them before notification deduplication.
- [ ] Extend `RunSummary` with explicit optional counters while retaining aggregate counters for compatibility:

```ts
readonly warehousePurchasesProcessed?: number;
readonly onlinePurchasesProcessed?: number;
readonly warehouseUnresolvedPrices?: number;
readonly onlineUnresolvedPrices?: number;
```

- [ ] Persist and print aggregate fields as before; update database run columns only if tests demonstrate the split counts must survive `recentRuns`. Otherwise keep split counts in the full report/CLI summary to avoid an unrelated migration.

### 4. Make alert text channel-correct

- [ ] Add failing `tests/report.test.ts` assertions that verified online candidates say `Costco.com order`, show the current Costco.com price, and do not say `WH 847`, `original warehouse`, or promise adjustment eligibility.
- [ ] Update compact, text, and HTML adjustment notification rendering to branch on `purchase.purchaseChannel` and `comparisonChannel`.
- [ ] Preserve the existing warehouse wording and explicitly label Same-Day-derived warehouse opportunities as estimates.
- [ ] Continue using purchase ID plus notification channel for delivery-state deduplication, so warehouse alert history is untouched and online lines are independent.

### 5. Verify and commit Task 4

- [ ] Run `npm test -- tests/run.test.ts tests/report.test.ts tests/cli-composition.test.ts`.
- [ ] Run `npm run typecheck` and `npm run lint`.
- [ ] Run `git diff --check`.
- [ ] Commit Task 4 with `git commit -m "feat: run warehouse and online matching together"`.

---

## Task 5: Upgrade Full Reports, Documentation, and End-to-End Coverage

**Files:**

- Modify: `src/domain/types.ts`
- Modify: `src/app/run.ts`
- Modify: `src/notifications/full-report.ts`
- Modify: `tests/full-report.test.ts`
- Modify: `tests/run.test.ts`
- Modify: `README.md`

### 1. Add failing full-report contract tests

- [ ] Add mixed warehouse/Costco.com HTML, CSV, and JSON fixtures.
- [ ] Assert every row contains purchase channel, receipt/order identifier, item number/description, purchase date, active quantity, paid unit price, comparison channel/price, unit delta, total potential savings, days remaining, status, reason, and all evidence channels.
- [ ] Assert Costco.com HTML displays `Costco.com`, never `Warehouse 847`, and visibly marks warehouse/receipt-history/Warehouse Savings/Same-Day evidence `not_applicable`.
- [ ] Assert warehouse rows retain the current evidence and Same-Day estimate presentation.
- [ ] Assert the HTML no longer contains the removed Unique item summary.
- [ ] Assert report validation accepts an online candidate only with an exact lower Costco.com comparison and rejects a cross-channel candidate.
- [ ] Run `npm test -- tests/full-report.test.ts tests/run.test.ts` and confirm failures for missing channel/comparison fields.

### 2. Extend the report row contract

- [ ] Add explicit comparison fields to `FullReportRow` while keeping `warehouseDeltaCents` temporarily if existing consumers/tests still need it:

```ts
readonly comparisonChannel: ComparisonChannel | null;
readonly comparisonUnitCents: number | null;
readonly comparisonDeltaCents: number | null;
readonly potentialSavingsCents: number | null;
```

- [ ] Populate these fields from the channel-specific qualifying/current observation. For a priced-but-not-lower item, show the comparison price and delta while leaving potential savings null or zero consistently with the tests.
- [ ] Bump `FullRunReport.schemaVersion` from `1` to `2` because JSON consumers receive new required semantic fields. Update manifest/tests that assert the schema version.

### 3. Render channel-aware HTML, CSV, and JSON

- [ ] Rename the source-document heading to `Receipt / order`.
- [ ] Add `Purchase channel`, `Comparison channel`, `Comparison price`, `Unit delta`, and `Potential savings` columns to CSV and the detailed HTML table.
- [ ] Use stable machine values (`warehouse`, `costco_com`, `same_day`) in CSV/JSON and friendly labels (`Warehouse`, `Costco.com`, `Same-Day estimate`) in HTML.
- [ ] Validate rows by purchase channel: warehouse candidates require the existing warehouse qualification; online candidates require a usable exact Costco.com price and `comparisonChannel: 'costco_com'`.
- [ ] Keep HTML escaping, owner-only file permissions, atomic report delivery, and partial-delivery cleanup behavior unchanged.
- [ ] Include the `costco_online_orders` source diagnostic and split coverage counts in the report summary.

### 4. Update user-facing documentation

- [ ] Update `README.md` to say the workflow imports both warehouse receipts and Costco.com orders.
- [ ] Explain strict channel separation, online fulfilled/active-quantity rules, exact current Costco.com comparison, supported alerts, partial-failure behavior, and the privacy rule that raw order responses/PII are never stored.
- [ ] Update report-field and limitations sections. State clearly that the tool reports potential savings and does not submit a price-adjustment request or guarantee Costco eligibility.

### 5. Run the full automated acceptance suite

- [ ] Run `npm test` and confirm every test passes.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run format:check`; run the repository formatter only on changed files if needed, then rerun the check.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Search changed production/test files for accidentally embedded auth values, real order numbers, PII fields, raw order fixtures, `.only`, `.skip`, and placeholder text.

### 6. Perform independent review and live acceptance

- [ ] Request an independent code review against the approved spec, with special focus on privacy, channel crossover, partial failure, active quantity arithmetic, date boundaries, and report validation. Resolve every substantive issue and rerun affected tests.
- [ ] Run the real workflow once with the existing authenticated dedicated Costco browser profile and configured notification behavior.
- [ ] Inspect only sanitized aggregate diagnostics and the generated local report. Do not print tokens, raw API payloads, order numbers, addresses, or other account data to the terminal/transcript.
- [ ] Confirm the live report contains warehouse and/or online rows available in the configured date window, every online row has an exact Costco.com price or precise unavailable reason, online rows display `Costco.com`, and failures in either purchase source do not suppress the other.
- [ ] Specifically regression-check item `1284156` and the description fallback for `KS ORG EVOO` when those warehouse items are present; preserve the previously verified Same-Day behavior.

### 7. Commit Task 5

- [ ] Review `git status --short` and exclude `.DS_Store`, reports, databases, browser profiles, tokens, and other local artifacts.
- [ ] Commit Task 5 with `git commit -m "feat: report Costco.com order savings"`.
- [ ] Record the final test/build/live-run evidence and generated report paths for the handoff.
