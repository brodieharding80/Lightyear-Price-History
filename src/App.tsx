import React, { useEffect, useMemo, useState } from 'react';
import { db } from './db';
import type { Item, PricePoint } from './db';
import { clearDb } from './db';
import { importCsvText } from './parse';

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend
);

function currency(n?: number) {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return `$${n.toFixed(2)}`;
}

async function copyToClipboard(text: string) {
  // modern clipboard API
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // fallback for older browsers
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

async function readClipboardText(): Promise<string> {
  if (navigator.clipboard?.readText) {
    return await navigator.clipboard.readText();
  }
  throw new Error('Clipboard read not supported in this browser.');
}

export default function App() {
  const [status, setStatus] = useState<string>(
    'Import your CSV to get started.'
  );
  const [busy, setBusy] = useState(false);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Item | null>(null);

  const [points, setPoints] = useState<PricePoint[]>([]);
  const [showInc, setShowInc] = useState(true);

  // Search
  useEffect(() => {
    let cancelled = false;

    async function run() {
      const q = query.trim();
      if (!q) {
        setResults([]);
        return;
      }

      const qLower = q.toLowerCase();

      const all = await db.items.toArray();
      const filtered = all
        .filter(
          (it) =>
            it.prodCode.toLowerCase().includes(qLower) ||
            it.description.toLowerCase().includes(qLower)
        )
        .sort((a, b) => (b.lastDate || '').localeCompare(a.lastDate || ''))
        .slice(0, 50);

      if (!cancelled) setResults(filtered);
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [query]);

  // Load item points when selected
  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!selected) {
        setPoints([]);
        return;
      }

      const pts = await db.points
        .where('prodCode')
        .equals(selected.prodCode)
        .sortBy('billDate');

      if (!cancelled) setPoints(pts);
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const chartData = useMemo(() => {
    const labels = points.map((p) => p.billDate);
    const data = points.map(
      (p) => (showInc ? p.unitPriceInc : p.unitPriceEx) ?? null
    );

    return {
      labels,
      datasets: [
        {
          label: showInc ? 'Unit Price Inc' : 'Unit Price Ex',
          data,
          spanGaps: true,
        },
      ],
    };
  }, [points, showInc]);

  async function handleImport(replace: boolean) {
    setBusy(true);
    setStatus('Opening file picker…');

    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,text/csv';
      input.onchange = async () => {
        try {
          const file = input.files?.[0];
          if (!file) {
            setStatus('Import cancelled.');
            setBusy(false);
            return;
          }

          setStatus(`Reading ${file.name}…`);
          const text = await file.text();

          setStatus(`Importing…`);
          const res = await importCsvText(text, replace);

          setStatus(
            `Imported ${res.itemsAdded} items and ${res.pointsAdded} price points.` +
              (res.errors.length ? ` (First error: ${res.errors[0]})` : '')
          );

          // Refresh search results for current query
          setQuery((q) => q);
        } catch (e: any) {
          setStatus(`Import failed: ${String(e?.message || e)}`);
        } finally {
          setBusy(false);
        }
      };

      input.click();
    } catch (e: any) {
      setStatus(`Import failed: ${String(e?.message || e)}`);
      setBusy(false);
    }
  }

  async function handleClear() {
    if (!confirm('Clear all imported data from this device?')) return;
    setBusy(true);
    try {
      await clearDb();
      setSelected(null);
      setResults([]);
      setQuery('');
      setStatus('Database cleared.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyCode(code: string) {
    try {
      await copyToClipboard(code);
      setStatus(`Copied Prod Code: ${code}`);
    } catch (e: any) {
      setStatus(`Copy failed: ${String(e?.message || e)}`);
    }
  }

  async function handlePasteAndSearch() {
    try {
      const text = (await readClipboardText()).trim();
      if (!text) {
        setStatus('Clipboard is empty.');
        return;
      }
      setQuery(text);
      setStatus(`Pasted & searching: ${text}`);
    } catch (e: any) {
      // Common on Chrome: clipboard read requires HTTPS + user gesture permissions
      setStatus(
        `Paste failed. Tip: click inside the search box and use Ctrl+V, or allow clipboard permissions. (${String(
          e?.message || e
        )})`
      );
    }
  }

  return (
    <div className="wrap">
      <header className="header">
        <div>
          <div className="title">Price History</div>
          <div className="subtitle">
            Import CSV → Search → See pricing trend
          </div>
        </div>

        <button className="btn ghost" disabled={busy} onClick={handleClear}>
          Clear
        </button>
      </header>

      <div className="card">
        <div className="row">
          <button
            className="btn"
            disabled={busy}
            onClick={() => handleImport(false)}
          >
            Import CSV (append)
          </button>
          <button
            className="btn ghost"
            disabled={busy}
            onClick={() => handleImport(true)}
          >
            Import CSV (replace)
          </button>
        </div>
        <div className="status">{status}</div>
      </div>

      <div className="card">
        {/* Search row with Paste button */}
        <div className="row" style={{ alignItems: 'center' }}>
          <input
            className="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by Prod Code or Description…"
            style={{ flex: 1 }}
          />
          <button
            className="btn ghost"
            disabled={busy}
            onClick={handlePasteAndSearch}
            title="Paste from clipboard and search"
            style={{ whiteSpace: 'nowrap' }}
          >
            Paste code
          </button>
        </div>

        {results.length === 0 ? (
          <div className="empty">No results.</div>
        ) : (
          <div className="list">
            {results.map((it) => (
              <button
                key={it.prodCode}
                className={
                  'listItem' +
                  (selected?.prodCode === it.prodCode ? ' active' : '')
                }
                onClick={() => setSelected(it)}
              >
                <div className="liTitle">{it.description}</div>

                <div className="liMeta">
                  {/* Prod code + copy */}
                  <span
                    className="pill"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleCopyCode(it.prodCode);
                    }}
                    title="Tap to copy Prod Code"
                    style={{ cursor: 'pointer' }}
                  >
                    {it.prodCode} ⧉
                  </span>

                  <span className="muted">Last: {it.lastDate || '—'}</span>
                </div>

                <div className="liRight">{currency(it.lastInc)}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div className="card">
          <div className="detailHead">
            <div>
              <div className="detailTitle">{selected.description}</div>
              <div className="detailSub">
                {/* Copy prod code in details */}
                <span
                  className="pill"
                  onClick={() => handleCopyCode(selected.prodCode)}
                  title="Tap to copy Prod Code"
                  style={{ cursor: 'pointer' }}
                >
                  {selected.prodCode} ⧉
                </span>
                <span className="muted">{points.length} records</span>
              </div>
            </div>

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

          {points.length < 2 ? (
            <div className="empty">Not enough data points to chart.</div>
          ) : (
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
            {points
              .slice()
              .reverse()
              .slice(0, 50)
              .map((p, idx) => (
                <div className="tRow" key={p.id ?? idx}>
                  <div className="tDate">{p.billDate}</div>
                  <div className="tMid">
                    <div className="tPrice">
                      {currency(showInc ? p.unitPriceInc : p.unitPriceEx)}
                    </div>
                    <div className="tMeta">
                      {[
                        p.supplierName,
                        p.billNumber ? `Bill ${p.billNumber}` : '',
                        p.quantity ? `Qty ${p.quantity}` : '',
                      ]
                        .filter(Boolean)
                        .join(' • ')}
                    </div>
                  </div>
                </div>
              ))}
          </div>
          <div className="footnote">Showing latest 50 rows for this item.</div>
        </div>
      )}
    </div>
  );
}
