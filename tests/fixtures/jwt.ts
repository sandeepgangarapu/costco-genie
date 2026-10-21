// Constructed, nonfunctional tokens for diagnostic-redaction tests only.
// Splitting the segments also keeps secret scanners useful for real leaks.
export const syntheticJwt = [
  Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: 'synthetic-test-member' })).toString(
    'base64url',
  ),
  Buffer.from('test-signature').toString('base64url'),
].join('.');

export const syntheticUnsecuredJwt = [
  Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
  Buffer.from(JSON.stringify({ sub: 'synthetic-test-member' })).toString(
    'base64url',
  ),
  '',
].join('.');
