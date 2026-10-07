export function unitInputValue(raw: string): string {
  const match = raw.trim().match(/^(\d+)/);
  if (!match) return "";
  const value = Number(match[0]);
  return Number.isSafeInteger(value) ? String(value) : "";
}

export function formatUnits(raw: string): string {
  const normalized = unitInputValue(raw);
  if (normalized === "") return "";
  const value = Number(normalized);
  return `${value} ${value === 1 ? "unit" : "units"}`;
}
