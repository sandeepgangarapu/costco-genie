# Costco Price Matcher Design

## Objective

Build a low-frequency, personal macOS automation that finds potential Costco warehouse price adjustments. It imports recent in-warehouse receipts from Costco's authenticated receipt API, queries the current price for the same item number at the same warehouse, persists observations locally, and sends deduplicated alerts through Notification Center and Apple Mail.

The integration is unofficial. It must behave conservatively: one scheduled run per day, small batched requests, no CAPTCHA or MFA automation, and no claim that an alert guarantees adjustment eligibility.

## Product decisions

- Run locally on this Mac; no cloud services.
- Use a LaunchAgent at 9:00 AM and run at login. A freshness check performs a missed run after the Mac next wakes or the user next logs in.
- Use a dedicated Playwright browser profile for Costco authentication. The application never stores a Costco password.
- Use direct HTTP APIs for receipt and price data. Browser automation is limited to login/session refresh and is not used to click through every item.
- Compare exact Costco item numbers only. Never use fuzzy or LLM matching for financial alerts.
- Compare a warehouse purchase only with a current price scoped to that receipt's warehouse number.
- Send both a macOS notification and an Apple Mail message. Apple Mail is already configured; it supplies the sender and default self-recipient at runtime.
- Do not create commits during implementation.

## System boundaries

### Authentication bridge

`costco login` opens `~/.costco-price-matcher/browser-profile` in installed Chrome through Playwright. The user signs in manually. Scheduled receipt sync launches the same profile headlessly, navigates to Costco Account Home, and reads `clientID` and `idToken` from Costco local storage. If either is absent, the run stops safely and emits a local re-login alert.

### Receipt client

The client calls:

`POST https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql`

It requests the previous 35 days and supplies the authenticated Costco headers. The normalizer rejects returns/refunds, requires numeric item and warehouse numbers, defaults missing quantity to one, associates coupon records by item number, and stores integer cents. Receipt identity is deterministic, so repeated syncs are idempotent.

### Warehouse price client

The client calls:

`POST https://ecom-api.costco.com/ebusiness/product/v1/products/graphql`

Requests are grouped by warehouse number and split into batches of at most 25 item numbers. A usable observation requires:

- the returned item number to match the requested item number;
- `programTypes` to contain `WH`;
- `priceData.price` to parse to a positive number;
- the response to be successful GraphQL data without errors.

Missing products, price zero, online-only products, malformed results, and request failures become unresolved observations. They never become adjustment opportunities. This provider covers Costco products returned by the product service; the application reports its measured coverage rather than pretending it covers warehouse-only inventory that the service omits.

### Matcher

The default eligibility window is 30 calendar days, using the date printed on the Costco receipt and the Mac's current local calendar date. Offset or UTC timestamps do not shift a printed warehouse purchase into an adjacent day. A purchase is a candidate only when its current same-warehouse price is lower than its paid unit price. Potential savings equal `(paid unit cents - current unit cents) * quantity`. Days remaining are clamped to the inclusive adjustment window. Results are sorted by days remaining, then savings descending.

The application labels every result "potential" and tells the user to verify it at the original warehouse. It does not submit adjustment requests.

### Persistence

SQLite lives at `~/.costco-price-matcher/costco.sqlite` and contains:

- `purchases`: normalized receipt lines with deterministic IDs;
- `price_observations`: timestamped same-warehouse results, including unresolved results and source;
- `alert_state`: last price and urgency bucket notified for each purchase;
- `runs`: run start/end, outcome, and counts.

Raw API payload fragments are stored only for the relevant receipt line or product result, not entire account responses.

### Notifications

The report renderer produces compact plain text for Notification Center and a detailed plain-text email for Apple Mail. Apple Mail's supported scripting property is rich text and does not reliably parse an assigned string as HTML, so the automation does not pretend HTML markup will render. A run notifies only when it finds a new lower price, a further price reduction, or a candidate that has entered a more urgent bucket (`normal`, `3-days`, `1-day`). Apple Mail sends the detailed report to a configured recipient; if none is configured, the notifier resolves the first address on an enabled Mail account and sends to self.

### Scheduling

The generated LaunchAgent contains:

- `RunAtLoad = true`;
- `StartCalendarInterval = 09:00` daily;
- absolute paths for Node, the compiled CLI, logs, and working directory.

Scheduled invocation skips when a successful run completed within the previous 20 hours. A parent-held BSD advisory file lock prevents overlap and releases automatically on process exit. The installer validates a temporary plist before atomically replacing the installed plist, preserves and restores the prior configuration and loaded state when replacement fails, verifies that the Node and CLI targets exist, and refuses Node versions below the declared minimum. Moving the checkout or replacing the installed Node runtime requires reinstalling the LaunchAgent.

## Configuration

`~/.costco-price-matcher/config.json` contains non-secret settings:

```json
{
  "daysToFetch": 35,
  "adjustmentWindowDays": 30,
  "scheduledHour": 9,
  "scheduledMinute": 0,
  "emailRecipient": null,
  "priceBatchSize": 25,
  "minimumSavingsCents": 1
}
```

Secrets and browser state remain outside the repository. The repository ignores build output, dependencies, local databases, logs, browser profiles, and environment files.

## Failure handling

- Missing Costco session: stop before receipt access, record `auth_required`, and send a local notification.
- Rejected or expired Costco session (HTTP 401/403 or an authentication GraphQL error): treat it identically to a missing session and show the `costco login` recovery instruction.
- Receipt API failure: record failure and retain existing purchases.
- Individual price batch failure: record unresolved observations for that batch and continue other warehouses/batches.
- No usable warehouse price: show it in run statistics but send no adjustment alert.
- Mail failure: retain alert state as unsent and still show the local notification; a later run retries email.
- Notification Center failure: continue to email and record the channel error.
- Database or lock failure: exit nonzero and write a diagnostic log.

## Testing

- Unit tests cover money parsing, receipt/coupon normalization, exact matching, date boundaries, urgency buckets, report rendering, notification deduplication, GraphQL validation, configuration, and plist generation.
- HTTP tests use local fake servers or injected fetch functions; authenticated receipt data never appears in fixtures.
- Process-launch tests inject an executor and assert arguments rather than sending real notifications or email. Email content is plain text because that is the reliable writable Apple Mail scripting boundary.
- `status` and the default `doctor` command are offline and read-only: they do not create configuration/database files or launch Chrome. Doctor reports whether a dedicated browser profile exists; live session verification occurs during `run` or `login`.
- A live-safe price probe calls Costco's unauthenticated product GraphQL with a public sample item and never modifies an account.
- Full verification runs formatting/type checks, the complete test suite, a production build, CLI help, plist validation, and the live-safe probe.

## Acceptance criteria

1. `npm test`, `npm run typecheck`, and `npm run build` pass.
2. Re-importing the same receipt does not duplicate a purchase.
3. Only an exact item number with a positive `WH` price can produce a candidate.
4. The same item bought at two warehouses is checked and compared separately.
5. Repeated identical runs do not repeat alerts; increased urgency or a lower price does.
6. Notification and email behavior is testable without sending external messages.
7. The LaunchAgent is valid, uses absolute paths, and catches up at login without running more than once per 20 hours.
8. Authentication failure gives a clear `costco login` recovery instruction.
