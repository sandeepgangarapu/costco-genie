// Adapted from costco-genie/src/costco/price-client.ts (public GraphQL).
import { z } from 'zod';
import { catalogProductName, wireCents } from './product.js';

export const PRODUCT_ENDPOINT =
  'https://ecom-api.costco.com/ebusiness/product/v1/products/graphql';
// Public storefront application identifier, not a member credential.
import { PRODUCT_CLIENT_ID } from './public-storefront.js';
export interface ApiPrice {
  cents: number | null;
  reason: string | null;
  memberOnly: boolean;
  warehouseOnly?: boolean;
  name: string | null;
  url: string | null;
}
const responseSchema = z.object({
  data: z.object({ products: z.object({ catalogData: z.array(z.unknown()) }) }),
  errors: z.array(z.unknown()).optional(),
});
const productSchema = z.object({
  itemNumber: z.string(),
  programTypes: z.union([z.string(), z.array(z.string())]).optional(),
  priceData: z.object({ price: z.unknown().optional() }).nullish(),
  memberOnly: z.boolean().optional(),
  buyable: z.number().optional(),
  attributes: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .optional(),
  name: z.string().optional(),
  productName: z.string().optional(),
  description: z
    .union([z.string(), z.object({ shortDescription: z.string().optional() })])
    .nullish(),
  productUrl: z.string().optional(),
});
export function parseApiPrices(
  payload: unknown,
  items: readonly string[],
  kind: 'online' | 'warehouse',
): Map<string, ApiPrice> {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.errors?.length)
    throw new Error('Invalid product response');
  const result = new Map<string, ApiPrice>();
  for (const item of items) {
    const exact = parsed.data.data.products.catalogData.filter(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        'itemNumber' in p &&
        p.itemNumber === item,
    );
    const candidate =
      exact.length === 1 ? productSchema.safeParse(exact[0]) : null;
    const product = candidate?.success ? candidate.data : null;
    const programs = Array.isArray(product?.programTypes)
      ? product.programTypes
      : (product?.programTypes?.split(/[,|\s]+/u) ?? []);
    // Keep the matcher's WH requirement. InWarehouse in an ONLINE response alone
    // does not prove that priceData.price is the local warehouse selling price.
    const verified = kind === 'online' || programs.includes('WH');
    const warehouseOnly =
      programs.some((p) => /^warehouse[_ -]?only$/iu.test(p)) ||
      product?.attributes?.some(
        (a) =>
          /^warehouse\s+only$/iu.test(a.key.trim()) ||
          /^warehouse\s+only$/iu.test(a.value.trim()),
      ) === true;
    const onlineUnavailable =
      kind === 'online' && (warehouseOnly || product?.buyable === 0);
    const cents =
      verified && !onlineUnavailable
        ? wireCents(product?.priceData?.price)
        : null;
    result.set(item, {
      cents,
      reason:
        exact.length > 1
          ? 'ambiguous_price'
          : !product
            ? 'product_not_found'
            : onlineUnavailable
              ? warehouseOnly
                ? 'warehouse_only'
                : 'not_online_buyable'
              : !verified
                ? 'not_verified_warehouse_price'
                : cents === null
                  ? 'invalid_price'
                  : null,
      memberOnly: product?.memberOnly === true,
      warehouseOnly,
      name: product ? catalogProductName(product) : null,
      url: product?.productUrl ?? null,
    });
  }
  return result;
}
export async function fetchApiPrices(
  items: readonly string[],
  warehouse: string,
  kind: 'online' | 'warehouse',
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, ApiPrice>> {
  if (!/^\d+$/u.test(warehouse) || items.some((n) => !/^\d+$/u.test(n)))
    throw new Error('Invalid product lookup scope');
  const results = new Map<string, ApiPrice>();
  for (let offset = 0; offset < items.length; offset += 25) {
    const batch = items.slice(offset, offset + 25);
    try {
      const response = await fetchFn(PRODUCT_ENDPOINT, {
        method: 'POST',
        credentials: 'omit',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'Content-Type': 'application/json',
          'client-identifier': PRODUCT_CLIENT_ID,
          'costco.env': 'ecom',
          'costco.service': 'restProduct',
        },
        body: JSON.stringify({
          query: `query { products(itemNumbers: ${JSON.stringify(batch)}, clientId: "${PRODUCT_CLIENT_ID}", locale: "en-us", warehouseNumber: "${warehouse}") { catalogData { itemNumber programTypes buyable attributes { key value } description { shortDescription } priceData { price } } fulfillmentData { itemNumber warehouseNumber } } }`,
          variables: {},
        }),
      });
      if (!response.ok) throw new Error('Product source failed');
      for (const [key, value] of parseApiPrices(
        await response.json(),
        batch,
        kind,
      ))
        results.set(key, value);
    } catch {
      for (const item of batch)
        results.set(item, {
          cents: null,
          reason: 'product_api_failed',
          memberOnly: false,
          name: null,
          url: null,
        });
    }
  }
  return results;
}
