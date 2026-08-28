# Online Orders and Latest Costco.com Prices Design

## Objective

Extend the Costco price matcher so each run imports recent Costco.com orders, obtains the latest exact Costco.com price for every eligible online line item, reports the comparison, and sends the existing local and email alerts when the current price is lower. Warehouse purchases and online purchases must remain semantically separate: a Costco.com price can qualify only an online purchase, and a warehouse price can qualify only a warehouse purchase.

## Scope

The feature covers Costco.com orders returned by Costco's authenticated Orders GraphQL service. It uses the existing receipt-fetch window, adjustment window, minimum-savings threshold, notification channels, persistence, and full-report delivery.

It does not import Same-Day order history, submit price-adjustment requests, initiate returns, treat shipping or fee reductions as merchandise price drops, or substitute Same-Day or warehouse prices for an online comparison.

## Architecture

The application keeps one normalized purchase pipeline with an explicit purchase channel:

- `warehouse` purchases continue through the existing receipt and same-warehouse price flow.
- `costco_com` purchases enter through a new online-order client and compare only with the `costco_com` price observation for the exact item number.

The common storage, report, notification-deduplication, and run-summary infrastructure is reused. Channel-specific import and matching functions remain isolated so an online record cannot accidentally qualify under warehouse rules.

## Authenticated Online-Order Client

The new client calls the same trusted endpoint and uses the same short-lived authenticated headers as the receipt client:

`POST https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql`

It performs two operations:

1. `getOnlineOrders` lists orders for the configured date range. The request uses Costco's observed online warehouse identifier `847`, starts at page 1, uses a page size of 10, and continues until `totalNumberOfRecords` is exhausted or a page returns fewer records than requested.
2. `getOrderDetails` loads detail records in bounded batches of at most 10 order numbers.

The application owns minimal GraphQL queries instead of replaying Costco's full browser queries. The list query requests only order number, ordered date, order status, and pagination fields. The detail query requests only order number, ordered date, order status, and the line fields required for matching: stable line identifier, item number, item description, unit price, ordered quantity, merchandise total, fee flag, line status, returned quantity, returnable quantity, cancelled/returned/shipped/delivered status quantities, and shipment pickup-completed date.

The client must not request, log, persist, or place in diagnostics any name, address, email address, phone number, membership number, payment method, card data, tracking number, or raw order response.

Authentication failures use the existing `AuthRequiredError`. Malformed payloads, pagination inconsistencies, non-2xx responses, and timeouts use sanitized `CostcoApiError` diagnostics. Tokens and order numbers never appear in error text.

## Online-Line Normalization

Each usable merchandise line becomes one normalized `Purchase` with `purchaseChannel: 'costco_com'`. Existing records migrate to `purchaseChannel: 'warehouse'` without changing their IDs or behavior.

An online line is usable only when all of the following are true:

- The order and line are not wholly cancelled or returned.
- The line has reached a fulfilled status: shipped, delivered, or pickup completed.
- `isFeeItem` is not true.
- The item number is a numeric Costco item number.
- Unit price is positive money in integer cents.
- Ordered quantity is a positive integer.
- The active quantity is positive. It is calculated as ordered quantity minus the cancelled-status quantity and minus the greater of `totalReturnedQuantity` or the returned-status quantity, then clamped to the ordered quantity range so duplicated return summaries are not counted twice.

The normalized quantity is the active quantity. `paidUnitCents` and `grossUnitCents` use the line's authenticated unit price. If a positive merchandise total disagrees with unit price multiplied by ordered quantity, the line is retained but no unverified order-level discount is allocated to it; `couponCents` remains zero. Shipping, handling, surcharges, taxes, order-level discounts, and shop-card payments are not allocated to merchandise lines.

`receiptId` stores a channel-qualified source document identifier derived from the order number, and the purchase ID is a deterministic hash of the channel, order number, and stable line identifier. Re-importing the same order is idempotent. The report labels this field "Receipt / order" rather than implying every value is a warehouse receipt.

Online records retain Costco's order warehouse value only as source metadata needed by the existing schema. Matching logic dispatches on `purchaseChannel`, never on that warehouse value. The report displays the purchase location as `Costco.com`, not warehouse `847`.

## Storage Migration

The `purchases` table gains a non-null `purchase_channel` column constrained in application code to `warehouse` or `costco_com`. Existing databases are migrated with `TEXT NOT NULL DEFAULT 'warehouse'`.

