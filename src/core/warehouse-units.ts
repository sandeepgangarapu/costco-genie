/** Positive evidence of a rate/variable package, never an average-weight conversion. */
export function indicatesVariableWeight(text: string): boolean {
  return /\b(?:avg\.?|average)\s*(?:wt\.?|weight)\b|\bper\s+(?:lb|pound)s?\b|\/\s*lbs?\b|\b(?:variable|random|catch)[\s_-]*weight\b/iu.test(
    text,
  );
}

/** Strictly below half is suspicious; exactly half remains comparable. */
export function possibleWarehouseUnitMismatch(
  quotationCents: number,
  paidUnitCents?: number,
): boolean {
  return (
    paidUnitCents !== undefined &&
    Number.isSafeInteger(paidUnitCents) &&
    paidUnitCents > 0 &&
    quotationCents < paidUnitCents / 2
  );
}
