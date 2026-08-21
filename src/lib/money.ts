const MONEY_PATTERN =
  /^(-?)(?:0|[1-9]\d{0,2}(?:,\d{3})*|[1-9]\d*)(?:\.(\d{1,2}))?$/;

export function parseMoneyToCents(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = MONEY_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const [, sign, fraction = ''] = match;
  const whole = value.slice(sign.length).split('.')[0].replaceAll(',', '');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));

  if (!Number.isSafeInteger(cents)) {
    return null;
  }

  return sign === '-' ? -cents : cents;
}
