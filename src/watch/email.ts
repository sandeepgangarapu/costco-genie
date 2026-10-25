// Ported from Costco Price Drop Checker; integrated with matcher boundaries.
import type { Drop, Observation, PriceKind } from './domain.js';
import type { AppConfig } from '../config/config.js';
import { SmtpMailNotifier } from '../notifications/smtp-mail.js';
import { AppleMailNotifier } from '../notifications/apple-mail.js';
export interface Message {
  subject: string;
  text: string;
  html: string;
}
export type MailSender = (message: Message) => Promise<void>;
export const kindLabel: Record<PriceKind, string> = {
  online: 'Costco.com',
  warehouse: 'Verified warehouse',
  warehouse_estimate: 'Warehouse estimate (Same-Day)',
};
export function priceKindLabel(
  kind: PriceKind,
  evidence: Observation['evidence'] = {},
): string {
  if (kind !== 'warehouse' || !evidence.warehouseNumber) return kindLabel[kind];
  return `Warehouse price (${evidence.warehouseName ? `${evidence.warehouseName} ` : ''}#${evidence.warehouseNumber})`;
}
export const money = (cents: number | null, unitBasis: unknown = 'unknown') =>
  cents === null
    ? 'unavailable'
    : `$${(cents / 100).toFixed(2)}${unitBasis === 'lb' ? '/lb' : ''}`;
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
export function renderDrops(drops: Drop[]): Message {
  const count = new Set(drops.map((d) => d.item.id)).size;
  const subject = drops.some((d) => d.unverifiedReason)
    ? `Costco price drop: ${count} ${count === 1 ? 'item' : 'items'} — includes unverified prices`
    : `Costco price drop: ${count} ${count === 1 ? 'item hit a new low' : 'items hit new lows'}`;
  const headers = [
    'Item',
    'Item number',
    'Price kind',
    'New price',
    'Previous low',
    'Price when added',
    'Savings vs. previous low',
    'Promo ends',
    'Source',
    'Link',
  ];
  const rows = drops.map(
    ({
      item,
      observation: o,
      previousLowCents,
      baselineCents,
      unverifiedReason,
    }) => {
      const price =
        o.kind === 'warehouse_estimate'
          ? `${money(o.cents)} Same-Day; ${money(o.estimateCents)} estimated warehouse — verify in warehouse`
          : money(o.cents, o.evidence.unitBasis);
      return [
        item.name,
        item.itemNumber,
        priceKindLabel(o.kind, o.evidence),
        unverifiedReason
          ? `${price} — unverified — check before buying. ${unverifiedReason} Stored low unchanged.`
          : price,
        money(previousLowCents, o.evidence.unitBasis),
        money(baselineCents, o.evidence.unitBasis),
        money(previousLowCents - o.cents!, o.evidence.unitBasis),
        o.promoEnd ?? 'Not shown',
        o.source +
          (o.evidence.discountHandling
            ? `; ${o.evidence.discountHandling}`
            : ''),
        item.url,
      ];
    },
  );
  const text = `${subject}\n\n${rows.map((row) => headers.map((h, i) => `${h}: ${row[i]}`).join('\n')).join('\n\n')}\n\nEach price kind has a separate low. Same-Day comparisons use raw Same-Day prices. If unavailable when added, the first usable price is the baseline.`;
  const html = `<html><body><h1>${escapeHtml(subject)}</h1><table border="1" cellpadding="8" cellspacing="0"><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((value, i) => `<td>${i === 9 ? `<a href="${escapeHtml(value)}">Costco product</a>` : escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table><p>Each price kind has a separate low. Same-Day comparisons use raw Same-Day prices; verify estimates in the warehouse. If unavailable when added, the first usable price is the baseline.</p></body></html>`;
  return { subject, text, html };
}
export function notice(subject: string, text: string): Message {
  return {
    subject,
    text,
    html: `<html><body><h1>${escapeHtml(subject)}</h1><p>${escapeHtml(text)}</p></body></html>`,
  };
}
export function watchMailSender(config: AppConfig): MailSender {
  return async (message) => {
    const mail = config.smtpConfigPath
      ? new SmtpMailNotifier(config.smtpConfigPath)
      : new AppleMailNotifier();
    const recipient =
      config.emailRecipient ?? (await mail.resolveSelfRecipient());
    if (config.smtpConfigPath)
      await mail.send(recipient, message.subject, message.text, message.html);
    else await mail.send(recipient, message.subject, message.text);
  };
}
