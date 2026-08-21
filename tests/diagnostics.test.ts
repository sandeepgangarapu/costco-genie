import { describe, expect, it } from 'vitest';

import { sanitizeDiagnosticText } from '../src/lib/diagnostics.js';

describe('sanitizeDiagnosticText', () => {
  it.each([
    ['split authorization', 'Authoriza\u200Btion: Basic basic-secret'],
    ['split bearer', 'Bear\u200Ber bearer-secret'],
    ['quoted authorization', '"Authorization": "Basic quoted-secret"'],
    ['quoted access token', '"access_token":"quoted-access-secret"'],
    ['quoted refresh token', "'refreshToken':'quoted-refresh-secret'"],
    [
      'split JWT',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtZW1i\u200BLTEyMyJ9.dGVzdC1zaWduYXR1cmU',
    ],
    ['newline access token', 'failure\naccess_token=access-secret'],
    ['newline authorization', 'failure\nAuthorization: Basic basic-secret'],
    ['newline bearer', 'failure\nBearer bearer-secret'],
    ['tab bearer', 'Bearer\tbearer-tab-secret'],
    [
      'newline JWT',
      'failure\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJtZW1iZXItMTIzIn0.dGVzdC1zaWduYXR1cmU',
    ],
    ['control-split authorization', 'Authoriza\ttion: Basic tab-secret'],
    [
      'format-split authorization scheme',
      'Authorization: Ba\u200Bsic basic-zws-secret',
    ],
    [
      'control-split authorization scheme',
      'Authorization: Ba\tsic basic-tab-secret',
    ],
    ['control-split token value', 'access_token=access\ttoken-secret'],
    [
      'unsecured JWT with empty signature',
      'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzZWNyZXQifQ.',
    ],
    [
      'quoted authorization with comma',
      '"Authorization":"Bearer secret,authorization-tail" after',
    ],
    [
      'quoted access token with comma',
      '"access_token":"secret,access-tail" after',
    ],
    [
      'quoted refresh token with semicolon',
      '"refreshToken":"secret;refresh-tail" after',
    ],
    ['quoted ID token with comma', '"id_token":"secret,id-tail" after'],
    [
      'quoted client ID with semicolon',
      '"clientId":"secret;client-tail" after',
    ],
  ])(
    'redacts %s after normalizing controls and quoted keys',
    (_name, input) => {
      const sanitized = sanitizeDiagnosticText(input);

      expect(sanitized).toContain('[redacted]');
      expect(sanitized).not.toMatch(
        /basic-secret|bearer-secret|bearer-tab-secret|quoted-secret|quoted-access-secret|quoted-refresh-secret|access-secret|tab-secret|basic-zws-secret|basic-tab-secret|token-secret|eyJhbGci|authorization-tail|access-tail|refresh-tail|id-tail|client-tail/i,
      );
    },
  );

  it('removes a nested structured payload from its opening delimiter', () => {
    const sanitized = sanitizeDiagnosticText(
      'failure payload={"secret":"outer","nested":{"secret":"inner"}} after',
    );

    expect(sanitized).toBe('failure payload=[payload omitted] after');
  });

  it('retains useful text after a newline-delimited credential field', () => {
    const sanitized = sanitizeDiagnosticText(
      'failure\naccess_token=secret\nnetwork timeout after credentials',
    );

    expect(sanitized).toBe(
      'failure [redacted] network timeout after credentials',
    );
  });
});
