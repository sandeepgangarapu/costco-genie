# Full Price Report Design

## Goal

Every completed price-check run produces a durable report for every eligible purchase line, whether or not it is a price-match candidate.

## Identity and correctness

- A purchase is matched by Costco item number and original warehouse number. Description is display-only.
- Receipt item-array discount lines such as `/ 2048748` are allocated to item `2048748`; gross, discount, and net paid prices remain separately visible.
- A price-match candidate requires a verified current warehouse price for the same item number and warehouse, within 30 calendar days, below the net paid unit price.
- Costco.com and Same-Day prices are comparison-only and can never create a warehouse price-match candidate.
- Missing prices stay missing and carry a machine-readable reason; the report never substitutes an online price for a warehouse price.

## Report contents

The purchase-line table contains item number, description, warehouse, purchase timestamp, quantity, gross unit price, receipt discount, net paid unit price, current warehouse price, Costco.com price, Same-Day price when available, source and observation time for each current price, warehouse delta, remaining eligibility days, and status/reason.

The unique-item summary groups by item number and warehouse and shows the latest source observations alongside all qualifying purchase lines. Receipt-derived later prices may be shown as historical warehouse evidence with their receipt date, but not mislabeled as a live price.

## Artifacts

Each run writes equivalent JSON, CSV, and self-contained HTML files under `~/.costco-price-matcher/reports/`. Filenames use the run start timestamp. `latest.json`, `latest.csv`, and `latest.html` are atomically replaced after the timestamped files succeed. Reports are written for success, partial failure, auth-required, and failure outcomes; unsuccessful reports include diagnostics and may contain no rows.

## Authentication and price sources

Manual login uses a normal Chrome process aimed at Account Home. Runtime receipt authentication follows Costco's current web contract by obtaining the authorization and WCS client ID from the authenticated Orders request without logging token values. The authenticated Chrome profile must use the macOS keychain, not Playwright's mock keychain.

Warehouse price is exact only when the product response identifies warehouse pricing or when an explicit warehouse source provides it. The live Warehouse Savings page is a separate `warehouse_savings` source: exact item-number entries with a stated final warehouse price may be used as advertised warehouse-price evidence, while save-only entries, variable item numbers, expired promotions, and online-only entries remain promotion evidence rather than exact current prices. Costco.com catalog price and Same-Day price remain distinct optional observations. Source failures are isolated per item and surfaced in the report.

The Costco App has no supported desktop automation or public API. An assisted `Chat Us` refresh may later obtain selected-warehouse price and availability by item number, but it is not required for unattended runs and must report login, CAPTCHA, out-of-stock, and the documented 30-minute delay explicitly.

## Verification

Tests cover item-array discount allocation, duplicate item numbers, quantity discounts, receipt-to-receipt warehouse drops, source separation, candidate eligibility, CSV escaping, HTML escaping, atomic latest-file behavior, empty/auth-required reports, and CLI integration. Full tests, typecheck, lint, formatting, build, and a live report run must pass before completion.
