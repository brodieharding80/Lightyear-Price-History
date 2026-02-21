import Papa from 'papaparse';
import { parse, isValid, format } from 'date-fns';
import { db, type Item, type PricePoint } from './db';

type ImportStats = {
  itemsAdded: number;
  pointsAdded: number;
  errors: string[];
};

function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  const cleaned = s.replace(/\$/g, '').replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function toIsoDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // Try dd/MM/yyyy (common in AU exports)
  const d1 = parse(s, 'dd/MM/yyyy', new Date());
  if (isValid(d1)) return format(d1, 'yyyy-MM-dd');

  // Try yyyy-MM-dd
  const d2 = parse(s, 'yyyy-MM-dd', new Date());
  if (isValid(d2)) return format(d2, 'yyyy-MM-dd');

  // Fallback: Date.parse
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return format(new Date(t), 'yyyy-MM-dd');

  return null;
}

export async function importCsvText(
  csvText: string,
  replace: boolean
): Promise<ImportStats> {
  const stats: ImportStats = { itemsAdded: 0, pointsAdded: 0, errors: [] };

  const parsed = Papa.parse<Record<string, unknown>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors?.length) {
    stats.errors.push(...parsed.errors.slice(0, 5).map((e) => e.message));
  }

  const rows = parsed.data || [];
  if (!rows.length) {
    stats.errors.push('CSV has no rows (or headers not detected).');
    return stats;
  }

  const REQUIRED = [
    'Prod Code',
    'Description',
    'Bill Date',
    'Unit Price Inc',
    'Unit Price Ex',
  ];
  const headers = Object.keys(rows[0] || {});
  const missing = REQUIRED.filter((h) => !headers.includes(h));
  if (missing.length) {
    stats.errors.push(`Missing required columns: ${missing.join(', ')}`);
    return stats;
  }

  if (replace) {
    await db.transaction('rw', db.items, db.points, async () => {
      await db.points.clear();
      await db.items.clear();
    });
  }

  // Import in a transaction for speed
  await db.transaction('rw', db.items, db.points, async () => {
    const itemMap = new Map<string, Item>();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];

      const prodCode = String(r['Prod Code'] ?? '').trim();
      const description = String(r['Description'] ?? '').trim();
      const billDateRaw = String(r['Bill Date'] ?? '').trim();

      if (!prodCode || !description || !billDateRaw) continue;

      const billDate = toIsoDate(billDateRaw);
      if (!billDate) {
        stats.errors.push(
          `Row ${i + 2}: Could not parse Bill Date "${billDateRaw}"`
        );
        continue;
      }

      const point: PricePoint = {
        prodCode,
        billDate,
        supplierName: String(r['Supplier Name'] ?? '').trim() || undefined,
        billNumber: String(r['Bill Number'] ?? '').trim() || undefined,
        unitPriceInc: toNumber(r['Unit Price Inc']),
        unitPriceEx: toNumber(r['Unit Price Ex']),
        quantity: toNumber(r['Quantity']),
      };

      // Keep item (we'll update latest values later)
      if (!itemMap.has(prodCode)) {
        itemMap.set(prodCode, { prodCode, description });
      }

      await db.points.add(point);
      stats.pointsAdded++;
    }

    // Upsert items
    const items = [...itemMap.values()];
    // bulkPut = upsert by primary key
    await db.items.bulkPut(items);
    stats.itemsAdded = items.length;

    // Compute "latest" for each item (lastDate, lastInc, lastEx)
    // This keeps search results informative.
    for (const it of items) {
      const last = await db.points
        .where('prodCode')
        .equals(it.prodCode)
        .sortBy('billDate');

      const newest = last[last.length - 1];
      if (newest) {
        await db.items.update(it.prodCode, {
          lastDate: newest.billDate,
          lastInc: newest.unitPriceInc,
          lastEx: newest.unitPriceEx,
        });
      }
    }
  });

  return stats;
}
