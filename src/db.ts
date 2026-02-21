import Dexie from 'dexie';
import type { Table } from 'dexie';

export type Item = {
  prodCode: string;
  description: string;
  lastDate?: string; // yyyy-MM-dd
  lastInc?: number;
  lastEx?: number;
};

export type PricePoint = {
  id?: number;
  prodCode: string;
  billDate: string; // yyyy-MM-dd
  supplierName?: string;
  billNumber?: string;
  unitPriceInc?: number;
  unitPriceEx?: number;
  quantity?: number;
};

class AppDB extends Dexie {
  items!: Table<Item, string>;
  points!: Table<PricePoint, number>;

  constructor() {
    super('price_history_db');
    this.version(1).stores({
      items: 'prodCode, description, lastDate',
      points: '++id, prodCode, billDate',
    });
  }
}

export const db = new AppDB();

export async function clearDb() {
  await db.transaction('rw', db.items, db.points, async () => {
    await db.points.clear();
    await db.items.clear();
  });
}
