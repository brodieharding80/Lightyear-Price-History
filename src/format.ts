export function currency(n?: number | null) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return `$${n.toFixed(2)}`;
}
