import { chromium } from 'playwright';

import type { ReportPriceObservation } from '../domain/types.js';
import { parseMoneyToCents } from '../lib/money.js';
import { chromeBinaryPath } from './chrome-path.js';

const SAME_DAY_SEARCH_URL = 'https://sameday.costco.com/store/costco/s';
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const RESULT_WAIT_MILLISECONDS = 10_000;
const DETAIL_WAIT_MILLISECONDS = 5_000;
const GENUINE_RESULT_SELECTOR =
  '[role="region"][aria-label^="Results for"] ul:not([role="presentation"]) > li > [data-item-card="true"] [data-item-card-button="true"]';
const PRODUCT_DETAIL_BACK_SELECTOR =
  '[role="dialog"][aria-label="item details"] #item_details > div:first-child button';

export interface SameDayPriceRequest {
  readonly description?: string;
  readonly itemNumber: string;
  readonly warehouseNumber: string;
}

export type SameDayPriceObservation = ReportPriceObservation &
  SameDayPriceRequest;

export interface SameDayLocator {
  allInnerTexts(): Promise<string[]>;
  click(): Promise<void>;
  count(): Promise<number>;
  fill(value: string): Promise<void>;
  innerText(): Promise<string>;
  nth(index: number): SameDayLocator;
  press(key: string): Promise<void>;
  waitFor(options: {
    readonly state: 'visible';
    readonly timeout: number;
  }): Promise<void>;
}

export interface SameDayPage {
  close(): Promise<void>;
  goto(
    url: string,
    options: {
      readonly timeout: number;
      readonly waitUntil: 'domcontentloaded';
    },
  ): Promise<unknown>;
  locator(selector: string): SameDayLocator;
}

export interface SameDayBrowser {
  close(): Promise<void>;
  newPage(): Promise<SameDayPage>;
}

export type SameDayBrowserLauncher = () => Promise<SameDayBrowser>;

export interface SameDayPriceOptions {
  readonly deliveryAddress?: string;
  readonly launchBrowser?: SameDayBrowserLauncher;
  readonly now?: () => Date;
  readonly nowMilliseconds?: () => number;
  readonly postalCode?: string;
  readonly timeout?: number;
}

export function inverseMarkupCents(
  sameDayCents: number,
  markupPercent: number,
): number {
  return Math.round(sameDayCents / (1 + markupPercent / 100));
}

export async function fetchSameDayPrices(
  requests: readonly SameDayPriceRequest[],
  options: SameDayPriceOptions = {},
): Promise<SameDayPriceObservation[]> {
  const now = options.now ?? (() => new Date());
  const observedAt = now().toISOString();
  const postalCode = normalizedPostalCode(options.postalCode);
  const configuredSource = sourceForPostalCode(postalCode);
  const unconfirmedSource = 'same_day_guest_storefront_location_unconfirmed';
  const timeout = validTimeout(options.timeout);
  const setupDeadline = createDeadline(timeout, options.nowMilliseconds);
  const launchBrowser = options.launchBrowser ?? launchPlaywrightBrowser;
  let browser: SameDayBrowser | null = null;
  let page: SameDayPage | null = null;

  try {
    browser = await withinDeadline(launchBrowser, setupDeadline);
    page = await withinDeadline(() => browser!.newPage(), setupDeadline);
    if (postalCode !== null) {
      await withinDeadline(
        () =>
          page!.goto(SAME_DAY_SEARCH_URL, {
            timeout: remainingMilliseconds(setupDeadline),
            waitUntil: 'domcontentloaded',
          }),
        setupDeadline,
      );
      await browseAsGuestIfPrompted(page, setupDeadline);
      const confirmed = await configureDeliveryLocation(
        page,
        options.deliveryAddress,
        postalCode,
        setupDeadline,
      );
      if (!confirmed) {
        return requests.map((request) =>
          unavailable(
            request,
            observedAt,
            unconfirmedSource,
            'postal_code_not_confirmed',
          ),
        );
      }
    }
    const observations: SameDayPriceObservation[] = [];
    for (const [index, request] of requests.entries()) {
      const itemDeadline = createDeadline(timeout, options.nowMilliseconds);
      observations.push(
        await lookupItem(
          page,
          request,
          observedAt,
          configuredSource,
          itemDeadline,
          postalCode === null && index === 0,
        ),
      );
    }
    return observations;
  } catch {
    return requests.map((request) =>
      unavailable(
        request,
        observedAt,
        postalCode === null ? configuredSource : unconfirmedSource,
        'browser_launch_failed',
      ),
    );
  } finally {
    if (page) {
      await closeWithinDeadline(() => page!.close());
    }
    if (browser) {
      await closeWithinDeadline(() => browser!.close());
    }
  }
}

