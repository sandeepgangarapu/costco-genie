// Ported from Costco Price Drop Checker; integrated with matcher boundaries.
import { wireCents } from './product.js';
export interface DisplayedPrice {
  cents: number | null;
  referenceCents: number | null;
  discountCents: number | null;
  promoEnd: string | null;
  memberGate: boolean;
  warehouseOnly: boolean;
  session: 'authenticated' | 'signed_out' | 'unknown';
}
export function detectSession(
  text: string,
  url = '',
): DisplayedPrice['session'] {
  if (
    /\/(?:LogonForm|signin|login)(?:[/?#]|$)/iu.test(url) ||
    /sign\s*in\s+(?:to\s+(?:see|view|reveal)|for)\s+(?:the\s+)?(?:member(?:-only)?\s+)?price|member(?:-only)?\s+price[^\n]*sign\s*in/iu.test(
      text,
    )
  )
    return 'signed_out';
  if (/\bsign\s*out\b|\blog\s*out\b/iu.test(text)) return 'authenticated';
  return 'unknown';
}
export function parseDisplayedPrice(
  text: string,
  itemNumber: string,
  url = '',
): DisplayedPrice {
  const result: DisplayedPrice = {
    cents: null,
    referenceCents: null,
    discountCents: null,
    promoEnd: null,
    memberGate: detectSession('', url) === 'signed_out',
    warehouseOnly: false,
    session: detectSession('', url),
  };
  // Restrict prices to this product's detail area, excluding recommendations/cart.
  const marker = new RegExp(
    `\\bItem\\s*(?:#|Number|No\\.?)?\\s*[:#]?\\s*${itemNumber}\\b`,
    'iu',
  ).exec(text);
  if (!marker) return result;
  const block = text
    .slice(marker.index, marker.index + 8_000)
    .split(
      /How\s+To\s+Get\s+It|Product\s+Details|Customers Also|Related Products|Recommended For|Recently Viewed|Reviews\s*\(/iu,
    )[0];
  // The product pill precedes the item marker; never read fulfillment prices or
  // sign-in prompts from recommendations/footer navigation as product evidence.
  const detail =
    text.slice(Math.max(0, marker.index - 500), marker.index) + block;
  result.warehouseOnly = /(?:^|\n)\s*Warehouse\s+Only\s*(?:\n|$)/iu.test(
    detail,
  );
  result.session = detectSession(block, url);
  if (
    result.session === 'unknown' &&
    /\bsign\s*out\b|\blog\s*out\b/iu.test(text)
  )
    result.session = 'authenticated';
  result.memberGate = result.session === 'signed_out';
  if (result.warehouseOnly) return result;
  const prices = new Set<number>();
  for (const m of block.matchAll(
    /(?:^|\n)\s*(?:Your\s+Price|Online\s+Price|Member(?:-only)?\s+Price|Price\s+after\s+(?:instant\s+)?savings|Current\s+Price|Sale\s+Price)\s*[:\n]?\s*\$?\s*(\d[\d,]*\.\d{2})\b/giu,
  )) {
    if (
      /List\s*$|Regular\s*$|Original\s*$/iu.test(
        block.slice(Math.max(0, m.index! - 12), m.index),
      )
    )
      continue;
    const cents = wireCents(m[1]);
    if (cents) prices.add(cents);
  }
  const reference =
    /(?:List|Regular|Original)\s+Price\s*[:\n]?\s*\$?\s*(\d[\d,]*\.\d{2})/iu.exec(
      block,
    )?.[1];
  result.referenceCents = wireCents(reference);
  const discounts = [
    ...block.matchAll(
      /\$\s*(\d[\d,]*(?:\.\d{2})?)\s*(?:OFF|Instant\s+Savings)|(?:Instant\s+Savings|Less)\s*[:\n]?\s*-?\$\s*(\d[\d,]*(?:\.\d{2})?)/giu,
    ),
  ]
    .map((m) => wireCents(m[1] ?? m[2]))
    .filter((n): n is number => n !== null);
  if (new Set(discounts).size === 1) result.discountCents = discounts[0];
  result.promoEnd =
    /(?:valid\s+(?:through|thru)|ends?|expires?|expiration\s+date|through)\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/iu.exec(
      block,
    )?.[1] ?? null;
  // A labeled final/member/current price already includes the displayed savings.
  // Ambiguous multiple prices are not guessed, and "$X OFF" alone is not a price.
  if (prices.size === 1) result.cents = [...prices][0];
  const finalPrices = new Set(
    [
      ...block.matchAll(
        /(?:^|\n)\s*(?:Your\s+Price|Member(?:-only)?\s+Price|Price\s+after\s+(?:instant\s+)?savings|Current\s+Price|Sale\s+Price)\s*[:\n]?\s*\$?\s*(\d[\d,]*\.\d{2})\b/giu,
      ),
    ]
      .map((m) => wireCents(m[1]))
      .filter((n): n is number => n !== null),
  );
  if (finalPrices.size === 1) result.cents = [...finalPrices][0];
  const onlineLabels = [
    ...block.matchAll(
      /(?:^|\n)\s*Online\s+Price\s*[:\n]?\s*\$\s*(\d[\d,]*\.\d{2})/giu,
    ),
  ];
  const onlineLabel = onlineLabels[0];
  if (
    onlineLabel &&
    new Set(onlineLabels.map((m) => wireCents(m[1]))).size === 1 &&
    finalPrices.size === 0
  ) {
    const base = wireCents(onlineLabel[1]);
    const header = block
      .slice(onlineLabel.index, onlineLabel.index + 250)
      .split(/Add\s+to\s+Cart|Shipping|Delivery|Compare|Per\s+unit/iu)[0];
    const amounts = [...header.matchAll(/\$\s*(\d[\d,]*(?:\.\d{2})?)\b/gu)].map(
      (m) => wireCents(m[1]),
    );
    const discount = result.discountCents;
    if (base !== null && discount !== null && base > discount) {
      // Costco's observed split-line layout lists Online Price, $X OFF, then
      // a separate $ / amount total. Require the net amount to be displayed.
      const net = base - discount;
      if (
        amounts.includes(net) &&
        (net !== discount ||
          amounts.filter((value) => value === net).length >= 2)
      ) {
        result.referenceCents ??= base;
        result.cents = net;
      } else if (amounts.includes(base + discount)) {
        // The live storefront also labels the discounted amount "Online
        // Price" and renders the reference total later in DOM order. Accept
        // that layout only when the larger displayed amount corroborates it.
        result.referenceCents ??= base + discount;
        result.cents = base;
      } else if (finalPrices.size === 0) {
        // Base plus discount without a corroborating total is ambiguous.
        result.cents = null;
      }
    } else if (base !== null && discount === null && finalPrices.size === 0) {
      result.cents = base;
    }
  }
  return result;
}
