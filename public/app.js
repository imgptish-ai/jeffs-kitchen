/* Frontend logic. Vanilla JS, no build step — talks only to this app's /api/*. */

const state = {
  config: null,
  results: [],
  tab: 'all', // 'all' | 'NA' | 'EU'
  sortKey: 'marketCap',
  sortDir: 'desc', // 'asc' | 'desc'
  pollTimer: null,
  expanded: new Set(), // mint addresses with open detail rows
};

const $ = (id) => document.getElementById(id);

// ---------- formatting ----------
function fmtUsd(n) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}

function fmtPct(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const cls = v >= 0 ? 'pos' : 'neg';
  return `<span class="${cls}">${v >= 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
}

function fmtTime(ms) {
  if (!ms) return '—';
  const tz = state.config?.timezone || 'America/Chicago';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function shortMint(m) {
  return m ? m.slice(0, 4) + '…' + m.slice(-4) : '';
}

const SRC_LABEL = {
  token: 'token creation',
  pair: 'pair created',
  buy: 'first buy',
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- data loading ----------
async function loadConfig() {
  const r = await fetch('/api/config');
  state.config = await r.json();
  renderConfig();
}

async function loadResults() {
  const r = await fetch('/api/results');
  const data = await r.json();
  state.results = Array.isArray(data.results) ? data.results : [];
  // attach a derived walletCount for sorting
  for (const t of state.results) t.walletCount = (t.wallets || []).length;
  render();
}

async function loadStatus() {
  const r = await fetch('/api/status');
  return r.json();
}

// ---------- rendering ----------
function renderConfig() {
  const c = state.config;
  if (!c) return;
  const badges = [
    `<span class="badge">window <strong>${c.scanWindowHours}h</strong></span>`,
    `<span class="badge">min mcap <strong>${fmtUsd(c.minMarketCap)}</strong></span>`,
    `<span class="badge">min vol <strong>${fmtUsd(c.minVolume)}</strong></span>`,
    `<span class="badge">tz <strong>${esc(c.timezone)}</strong></span>`,
  ];
  if (!c.heliusConfigured) {
    badges.push(`<span class="badge badge-warn">⚠ no Helius key</span>`);
  }
  $('configStrip').innerHTML = badges.join('');
  $('emptyWindow').textContent = c.scanWindowHours;
}

function activeRows() {
  let rows = state.results;
  if (state.tab !== 'all') rows = rows.filter((t) => t.sessionCategory === state.tab);
  const dir = state.sortDir === 'asc' ? 1 : -1;
  const key = state.sortKey;
  rows = [...rows].sort((a, b) => {
    const av = a[key] ?? -Infinity;
    const bv = b[key] ?? -Infinity;
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av).localeCompare(String(bv)) * dir;
    }
    return (av - bv) * dir;
  });
  return rows;
}

function rowHtml(t) {
  const open = state.expanded.has(t.mint);
  const priceChange = t.priceChange24h != null ? ` ${fmtPct(t.priceChange24h)}` : '';
  return `
    <tr class="row" data-mint="${esc(t.mint)}">
      <td class="col-token">
        <div class="tok">
          <div class="tok-top">
            <span class="tok-sym">${esc(t.symbol || '—')}</span>
            <span class="tok-name">${esc(t.name || '')}</span>
          </div>
          <span class="tok-mint">${shortMint(t.mint)}
            <button class="copy" data-copy="${esc(t.mint)}" title="Copy contract address">copy</button>
          </span>
        </div>
      </td>
      <td><span class="pill pill-${t.sessionCategory}">${t.sessionCategory}</span></td>
      <td class="num">${fmtUsd(t.marketCap)}</td>
      <td class="num">${fmtUsd(t.fdv)}</td>
      <td class="num" title="${t.peakConfidence === 'history' ? 'from price history' : 'estimate (no history)'}">${fmtUsd(t.athEstimate)}${t.peakConfidence === 'history' ? '' : '*'}</td>
      <td class="num">${fmtUsd(t.volume24h)}</td>
      <td class="num">${fmtUsd(t.liquidityUsd)}</td>
      <td class="num wallets-count">${(t.wallets || []).length}</td>
      <td>
        <div class="ts">
          <span class="ts-when">${fmtTime(t.sessionTimestampUsed)}</span>
          <span class="ts-src">${SRC_LABEL[t.sessionTimestampSource] || t.sessionTimestampSource}</span>
        </div>
      </td>
      <td class="col-link">
        <a class="chart-link" href="${esc(t.dexScreenerUrl)}" target="_blank" rel="noopener">open ↗</a>
      </td>
    </tr>
    ${open ? detailHtml(t) : ''}
  `;
}

function detailHtml(t) {
  const wallets = (t.wallets || [])
    .map((w) => `<a href="https://solscan.io/account/${esc(w)}" target="_blank" rel="noopener">${esc(w)}</a>`)
    .join('');
  return `
    <tr class="detail">
      <td colspan="10">
        <div class="detail-inner">
          <div class="detail-block">
            <h4>Why it passed</h4>
            <div class="reason">${esc(t.filterReason)}</div>
          </div>
          <div class="detail-block">
            <h4>Session</h4>
            <div class="kv reason">${esc(t.sessionCategoryReason)}</div>
          </div>
          <div class="detail-block">
            <h4>Market</h4>
            <div class="kv"><span>price</span> ${t.priceUsd != null ? '$' + t.priceUsd : '—'}</div>
            <div class="kv"><span>24h change</span> ${fmtPct(t.priceChange24h)}</div>
            <div class="kv"><span>buys / sells</span> ${t.buys24h ?? '—'} / ${t.sells24h ?? '—'}</div>
            <div class="kv"><span>dex</span> ${esc(t.dexId || '—')}</div>
          </div>
          <div class="detail-block">
            <h4>Timestamps</h4>
            <div class="kv"><span>token created</span> ${t.tokenCreatedAt ? fmtTime(t.tokenCreatedAt) : 'unknown'}</div>
            <div class="kv"><span>pair created</span> ${t.pairCreatedAt ? fmtTime(t.pairCreatedAt) : '—'}</div>
            <div class="kv"><span>first buy</span> ${fmtTime(t.firstBuyAt)}</div>
          </div>
          <div class="detail-block">
            <h4>Wallets (${(t.wallets || []).length})</h4>
            <div class="wallet-list">${wallets || '—'}</div>
          </div>
        </div>
      </td>
    </tr>
  `;
}

function render() {
  const rows = activeRows();

  $('countAll').textContent = state.results.length;
  $('countNA').textContent = state.results.filter((t) => t.sessionCategory === 'NA').length;
  $('countEU').textContent = state.results.filter((t) => t.sessionCategory === 'EU').length;

  const body = $('gridBody');
  const wrap = document.querySelector('.table-wrap');
  const empty = $('empty');

  if (rows.length === 0) {
    wrap.hidden = true;
    empty.hidden = false;
  } else {
    wrap.hidden = false;
    empty.hidden = true;
    body.innerHTML = rows.map(rowHtml).join('');
  }

  // sort indicators
  document.querySelectorAll('.grid thead th').forEach((th) => {
    th.classList.remove('sorted', 'asc');
    if (th.dataset.sort === state.sortKey) {
      th.classList.add('sorted');
      if (state.sortDir === 'asc') th.classList.add('asc');
    }
  });
}

// ---------- status / polling ----------
function setStatus(mode, text) {
  const el = $('status');
  el.classList.remove('is-scanning', 'is-ok', 'is-error');
  if (mode) el.classList.add(mode);
  $('statusText').textContent = text;
  $('scanline').classList.toggle('on', mode === 'is-scanning');
  $('scanBtn').disabled = mode === 'is-scanning';
}

function describeLastRun(lastRun) {
  if (!lastRun || !lastRun.finishedAt) return '';
  const secs = Math.round((lastRun.finishedAt - lastRun.startedAt) / 1000);
  return `${lastRun.total} tokens · ${lastRun.na} NA / ${lastRun.eu} EU · ${secs}s`;
}

async function refreshStatus() {
  const s = await loadStatus();
  if (s.scanning) {
    const since = s.lastRun ? Math.round((Date.now() - s.lastRun.startedAt) / 1000) : 0;
    setStatus('is-scanning', `Scanning… ${since}s`);
    $('errorBanner').hidden = true;
    if (!state.pollTimer) startPolling();
  } else {
    stopPolling();
    const lr = s.lastRun;
    if (lr && lr.error) {
      setStatus('is-error', 'Last scan failed');
      $('errorMsg').textContent = lr.error;
      $('errorBanner').hidden = false;
    } else if (lr && lr.ok) {
      setStatus('is-ok', `Done · ${describeLastRun(lr)}`);
      $('errorBanner').hidden = true;
    } else {
      setStatus('', 'Idle — ready to scan');
    }
  }
  return s;
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    const s = await refreshStatus();
    if (!s.scanning) {
      await loadResults(); // scan finished — pull fresh results
    }
  }, 2000);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

// ---------- actions ----------
async function runScan() {
  setStatus('is-scanning', 'Starting…');
  try {
    const r = await fetch('/api/scan', { method: 'POST' });
    if (r.status === 409) {
      setStatus('is-scanning', 'A scan is already running…');
      startPolling();
      return;
    }
    const data = await r.json();
    if (data.status === 'error') {
      setStatus('is-error', 'Could not start');
      $('errorMsg').textContent = data.error || 'Unknown error';
      $('errorBanner').hidden = false;
      return;
    }
    startPolling();
  } catch (err) {
    setStatus('is-error', 'Could not reach server');
    $('errorMsg').textContent = String(err);
    $('errorBanner').hidden = false;
  }
}

// ---------- events ----------
function wireEvents() {
  $('scanBtn').addEventListener('click', runScan);

  $('tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    state.tab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
    tab.classList.add('is-active');
    render();
  });

  document.querySelector('.grid thead').addEventListener('click', (e) => {
    const th = e.target.closest('th');
    if (!th || !th.dataset.sort) return;
    const key = th.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortKey = key;
      state.sortDir = 'desc';
    }
    render();
  });

  $('gridBody').addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.copy');
    if (copyBtn) {
      e.stopPropagation();
      navigator.clipboard?.writeText(copyBtn.dataset.copy);
      copyBtn.textContent = 'copied';
      setTimeout(() => (copyBtn.textContent = 'copy'), 1200);
      return;
    }
    if (e.target.closest('a')) return; // let links work
    const row = e.target.closest('tr.row');
    if (!row) return;
    const mint = row.dataset.mint;
    if (state.expanded.has(mint)) state.expanded.delete(mint);
    else state.expanded.add(mint);
    render();
  });
}

// ---------- boot ----------
(async function init() {
  wireEvents();
  await loadConfig();
  await loadResults();
  await refreshStatus();
})();
