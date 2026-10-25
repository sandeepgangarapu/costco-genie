/** Date-only evidence is already a calendar day; timestamps use the Mac's timezone. */
export function formatPromoEnd(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const usDate = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/u.exec(value);
  const date = usDate
    ? new Date(
        Number(usDate[3]) + (usDate[3].length === 2 ? 2000 : 0),
        Number(usDate[1]) - 1,
        Number(usDate[2]),
      )
    : new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown date';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
