// Shared matcher diagnostics, including the checker's URL/cookie/mail-credential redaction.
const CONTROL_OR_FORMAT = String.raw`[\p{Cc}\p{Cf}]*`;
const AUTHORIZATION_KEY = interruptedLiteral('authorization');
const BEARER_LABEL = interruptedLiteral('bearer');
const TOKEN_KEYS = [
  'clientid',
  'client_id',
  'client-id',
  'token',
  'accesstoken',
  'access_token',
  'access-token',
  'refreshtoken',
  'refresh_token',
  'refresh-token',
  'idtoken',
  'id_token',
  'id-token',
  'password',
  'passwd',
  'smtp_pass',
  'smtp_user',
  'username',
  'credential',
  'credentials',
  'secret',
  'api_key',
  'apikey',
]
  .map(interruptedLiteral)
  .join('|');
const DOUBLE_QUOTED_VALUE = String.raw`"(?:\\[\s\S]|[^"\\])*"`;
const SINGLE_QUOTED_VALUE = String.raw`'(?:\\[\s\S]|[^'\\])*'`;
const ASSIGNED_SECRET_VALUE = `(?:${DOUBLE_QUOTED_VALUE}|${SINGLE_QUOTED_VALUE}|[^,;\\r\\n]*)`;
const AUTHORIZATION_PATTERN = new RegExp(
  `["']?\\b${AUTHORIZATION_KEY}\\b["']?\\s*[:=]\\s*${ASSIGNED_SECRET_VALUE}`,
  'giu',
);
const BEARER_PATTERN = new RegExp(
  `\\b${BEARER_LABEL}\\b\\s*${ASSIGNED_SECRET_VALUE}`,
  'giu',
);
const TOKEN_PATTERN = new RegExp(
  `["']?\\b(?:${TOKEN_KEYS})\\b["']?\\s*[:=]\\s*${ASSIGNED_SECRET_VALUE}`,
  'giu',
);
const JWT_PATTERN = new RegExp(
  `\\b${interruptedLiteral('eyJ')}` +
    `(?:[A-Za-z0-9_-]|[\\p{Cc}\\p{Cf}])+\\.` +
    `(?:[A-Za-z0-9_-]|[\\p{Cc}\\p{Cf}])+\\.` +
    `(?:[A-Za-z0-9_-]|[\\p{Cc}\\p{Cf}])*(?![A-Za-z0-9_-])`,
  'gu',
);

export function sanitizeDiagnosticText(value: string): string {
  const redactedRaw = redactSecrets(redactStructuredPayloads(value));
  const normalized = redactedRaw
    .replace(/\p{Cf}+/gu, '')
    .replace(/\p{Cc}+/gu, ' ');

  return redactSecrets(normalized).replace(/\s+/g, ' ').trim().slice(0, 400);
}

export function errorSummary(error: unknown, stage: string): string {
  // Do not traverse causes, stacks or service payloads. Validation errors can
  // include rejected private input, so retain only their class and a safe hint.
  const name = error instanceof Error ? error.name : 'NonError';
  const message =
    error instanceof Error
      ? error.name === 'ZodError'
        ? 'Invalid configuration or source response'
        : error.message
      : typeof error === 'string'
        ? error
        : 'Non-error value thrown';
  return `${stage}: ${sanitizeDiagnosticText(name)}: ${sanitizeDiagnosticText(message)}`;
}

function interruptedLiteral(value: string): string {
  return [...value]
    .map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join(CONTROL_OR_FORMAT);
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:https?|smtps?):\/\/[^\s<>"']+/giu, '[URL omitted]')
    .replace(
      /["']?\b(?:set-cookie|cookie)["']?\s*[:=][^\r\n]*/giu,
      '[cookie omitted]',
    )
    .replace(AUTHORIZATION_PATTERN, '[redacted]')
    .replace(BEARER_PATTERN, '[redacted]')
    .replace(TOKEN_PATTERN, '[redacted]')
    .replace(JWT_PATTERN, '[redacted]');
}

function redactStructuredPayloads(value: string): string {
  let output = '';
  let index = 0;

  while (index < value.length) {
    const opening = value[index];
    if (opening !== '{' && opening !== '[') {
      output += opening;
      index += 1;
      continue;
    }

    const stack: string[] = [opening];
    let cursor = index + 1;
    let quote: '"' | "'" | null = null;
    let escaped = false;

    for (; cursor < value.length && stack.length > 0; cursor += 1) {
      const character = value[cursor];
      if (quote !== null) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quote) {
          quote = null;
        }
        continue;
      }

      if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '{' || character === '[') {
        stack.push(character);
      } else if (character === '}' || character === ']') {
        const expectedOpening = character === '}' ? '{' : '[';
        if (stack.at(-1) !== expectedOpening) {
          cursor = value.length;
          break;
        }
        stack.pop();
      }
    }

    output += '[payload omitted]';
    index = stack.length === 0 ? cursor : value.length;
  }

  return output;
}
