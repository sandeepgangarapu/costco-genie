import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppleMailNotifier } from '../../src/notifications/apple-mail.js';
import { SmtpMailNotifier } from '../../src/notifications/smtp-mail.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { watchMailSender, renderDrops } from '../../src/watch/email.js';
import { item, observation } from './helpers.js';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe('watch email uses matcher transports', () => {
  it.each(['2026-11-15', '2026-11-15T08:00:00.000Z', '11/15/2026'])(
    'formats promo end %s consistently in text and HTML without mutating evidence',
    (promoEnd) => {
      vi.stubEnv('TZ', 'America/Los_Angeles');
      const o = observation(900, { promoEnd });
      const message = renderDrops([
        { item, observation: o, previousLowCents: 1000, baselineCents: 1200 },
      ]);
      expect(message.text).toContain('Promo ends: 2026-11-15\n');
      expect(message.html).toContain('<td>2026-11-15</td>');
      expect(message.text).not.toContain('T08:00');
      expect(message.html).not.toContain('T08:00');
      expect(o.promoEnd).toBe(promoEnd);
    },
  );
  const message = renderDrops([
    {
      item,
      observation: observation(900),
      previousLowCents: 1000,
      baselineCents: 1200,
    },
  ]);
  it('sends plain text through Apple Mail by default and respects emailRecipient', async () => {
    const recipient = vi
      .spyOn(AppleMailNotifier.prototype, 'resolveSelfRecipient')
      .mockResolvedValue('self@example.com');
    const send = vi
      .spyOn(AppleMailNotifier.prototype, 'send')
      .mockResolvedValue();
    await watchMailSender({
      ...DEFAULT_CONFIG,
      emailRecipient: 'chosen@example.com',
    })(message);
    expect(recipient).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      'chosen@example.com',
      'Costco Genie: 1 item hit a new low',
      message.text,
    );
    await watchMailSender(DEFAULT_CONFIG)(message);
    expect(send).toHaveBeenLastCalledWith(
      'self@example.com',
      message.subject,
      message.text,
    );
  });
  it('sends HTML and text through SMTP and defaults to its configured recipient', async () => {
    const recipient = vi
      .spyOn(SmtpMailNotifier.prototype, 'resolveSelfRecipient')
      .mockResolvedValue('self@example.com');
    const send = vi
      .spyOn(SmtpMailNotifier.prototype, 'send')
      .mockResolvedValue();
    const config = {
      ...DEFAULT_CONFIG,
      smtpConfigPath: '/TEST-private/smtp.json',
    };
    await watchMailSender(config)(message);
    expect(send).toHaveBeenCalledWith(
      'self@example.com',
      message.subject,
      message.text,
      message.html,
    );
    recipient.mockClear();
    await watchMailSender({ ...config, emailRecipient: 'chosen@example.com' })(
      message,
    );
    expect(recipient).not.toHaveBeenCalled();
    expect(send).toHaveBeenLastCalledWith(
      'chosen@example.com',
      message.subject,
      message.text,
      message.html,
    );
  });
  it('consolidates kinds into an item count, escapes HTML, and labels unverified drops and estimates', () => {
    const drops = renderDrops([
      {
        item: { ...item, name: 'TEST-<item>' },
        observation: observation(900),
        previousLowCents: 2000,
        baselineCents: 2500,
        unverifiedReason: 'TEST-unverified',
      },
      {
        item,
        observation: observation(900, {
          kind: 'warehouse_estimate',
          estimateCents: 793,
        }),
        previousLowCents: 1000,
        baselineCents: 1200,
      },
    ]);
    expect(drops.subject).toContain('1 item');
    expect(drops.text).toContain('unverified — check before buying');
    expect(drops.html).toContain('&lt;item&gt;');
    expect(drops.text).toContain('verify in warehouse');
  });
});
