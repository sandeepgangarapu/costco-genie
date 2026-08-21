import { chromium } from 'playwright';

import type { ReportPriceObservation } from '../domain/types.js';
import { parseMoneyToCents } from '../lib/money.js';

const SAME_DAY_SEARCH_URL = 'https://sameday.costco.com/store/costco/s';
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;

export interface SameDayPriceRequest {
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
  const deadline = createDeadline(timeout, options.nowMilliseconds);
  const launchBrowser = options.launchBrowser ?? launchPlaywrightBrowser;
  let browser: SameDayBrowser | null = null;
  let page: SameDayPage | null = null;

  try {
    browser = await withinDeadline(launchBrowser, deadline);
    page = await withinDeadline(() => browser!.newPage(), deadline);
    if (postalCode !== null) {
      await withinDeadline(
        () =>
          page!.goto(SAME_DAY_SEARCH_URL, {
            timeout: remainingMilliseconds(deadline),
            waitUntil: 'domcontentloaded',
          }),
        deadline,
      );
      await browseAsGuestIfPrompted(page, deadline);
      const confirmed = await configureDeliveryLocation(
        page,
        options.deliveryAddress,
        postalCode,
        deadline,
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
      observations.push(
        await lookupItem(
          page,
          request,
          observedAt,
          configuredSource,
          deadline,
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
    await withinDeadline(
      () =>
        page.goto(searchUrl(request.itemNumber), {
          timeout: remainingMilliseconds(deadline),
          waitUntil: 'domcontentloaded',
        }),
      deadline,
    );
    if (browseAsGuest) await browseAsGuestIfPrompted(page, deadline);
    await waitForResults(page, deadline);
    const exactProductOpened = await openExactProduct(
      page,
      request.itemNumber,
      deadline,
    );
    if (!exactProductOpened) {
      return unavailable(request, observedAt, source, 'exact_item_not_found');
    }
    const text = await withinDeadline(
      () => page.locator('body').innerText(),
      deadline,
    );
    const priceCents = exactItemPriceCents(text, request.itemNumber);
    if (priceCents === undefined) {
      return unavailable(request, observedAt, source, 'exact_item_not_found');
    }
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

async function launchPlaywrightBrowser(): Promise<SameDayBrowser> {
  return chromium.launch({ headless: true });
}

function searchUrl(itemNumber: string): string {
  return `${SAME_DAY_SEARCH_URL}?k=${encodeURIComponent(itemNumber)}`;
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
): Promise<void> {
  await page.locator('text=/Results for/i').waitFor({
    state: 'visible',
    timeout: remainingMilliseconds(deadline),
  });
}

async function openExactProduct(
  page: SameDayPage,
  itemNumber: string,
  deadline: Deadline,
): Promise<boolean> {
  const products = page.locator('[data-item-card-button="true"]');
  const remaining = remainingMilliseconds(deadline);
  const productWaitUsesWholeDeadline = remaining <= 10_000;
  try {
    await products.waitFor({
      state: 'visible',
      timeout: Math.min(10_000, remaining),
    });
  } catch {
    if (productWaitUsesWholeDeadline || deadline.now() >= deadline.endsAt) {
      throw new SameDayDeadlineError();
    }
    return false;
  }
  if ((await withinDeadline(() => products.count(), deadline)) !== 1) {
    return false;
  }
  await withinDeadline(() => products.click(), deadline);
  await page
    .locator(`text=/Item:\\s*${escapeRegex(itemNumber)}(?:\\D|$)/i`)
    .waitFor({
      state: 'visible',
      timeout: remainingMilliseconds(deadline),
    });
  return true;
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