All purchase reads and writes include the new field. Existing alert-delivery keys remain purchase IDs, so warehouse alert history remains intact and online lines receive independent channel-specific deduplication.

No raw online-order JSON is stored.

## Latest-Price Collection

Price requests include the purchase channel. Requests are deduplicated by purchase channel, item number, and price scope.

- Warehouse requests continue to collect warehouse, receipt-history, Warehouse Savings, Costco.com, and Same-Day evidence.
- Online requests call only the existing exact-item Costco.com catalog lookup. Warehouse, Warehouse Savings, receipt-history, and Same-Day channels return `not_applicable` for those rows without making network requests.

The Costco.com observation is usable only when the catalog response verifies the exact item number and exposes one positive current price. Missing, zero, ambiguous, malformed, or failed prices remain unavailable and cannot generate an alert.

## Eligibility and Alerts

Warehouse eligibility remains unchanged.

An online line is a candidate only when:

- It is within `adjustmentWindowDays`, using the order's printed calendar date and the Mac's local current date.
- The exact current Costco.com unit price is lower than `paidUnitCents`.
- `(paidUnitCents - current Costco.com unit price) * active quantity` is at least `minimumSavingsCents`.

The candidate records `comparisonChannel: 'costco_com'`, the current unit price, unit delta, total savings, and days remaining. Local and email alerts explicitly say `Costco.com order`; they do not call the result a warehouse price adjustment. Existing per-purchase, per-notification-channel deduplication applies, and a further price drop can alert again under the current policy.

The software only reports a potential adjustment. It does not promise eligibility or submit a request to Costco.

## Report

The full HTML, CSV, and JSON reports remain one artifact set and contain both purchase channels. Each purchase line includes:

- Purchase channel (`Warehouse` or `Costco.com`)
- Receipt/order identifier
- Item number and description
- Purchase date and active quantity
- Paid unit price
- The current comparison channel and price
- Unit delta, total potential savings, days remaining, status, and reason
- The existing evidence columns

For online rows, the Costco.com price is the comparison price and non-applicable warehouse evidence is visibly marked `not_applicable`. For warehouse rows, the existing verified-warehouse and estimated Same-Day behavior remains unchanged.

Source diagnostics add a `costco_online_orders` entry with `ok`, `unavailable`, or `error` status and a sanitized summary. Counts distinguish warehouse purchases, online purchases, warehouse-price unresolved items, and online-price unresolved items so the CLI does not describe online coverage as a warehouse failure.

## Failure Isolation

Receipt retrieval and online-order retrieval run as separate authenticated source steps after one token capture.

- If either warehouse receipt retrieval or online-order retrieval fails while the other succeeds, the run continues with the successful source, records a source-specific error diagnostic, and finishes as `partial_failure`.
- If both purchase sources fail, the run finishes as `failure`. A shared authentication failure remains `auth_required`.
- If an individual online order detail batch fails, the client records that batch as unavailable, continues later batches, and reports partial coverage without inventing purchases.
- If a Costco.com price lookup fails, only the affected item is unavailable; other online and warehouse items continue.

## Testing

Tests use injected fetch functions and sanitized fixtures. No test opens a real account or stores live order values.

Coverage includes:

- Online-order list pagination and detail batching
- Minimal GraphQL fields and authenticated headers
- Malformed response, authorization, timeout, and partial-batch handling
- Fee, cancelled, returned, partially returned, invalid-item, invalid-price, and invalid-quantity filtering
- Deterministic IDs and idempotent database migration/upsert behavior
- Strict channel-separated price requests and exact-item Costco.com matching
- Online eligibility boundaries, savings threshold, active quantity, and date window
- Online alert wording and notification deduplication
- HTML, CSV, and JSON purchase-channel fields and non-applicable evidence
- Online-source failure isolation while warehouse processing succeeds
- Existing warehouse, Same-Day fallback, and report behavior as regression coverage

## Acceptance Criteria

1. A live run imports all usable Costco.com lines within the configured fetch window and does not expose personal order data in logs or diagnostics.
2. Every online line in the report either has an exact latest Costco.com price or a precise unavailable reason.
3. A lower exact Costco.com price within policy produces a clearly labeled potential online adjustment and follows normal notification deduplication.
4. Online prices never qualify warehouse purchases, and warehouse or Same-Day prices never qualify online purchases.
5. Online-source failure cannot prevent warehouse receipt processing or report generation.
6. Database migration preserves all existing purchases and alert state.
7. The full automated suite, typecheck, lint, formatting, build, independent review, and a live workflow inspection pass before completion.
