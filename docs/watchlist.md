# Costco Genie: Watchlist

Watch items you have not bought yet, independently of receipt adjustments.

```sh
./costco setup --watch-warehouse YOUR_WAREHOUSE
./costco watch add ITEM_NUMBER --name "Item to watch"
./costco watch add 'https://www.costco.com/example.product.100000000.html' --channel online
./costco watch add ITEM_NUMBER --channel warehouse --no-check
./costco watch list
./costco watch history ITEM_NUMBER
./costco watch check --dry-run
./costco watch check
./costco watch check --item ITEM_NUMBER
./costco watch remove ITEM_NUMBER
```

The default channel is `both`. A URL is resolved to its actual item number from product metadata or the displayed item number; a product ID is never assumed to be an item number. Ambiguous or inaccessible URLs fail with instructions to use the printed item number. Catalog or page names are retained when available; `--name` overrides them. Placeholder names are filled in on later checks without resetting lows. `--no-check` skips baseline lookup (a URL still needs identity resolution).

Watch checks use public sources. Only member-gated Costco.com prices need `./costco login`; receipt runs always need the signed-in session.

Adding records available baselines and sends no email. If a price is unavailable, its first usable observation becomes its baseline. `watch list` shows the latest observation, stored alert low, and last checked time for each kind; the latest may be unavailable even if an older usable price exists. Removing stops checks and cancels queued alerts while retaining history. Re-adding a removed item starts a new watch period.

`watch check` records observations and new lows, then sends one price-drop email with all pending new lows. No drop means no price-drop email. A failed delivery stays queued for retry. A drop smaller than `minimumDropCents` is recorded in history but leaves the stored alert low unchanged, allowing small drops to accumulate toward the threshold. For example, with a $1 threshold and a $20 baseline, $19.60 and $19.20 stay silent; $19 triggers the alert and becomes the next comparison low. `watch list` shows this alert low; history retains every observed price. `--dry-run` contacts sources and prints would-be results, with no database writes, email, or notice-state changes. A shared-profile browser visit can still update Chrome's own session files.

Plausibility guard: when displayed and API prices differ by more than 50% of the API price, or a candidate new low is less than 50% of the previous low, the email marks that drop **unverified — check before buying**, explains why, and does not lower the stored low. This applies even if a steep drop might be legitimate. Exactly 50% does not trigger the guard. Conflicting displayed/API evidence cannot establish a first baseline; it is recorded with a diagnostic and no email. Each new unverified low is reported once; a failed delivery stays queued for retry.

Each item has separate `online`, `warehouse`, and `warehouse_estimate` lows. Online channel records only online; warehouse records verified warehouse and estimate; both records all three. Warehouse needs your configured physical warehouse. See [price sources](price-sources.md) for precedence, units, coupon handling, member-gated fallback, estimate eligibility and coverage caveats.

A unit-basis change never alerts or lowers the low. A sub-threshold drop remains history until drops accumulate relative to the stored alert low; a rebound/equal price cannot alert. Unverified drops preserve the stored low and are sent once per new unverified low, with queued delivery retry. Source disagreement cannot establish a first baseline. Exactly 50% is allowed by the plausibility guards.

[Email](email.md) describes Apple Mail/SMTP delivery. [Scheduling](scheduling.md) covers daily success guards and operational notices. A watch session-expired notice requires an explicit unresolved price gate or login redirect, once per episode; authenticated/no-gate results reset it. Failed or ambiguous browser results never create stale expiry notices. Three failed scheduled checks trigger one operational notice per streak.
