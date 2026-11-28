import { Fragment, useEffect, useMemo, useState } from 'react';
import { format, parseISO, subDays } from 'date-fns';
import { Line } from 'react-chartjs-2';
import { db } from './db';
import type { PricePoint } from './db';
import { currency } from './format';

type SortKey = 'recent' | 'name' | 'change' | 'avg';
type Anchor = 'today' | 'latest';

type ItemRow = {
  prodCode: string;
  description: string;
  points: PricePoint[]; // oldest -> newest
  last?: PricePoint;
  lastPrice?: number;
  avg?: number;
  windowCount: number;
  min?: number;
  max?: number;
  changePct?: number; // last price vs window average
};

const LS_SUPPLIER = 'supplierTab.supplier';
const LS_DAYS = 'supplierTab.days';
const LS_ANCHOR = 'supplierTab.anchor';

function readLs(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeLs(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function priceOf(p: PricePoint, inc: boolean) {
  const v = inc ? p.unitPriceInc : p.unitPriceEx;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function pct(n?: number) {
  if (n === undefined || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

export default function SupplierTab({ dataVersion }: { dataVersion: number }) {
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [supplier, setSupplier] = useState<string>(() => readLs(LS_SUPPLIER, ''));
  const [daysInput, setDaysInput] = useState<string>(() => readLs(LS_DAYS, '30'));
  const [anchor, setAnchor] = useState<Anchor>(
    () => (readLs(LS_ANCHOR, 'today') === 'latest' ? 'latest' : 'today')
  );
  const [showInc, setShowInc] = useState(true);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [expanded, setExpanded] = useState<string | null>(null);

  const [points, setPoints] = useState<PricePoint[]>([]);
  const [descriptions, setDescriptions] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);

  const days = Math.max(1, Math.floor(Number(daysInput) || 0));

  // Load supplier list
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const keys = (await db.points.orderBy('supplierName').uniqueKeys()) as string[];
      const list = keys
        .map((k) => String(k).trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
      if (cancelled) return;
      setSuppliers(list);
      setSupplier((cur) => (cur && list.includes(cur) ? cur : ''));
    })();
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  // Load the selected supplier's price points + item descriptions
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supplier) {
        setPoints([]);
        return;
      }
      setLoading(true);
      try {
        const pts = await db.points.where('supplierName').equals(supplier).toArray();
        const codes = [...new Set(pts.map((p) => p.prodCode))];
        const items = await db.items.bulkGet(codes);
        const desc = new Map<string, string>();
        items.forEach((it, i) => desc.set(codes[i], it?.description ?? codes[i]));
        if (cancelled) return;
        setPoints(pts);
        setDescriptions(desc);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supplier, dataVersion]);

  useEffect(() => writeLs(LS_SUPPLIER, supplier), [supplier]);
  useEffect(() => writeLs(LS_DAYS, daysInput), [daysInput]);
  useEffect(() => writeLs(LS_ANCHOR, anchor), [anchor]);

  // Window: [start, end] inclusive, as yyyy-MM-dd strings
  const latestBillDate = useMemo(
    () => points.reduce((m, p) => (p.billDate > m ? p.billDate : m), ''),
    [points]
  );
  const windowEnd =
    anchor === 'latest' && latestBillDate ? latestBillDate : format(new Date(), 'yyyy-MM-dd');
  const windowStart = format(subDays(parseISO(windowEnd), days - 1), 'yyyy-MM-dd');

  const rows = useMemo<ItemRow[]>(() => {
    const byCode = new Map<string, PricePoint[]>();
    for (const p of points) {
      const arr = byCode.get(p.prodCode);
      if (arr) arr.push(p);
      else byCode.set(p.prodCode, [p]);
    }

    const out: ItemRow[] = [];
    for (const [prodCode, pts] of byCode) {
      pts.sort((a, b) => a.billDate.localeCompare(b.billDate) || (a.id ?? 0) - (b.id ?? 0));
      const last = pts[pts.length - 1];
      const lastPrice = last ? priceOf(last, showInc) : undefined;

      const all = pts.map((p) => priceOf(p, showInc)).filter((v): v is number => v !== undefined);
      const inWindow = pts
        .filter((p) => p.billDate >= windowStart && p.billDate <= windowEnd)
        .map((p) => priceOf(p, showInc))
        .filter((v): v is number => v !== undefined);

      const avg = inWindow.length
        ? inWindow.reduce((s, v) => s + v, 0) / inWindow.length
        : undefined;

      out.push({
        prodCode,
        description: descriptions.get(prodCode) ?? prodCode,
        points: pts,
        last,
        lastPrice,
        avg,
        windowCount: inWindow.length,
        min: all.length ? Math.min(...all) : undefined,
        max: all.length ? Math.max(...all) : undefined,
        changePct:
          avg !== undefined && lastPrice !== undefined && avg !== 0
            ? ((lastPrice - avg) / avg) * 100
            : undefined,
      });
    }
    return out;
  }, [points, descriptions, showInc, windowStart, windowEnd]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? rows.filter(
          (r) => r.prodCode.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
        )
      : rows.slice();

    list.sort((a, b) => {
      switch (sort) {
        case 'name':
          return a.description.localeCompare(b.description);
        case 'change':
          return Math.abs(b.changePct ?? -1) - Math.abs(a.changePct ?? -1);
        case 'avg':
          return (b.avg ?? -1) - (a.avg ?? -1);
        case 'recent':
        default:
          return (b.last?.billDate ?? '').localeCompare(a.last?.billDate ?? '');
      }
    });
    return list;
  }, [rows, filter, sort]);

  const itemsInWindow = rows.filter((r) => r.windowCount > 0).length;

  if (!suppliers.length) {
    return (
      <div className="card">
        <div className="empty">
          No suppliers found yet. Import a Lightyear CSV export above (it needs a "Supplier Name"
          column), then pick a supplier here.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <div className="controls">
          <label className="field grow">
            <span className="fieldLabel">Supplier</span>
            <select
              className="input"
              value={supplier}
              onChange={(e) => {
                setSupplier(e.target.value);
                setExpanded(null);
              }}
            >
              <option value="">Select a supplier…</option>
              {suppliers.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="fieldLabel">Average over (days)</span>
            <input
              className="input days"
              type="number"
              inputMode="numeric"
              min={1}
              value={daysInput}
              onChange={(e) => setDaysInput(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="fieldLabel">Ending</span>
            <select
              className="input"
              value={anchor}
              onChange={(e) => setAnchor(e.target.value as Anchor)}
            >
              <option value="today">Today</option>
              <option value="latest">Latest bill</option>
            </select>
          </label>

          <div className="field">
            <span className="fieldLabel">Price</span>
            <div className="toggle">
              <button
                className={'btn small ' + (showInc ? '' : 'ghost')}
                onClick={() => setShowInc(true)}
              >
                Inc
              </button>
              <button
                className={'btn small ' + (!showInc ? '' : 'ghost')}
                onClick={() => setShowInc(false)}
              >
                Ex
              </button>
            </div>
          </div>
        </div>

        {supplier && (
          <div className="status">
            {loading
              ? 'Loading…'
              : `${rows.length} items • ${points.length} price records • ${itemsInWindow} items bought between ${windowStart} and ${windowEnd}`}
          </div>
        )}
      </div>

      {supplier && !loading && (
        <div className="card">
          <div className="row" style={{ alignItems: 'center' }}>
            <input
              className="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter this supplier's items…"
              style={{ flex: 1, minWidth: 200 }}
            />
            <select
              className="input"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="Sort items"
            >
              <option value="recent">Most recent</option>
              <option value="name">Name A–Z</option>
              <option value="change">Biggest change vs avg</option>
              <option value="avg">Highest average</option>
            </select>
          </div>

          {visible.length === 0 ? (
            <div className="empty">No items match.</div>
          ) : (
            <div className="sTable">
              <div className="sHead">
                <div>Item</div>
                <div className="num">Last</div>
                <div className="num">Avg {days}d</div>
                <div className="num">vs avg</div>
              </div>
              {visible.map((r) => {
                const open = expanded === r.prodCode;
                return (
                  <Fragment key={r.prodCode}>
                    <button
                      className={'sRow' + (open ? ' active' : '')}
                      onClick={() => setExpanded(open ? null : r.prodCode)}
                      aria-expanded={open}
                    >
                      <div className="sItem">
                        <div className="liTitle">{r.description}</div>
                        <div className="liMeta">
                          <span className="pill">{r.prodCode}</span>
                          <span className="muted">
                            Last: {r.last?.billDate ?? '—'} • {r.points.length} records
                          </span>
                        </div>
                      </div>
                      <div className="num strong">{currency(r.lastPrice)}</div>
                      <div className="num">
                        <div className="strong">{currency(r.avg)}</div>
                        <div className="muted">
                          {r.windowCount ? `${r.windowCount} bills` : 'none in range'}
                        </div>
                      </div>
                      <div
                        className={
                          'num ' +
                          (r.changePct === undefined || Math.abs(r.changePct) < 0.05
                            ? 'muted'
                            : r.changePct > 0
                              ? 'up'
                              : 'down')
                        }
                      >
                        {pct(r.changePct)}
                      </div>
                    </button>
                    {open && <ItemHistory row={r} showInc={showInc} windowStart={windowStart} windowEnd={windowEnd} />}
                  </Fragment>
                );
              })}
            </div>
          )}
          <div className="footnote">
            Average is the mean unit price ({showInc ? 'inc' : 'ex'} GST) of this supplier's bills
            from {windowStart} to {windowEnd}. "vs avg" compares the latest price to that average.
            Tap an item to see its full price history.
          </div>
        </div>
      )}
    </>
  );
}

function ItemHistory({
  row,
  showInc,
  windowStart,
  windowEnd,
}: {
  row: ItemRow;
  showInc: boolean;
  windowStart: string;
  windowEnd: string;
}) {
  const chartData = useMemo(
    () => ({
      labels: row.points.map((p) => p.billDate),
      datasets: [
        {
          label: showInc ? 'Unit Price Inc' : 'Unit Price Ex',
          data: row.points.map((p) => priceOf(p, showInc) ?? null),
          spanGaps: true,
        },
        ...(row.avg !== undefined
          ? [
              {
                label: 'Average',
                data: row.points.map(() => row.avg as number),
                borderDash: [6, 4],
                pointRadius: 0,
                borderWidth: 1,
              },
            ]
          : []),
      ],
    }),
    [row, showInc]
  );

  return (
    <div className="sDetail">
      <div className="statGrid">
        <div>
          <div className="muted">Lowest</div>
          <div className="strong">{currency(row.min)}</div>
        </div>
        <div>
          <div className="muted">Highest</div>
          <div className="strong">{currency(row.max)}</div>
        </div>
        <div>
          <div className="muted">Average in range</div>
          <div className="strong">{currency(row.avg)}</div>
        </div>
        <div>
          <div className="muted">Records</div>
          <div className="strong">{row.points.length}</div>
        </div>
      </div>

      {row.points.length >= 2 && (
        <div className="chartBox">
          <Line
            data={chartData}
            options={{
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: { ticks: { maxTicksLimit: 6 } },
                y: { ticks: { maxTicksLimit: 6 } },
              },
            }}
          />
        </div>
      )}

      <div className="table">
        {row.points
          .slice()
          .reverse()
          .map((p, idx) => {
            const inRange = p.billDate >= windowStart && p.billDate <= windowEnd;
            return (
              <div className={'tRow' + (inRange ? ' inRange' : '')} key={p.id ?? idx}>
                <div className="tDate">{p.billDate}</div>
                <div className="tMid">
                  <div className="tPrice">{currency(priceOf(p, showInc))}</div>
                  <div className="tMeta">
                    {[
                      p.billNumber ? `Bill ${p.billNumber}` : '',
                      p.quantity ? `Qty ${p.quantity}` : '',
                      inRange ? 'in average' : '',
                    ]
                      .filter(Boolean)
                      .join(' • ')}
                  </div>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
