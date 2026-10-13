/** Preserve direction even when a small change rounds to 0.00%. */
export function signedChange(value: number): string {
  const sign = value === 0 ? "" : value > 0 ? "+" : "−";
  return `${sign}${Math.abs(value * 100).toFixed(2)}%`;
}

export function changeTone(value: number): "good" | "bad" | "zero" {
  return value === 0 ? "zero" : value > 0 ? "good" : "bad";
}