async function lookupItem(
  page: SameDayPage,
  request: SameDayPriceRequest,
  observedAt: string,
  source: string,
  deadline: Deadline,
  browseAsGuest: boolean,
): Promise<SameDayPriceObservation> {
  try {
    const searchTerms = [request.itemNumber, request.description?.trim()]
      .filter((value): value is string => Boolean(value))
      .filter((value, index, values) => values.indexOf(value) === index);
    for (const [index, searchTerm] of searchTerms.entries()) {
      const priceCents = await lookupSearchTerm(
        page,
        request.itemNumber,
        searchTerm,
        deadline,
        browseAsGuest && index === 0,
      );
      if (priceCents === undefined) continue;
      if (priceCents === null) {
        return unavailable(
          request,
          observedAt,
          source,
          'current_price_unavailable',
        );
      }

      return {
        channel: 'same_day',
        itemNumber: request.itemNumber,
        observedAt,
        promotionText: null,
        source,
        unavailableReason: null,
        unitPriceCents: priceCents,
        warehouseNumber: request.warehouseNumber,
      };
    }
    return unavailable(request, observedAt, source, 'exact_item_not_found');
  } catch (error) {
    return unavailable(
      request,
      observedAt,
      source,
      error instanceof SameDayDeadlineError
        ? 'deadline_exceeded'
        : 'search_failed',
    );
  }
}

async function lookupSearchTerm(
  page: SameDayPage,
  itemNumber: string,
  searchTerm: string,
  deadline: Deadline,
  browseAsGuest: boolean,
): Promise<number | null | undefined> {
  await withinDeadline(
    () =>
      page.goto(searchUrl(searchTerm), {
        timeout: remainingMilliseconds(deadline),
        waitUntil: 'domcontentloaded',
      }),
    deadline,
  );
  if (browseAsGuest) await browseAsGuestIfPrompted(page, deadline);
  if (!(await waitForResults(page, deadline))) return undefined;
  return findExactProductPrice(page, itemNumber, deadline);
}

async function launchPlaywrightBrowser(): Promise<SameDayBrowser> {
  return chromium.launch({
    executablePath: chromeBinaryPath(),
    headless: true,
  });
}

function searchUrl(searchTerm: string): string {
  return `${SAME_DAY_SEARCH_URL}?k=${encodeURIComponent(searchTerm)}`;
}

async function browseAsGuestIfPrompted(
  page: SameDayPage,
  deadline: Deadline,
): Promise<void> {
  const guestButton = page.locator('button:has-text("Browse as a guest")');
  if ((await withinDeadline(() => guestButton.count(), deadline)) > 0) {
    await withinDeadline(() => guestButton.click(), deadline);
  }
}

async function waitForResults(
  page: SameDayPage,
  deadline: Deadline,
): Promise<boolean> {
  const timeout = remainingMilliseconds(deadline);
  return Promise.any([
    page
      .locator('text=/Results for/i')
      .waitFor({
        state: 'visible',
        timeout,
      })
      .then(() => true),
    page
      .locator('text=/Sorry, we don.t see any items at Costco that match/i')
      .waitFor({ state: 'visible', timeout })
      .then(() => false),
  ]);
}

async function findExactProductPrice(
  page: SameDayPage,
  itemNumber: string,
  deadline: Deadline,
): Promise<number | null | undefined> {
  const products = page.locator(GENUINE_RESULT_SELECTOR);
  if (
    !(await waitForVisible(products.nth(0), deadline, RESULT_WAIT_MILLISECONDS))
  ) {
    throw new Error('Same-Day result cards did not become visible');
  }
  const count = await withinDeadline(() => products.count(), deadline);
  for (let index = 0; index < count; index += 1) {
    await withinDeadline(() => products.nth(index).click(), deadline);
    const detail = page.locator('text=/Item:\\s*\\d+(?:\\D|$)/i');
    if (!(await waitForVisible(detail, deadline, DETAIL_WAIT_MILLISECONDS))) {
      throw new Error('Same-Day product detail did not become visible');
    }
    const text = await withinDeadline(
      () => page.locator('body').innerText(),
      deadline,
    );
    const priceCents = exactItemPriceCents(text, itemNumber);
    if (priceCents !== undefined) return priceCents;
    if (index < count - 1) await returnToResults(page, deadline);
  }
  return undefined;
}

async function waitForVisible(
  locator: SameDayLocator,
  deadline: Deadline,
  timeout: number,
): Promise<boolean> {
  const remaining = remainingMilliseconds(deadline);
  const waitUsesWholeDeadline = remaining <= timeout;
  try {
    await locator.waitFor({
      state: 'visible',
      timeout: Math.min(timeout, remaining),
    });
    return true;
  } catch {
    if (waitUsesWholeDeadline || deadline.now() >= deadline.endsAt) {
      throw new SameDayDeadlineError();
    }
    return false;
  }
}

async function returnToResults(
  page: SameDayPage,
  deadline: Deadline,
): Promise<void> {
  await withinDeadline(
    () => page.locator(PRODUCT_DETAIL_BACK_SELECTOR).click(),
    deadline,
  );
  await waitForResults(page, deadline);
}

