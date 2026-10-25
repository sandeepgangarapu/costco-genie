# Price sources and interpretation

- **Warehouse purchases** are compared with validated current Costco quotations for the original physical warehouse and exact item number. “Verified” means Costco reported a usable current quotation; it does not guarantee stock, a shelf tag, or adjustment eligibility.
- **Costco.com purchases** are compared with exact Costco.com prices. Online and warehouse comparisons stay separate.
- **Same-Day estimates** are optional, clearly labeled estimates used only for lines still missing a usable verified warehouse price. The browser is skipped when every warehouse line is verified. Estimates need manual verification at the warehouse and never become verified evidence.
- **Unresolved** means the app could not obtain a usable price. Costco's services do not expose every price, and their undocumented interfaces can change.

The app does not submit adjustment requests. Verify the item, price, date, quantity, and applicable Costco policy before requesting an adjustment. Identical alerts are suppressed; further price drops or approaching deadlines may produce another alert.

This is an unofficial personal tool, unaffiliated with Costco. Receipt and price coverage can change or stop working.

## Warehouse source precedence

The public display-price service is queried without cookies, in sequential batches of at most **eight distinct item numbers and one physical warehouse**. The app uses the warehouse on each receipt, never the online scope or a substitute warehouse. HTTP 200 and partial 206 responses are matched by exact item and warehouse; 404 means unavailable. HTTP 400 produces a configuration diagnostic. HTTP 403/429 triggers bounded backoff and a retry, then stops further display requests if throttling persists.

Source precedence for each warehouse line is:

1. Public warehouse display price, reconciled with the Warehouse Savings page.
2. A current, exact-item Warehouse Savings final when no usable display quotation exists.
3. The existing product GraphQL price, accepted only with the strict `WH` program gate.
4. Optional Same-Day inverse-markup estimate, for unresolved lines only.

The savings page is refreshed on every run with physical warehouse requests, independently of Same-Day. Display `onlinePrice` is the **base**, while `deliveredPrice` is the **effective final** after API discounts. The app validates positive USD amounts and discount arithmetic in integer cents. A matching booklet final is used once. If an API discount is missing, a current warehouse booklet's explicit final can fill it only when base minus the advertised discount corroborates that final. A “Save $X” amount alone never becomes a final or an extra subtraction. Expired, future, ambiguous, and online-only offers cannot establish a warehouse adjustment.

Reports retain each source, base, API discount, delivered final, booklet final, promotion dates, unit basis, and conflict reason. Missing display or booklet units remain **unknown**, and are compared as an **assumed package price**, labeled in the full report. Per-pound evidence from either source, variable-weight catalog metadata, or receipt descriptions such as “avg wt” block verification and allow the estimate fallback. Receipt imports expose integer package quantities, not actual weighed quantities; no average package weight conversion is used. A current final **below 50%** of the receipt's **net paid** unit price is retained for manual review as `warehouse_possible_unit_mismatch`, without a verified candidate. Exactly 50% is allowed. Requests shared by several receipts use the highest net paid unit price and preserve variable-weight evidence from any receipt. Conflicting finals also require review and allow estimates. These safeguards apply to booklet and strict WH fallbacks too; receipt coupons are already included in the net paid comparison.

In a **nonrandom 449-item October 2026 sample**, display coverage was about **97% of warehouse-evidenced items**. This is source coverage, not the rate of safe comparisons, price drops, inventory availability, or adjustment eligibility. There was **no shelf-tag validation**; rendered page comparisons share Costco's upstream service. Missing unit metadata, local differences, coupon conflicts, and changes to these undocumented interfaces remain limitations.

## Watchlist source policy

Watchlist warehouse evidence uses the same `resolveWarehousePriceEvidence`, display-price client and Warehouse Savings parser as receipt matching. Its explicit `watchlist` comparison mode allows a per-pound rate to baseline and compare with a prior per-pound rate, since no receipt package quantity is involved. Receipt mode retains every existing package and paid-price safeguard. Unknown watch units match only unknown units; missing units never imply package weight. A changed unit basis preserves the stored watch low, records an unverified diagnostic and uses the estimate fallback. Remove/re-add to intentionally establish a different unit baseline.

For watches, a conflicting local API discount keeps the local quotation as unverified evidence; it cannot lower the low. Explicit online-only savings and ambiguous cards quarantine the warehouse observation. Booklet coupons are fetched every check with warehouse items and a configured warehouse. Strict WH GraphQL remains the fallback when display/booklet pricing cannot answer.

Online watches use public product GraphQL with the storefront's online scope and exact item identity, followed by product-page parsing. Only online-applicable labels (Online Price, Your Price, Member Price, Price after savings, Current Price, Sale Price) in the exact item's detail area before fulfillment/recommendations can supply a displayed price. Warehouse Price, bare Price, unit/reference prices, and unrelated variants cannot. Warehouse Only means `warehouse_only`, even with a positive API price. Nonbuyable API records cannot supply an API price. Product IDs in URLs are never treated as item numbers.

Labeled displayed final/current prices take precedence, while both API and displayed amounts remain evidence. Split-line Online Price/OFF/total layouts require corroborating arithmetic; discounts are never blindly subtracted twice. API-only pricing is recorded as reported, with discount inclusion unconfirmed. Failed public pages produce one aggregate diagnostic.

Only explicit member-price gates trigger the signed-in product fallback. It uses the matcher's dedicated profile via `readWatchProductPricesLocked` while the caller holds `run.lock` for the entire Chrome lifecycle. Missing public data alone never opens that profile. Login redirects are detected without visiting login/account pages. No automatic interactive fallback opens a window during scheduled watch checks.

Same-Day is a watch fallback only for items lacking usable verified warehouse evidence in that check, including conflicts, implausible drops, or incompatible units. Otherwise history records `skipped_verified_warehouse_price`, displayed as “not needed (verified warehouse price)”; estimate lows remain unchanged and no Same-Day browser opens if every item is verified. The matcher guest client confirms the configured ZIP/address and exact item with a 180-second budget; transient search/deadline/location/browser-launch failures get one retry for affected items. Definitive misses do not retry. Raw Same-Day prices determine lows; the inverse-markup amount is display-only. Shipping, tax, quantity, variants, and stock can differ.

## Display-price interface

The public page uses `GET https://gdx-api.costco.com/catalog/product/dispprice-api/v3/display-price-lite`, with `whsNumber`, comma-separated `item`, `clientId`, `locale`, and a public `client-identifier` header. The client uses one physical warehouse per request, at most eight distinct digit-only item numbers, and no cookies. Online scope is rejected. HTTP 200/206 records map by exact item/warehouse; duplicate, non-USD, unsafe, nonpositive, or inconsistent prices are unusable. HTTP 403/429 gets one bounded retry honoring Retry-After up to ten seconds; persistent blocking stops later batches. Batch timeout is thirty seconds. These are undocumented public interfaces and can change.
