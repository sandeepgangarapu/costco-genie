// Ported from Costco Price Drop Checker; integrated with matcher boundaries.
import { parseMoneyToCents } from '../lib/money.js';

export function wireCents(value: unknown): number | null {
  // Origin: costco-genie/src/costco/price-client.ts.
  if (typeof value === 'number' && Number.isFinite(value))
    value = String(value);
  const cents =
    typeof value === 'string'
      ? parseMoneyToCents(value.replace(/(\.\d{2})0+$/u, '$1'))
      : null;
  return cents !== null && cents > 0 ? cents : null;
}
export function productUrl(itemNumber: string): string {
  return `https://www.costco.com/.product.${itemNumber}.html`;
}
export function parseItemInput(
  input: string,
): { itemNumber: string } | { url: string; productId: string | null } {
  if (/^\d+$/u.test(input)) return { itemNumber: input };
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Use an item number or a Costco.com product URL');
  }
  if (
    url.protocol !== 'https:' ||
    !['costco.com', 'www.costco.com'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    /account|orders|receipt|logon|signin/iu.test(url.pathname)
  ) {
    throw new Error('Use a public HTTPS Costco.com product URL');
  }
  const pathId = /(?:\.product\.|\/product\/)(\d+)(?:\.html|\/|$)/iu.exec(
    url.pathname,
  )?.[1];
  const queryId =
    url.pathname.toLowerCase() === '/productdisplay'
      ? url.searchParams.get('productId')
      : null;
  const productId = pathId ?? queryId;
  if (productId && !/^\d+$/u.test(productId))
    throw new Error('Invalid product ID');
  const pathProduct =
    /^\/p\/[^/]+/u.test(url.pathname) ||
    /^\/[^/]+\/\d+\.html$/u.test(url.pathname);
  if (!productId && !pathProduct)
    throw new Error('URL must identify a Costco product page');
  url.hash = '';
  url.search = '';
  if (queryId && !pathId) url.searchParams.set('productId', queryId);
  return { url: url.toString(), productId };
}
export interface CatalogItem {
  itemNumber: string;
  name: string | null;
  url: string;
}

export async function fetchProductHtml(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ html: string; url: string } | null> {
  let current = url;
  for (let redirects = 0; redirects < 5; redirects += 1) {
    const parsed = parseItemInput(current);
    if (!('url' in parsed)) return null;
    current = parsed.url;
    const response = await fetchFn(current, {
      signal: AbortSignal.timeout(30_000),
      redirect: 'manual',
      credentials: 'omit',
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) return null;
      current = new URL(location, current).toString();
      const redirect = new URL(current);
      // Expose the gate without visiting the login page or following accounts.
      if (
        redirect.protocol === 'https:' &&
        ['www.costco.com', 'costco.com'].includes(redirect.hostname) &&
        /\/(?:LogonForm|signin|login)(?:[/?]|$)/iu.test(redirect.pathname)
      )
        return { html: '', url: current };
      continue;
    }
    return response.ok ? { html: await response.text(), url: current } : null;
  }
  return null;
}

function decode(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}
export function catalogProductName(product: {
  name?: unknown;
  productName?: unknown;
  description?: unknown;
}): string | null {
  const description = product.description;
  const shortDescription =
    description &&
    typeof description === 'object' &&
    'shortDescription' in description
      ? description.shortDescription
      : null;
  for (const value of [
    product.name,
    product.productName,
    description,
    shortDescription,
  ]) {
    if (typeof value === 'string' && value.trim()) return decode(value.trim());
  }
  return null;
}
export function parseProductPage(
  html: string,
  url: string,
): CatalogItem | null {
  const products: Record<string, unknown>[] = [];
  function collect(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record['@type'] === 'Product') products.push(record);
    if (record['@graph']) collect(record['@graph']);
  }
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu,
  )) {
    try {
      collect(JSON.parse(match[1]));
    } catch {
      /* Ignore unrelated malformed metadata. */
    }
  }
  const skus = new Set(
    products.map((p) => String(p.sku ?? '')).filter((n) => /^\d+$/u.test(n)),
  );
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '')
    .replace(/<[^>]+>/gu, ' ');
  const displayed = [
    ...text.matchAll(/\bItem\s*(?:#|Number|No\.?)?\s*[:#]?\s*(\d{3,})\b/giu),
  ].map((m) => m[1]);
  if (skus.size === 0) displayed.forEach((n) => skus.add(n));
  if (skus.size !== 1) return null;
  const itemNumber = [...skus][0];
  // Conflicting displayed identity is unsafe (variants/recommendations).
  if (displayed.some((n) => n !== itemNumber)) return null;
  const name = products.find((p) => String(p.sku) === itemNumber)?.name;
  const title = /<title[^>]*>([^<]+)<\/title>/iu
    .exec(html)?.[1]
    ?.replace(/\s*\|\s*Costco.*$/iu, '');
  return {
    itemNumber,
    name: catalogProductName({ name, description: title }),
    url,
  };
}

export async function resolveProduct(
  input: string,
  fetchFn: typeof fetch = fetch,
): Promise<CatalogItem> {
  const parsed = parseItemInput(input);
  if ('itemNumber' in parsed)
    return { ...parsed, name: null, url: productUrl(parsed.itemNumber) };
  const response = await fetchProductHtml(parsed.url, fetchFn);
  if (!response)
    throw new Error(
      'Product page unavailable; add the printed item number instead',
    );
  const catalog = parseProductPage(response.html, response.url);
  if (!catalog)
    throw new Error(
      'Could not resolve the product URL to one item number; use the printed item number',
    );
  return catalog;
}