async function configureDeliveryLocation(
  page: SameDayPage,
  deliveryAddress: string | undefined,
  postalCode: string,
  deadline: Deadline,
): Promise<boolean> {
  if (!deliveryAddress?.trim()) return false;

  try {
    const deliveryButton = page.locator(
      'button[aria-controls]:has-text("Delivery")',
    );
    await deliveryButton.waitFor({
      state: 'visible',
      timeout: remainingMilliseconds(deadline),
    });
    await withinDeadline(() => deliveryButton.click(), deadline);

    const editButton = page.locator('button:has-text("Edit")');
    await editButton.waitFor({
      state: 'visible',
      timeout: remainingMilliseconds(deadline),
    });
    await withinDeadline(() => editButton.click(), deadline);

    const input = page.locator('#streetAddress');
    await input.waitFor({
      state: 'visible',
      timeout: remainingMilliseconds(deadline),
    });
    await withinDeadline(() => input.fill(deliveryAddress), deadline);

    const options = page.locator('[role="option"]');
    await options.nth(0).waitFor({
      state: 'visible',
      timeout: remainingMilliseconds(deadline),
    });
    const optionTexts = await withinDeadline(
      () => options.allInnerTexts(),
      deadline,
    );
    const matchingIndex = optionTexts.findIndex((text) =>
      text.includes(postalCode),
    );
    if (matchingIndex < 0) return false;
    const selectedAddressLabel = optionTexts[matchingIndex]
      ?.split(/\r?\n/u)[0]
      ?.trim();
    if (!selectedAddressLabel) return false;
    await withinDeadline(() => options.nth(matchingIndex).click(), deadline);

    const saveButton = page.locator('button:has-text("Save Address")');
    if ((await withinDeadline(() => saveButton.count(), deadline)) === 0) {
      return false;
    }
    await withinDeadline(() => saveButton.click(), deadline);
    return waitForDeliveryLabel(deliveryButton, selectedAddressLabel, deadline);
  } catch {
    return false;
  }
}

async function waitForDeliveryLabel(
  deliveryButton: SameDayLocator,
  expectedAddress: string,
  deadline: Deadline,
): Promise<boolean> {
  do {
    if (
      (
        await withinDeadline(() => deliveryButton.innerText(), deadline)
      ).includes(expectedAddress)
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (deadline.now() < deadline.endsAt);
  return false;
}

interface Deadline {
  readonly endsAt: number;
  readonly now: () => number;
}

class SameDayDeadlineError extends Error {}

function createDeadline(
  timeout: number,
  now: (() => number) | undefined,
): Deadline {
  const clock = now ?? Date.now;
  return { endsAt: clock() + timeout, now: clock };
}

function remainingMilliseconds(deadline: Deadline): number {
  const remaining = Math.ceil(deadline.endsAt - deadline.now());
  if (remaining <= 0) throw new SameDayDeadlineError();
  return remaining;
}

async function withinDeadline<T>(
  operation: () => Promise<T>,
  deadline: Deadline,
): Promise<T> {
  const remaining = remainingMilliseconds(deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SameDayDeadlineError()), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeWithinDeadline(close: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    close().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 2_000);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

function exactItemPriceCents(
  text: string,
  itemNumber: string,
): number | null | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const itemPattern = new RegExp(
    `^Item:\\s*${escapeRegex(itemNumber)}(?:\\D|$)`,
    'iu',
  );
  const itemIndex = lines.findIndex((line) => itemPattern.test(line));
  if (itemIndex === -1) return undefined;

  const nearbyLines = lines.slice(
    Math.max(0, itemIndex - 1),
    Math.min(lines.length, itemIndex + 4),
  );
  const prices = new Set<number>();
  for (const line of nearbyLines) {
    for (const match of line.matchAll(
      /current\s+price\s*:\s*\$([0-9][0-9,]*(?:\.\d{1,2})?)/gi,
    )) {
      const priceText = match[1];
      if (priceText === undefined) continue;
      const cents = parseMoneyToCents(priceText);
      if (cents !== null && cents > 0) prices.add(cents);
    }
  }

  return prices.size === 1 ? ([...prices][0] ?? null) : null;
}

function unavailable(
  request: SameDayPriceRequest,
  observedAt: string,
  source: string,
  unavailableReason: string,
): SameDayPriceObservation {
  return {
    channel: 'same_day',
    itemNumber: request.itemNumber,
    observedAt,
    promotionText: null,
    source,
    unavailableReason,
    unitPriceCents: null,
    warehouseNumber: request.warehouseNumber,
  };
}

function normalizedPostalCode(value: string | undefined): string | null {
  const postalCode = value?.trim();
  return postalCode ? postalCode : null;
}

function sourceForPostalCode(postalCode: string | null): string {
  return `same_day_guest_storefront_zip_${postalCode ?? 'unspecified'}`;
}

function validTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_TIMEOUT_MILLISECONDS;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
