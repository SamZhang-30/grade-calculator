/**
 * Spreadsheet-style continuation for assignment labels.
 *
 * Only an integer at the very end is treated as a sequence. Everything else
 * is a label, so filling it repeats the original text. Leading zeroes are kept
 * while the next value still fits in the same width.
 */
export function autofillAssignmentName(name: string, offset: number): string {
  const match = /^(.*?)(-?\d+)$/.exec(name);
  if (!match) return name;

  const current = Number(match[2]);
  const next = current + offset;
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(next)) return name;

  const sourceDigits = match[2]!.replace("-", "");
  const keepsLeadingZeroes = sourceDigits.length > 1 && sourceDigits.startsWith("0");
  const magnitude = keepsLeadingZeroes
    ? String(Math.abs(next)).padStart(sourceDigits.length, "0")
    : String(Math.abs(next));
  return `${match[1]}${next < 0 ? "-" : ""}${magnitude}`;
}
