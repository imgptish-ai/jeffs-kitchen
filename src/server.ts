/**
 * Web server: serves the dashboard (public/) and a small JSON API.
 *
 * WHY A SERVER (and not just an HTML file):
 *   The scan logic must run server-side. Your Helius API key lives in .env and
 *   is never sent to the browser, and the browser can't make the paginated,
 *   batched Solana/DEX Screener calls directly (CORS + key exposure). The
 *   frontend only ever talks to THIS server's /api/* endpoints.
 *
 * API:
 *   GET  /api/config    -> safe, non-secret settings for display
 *   GET  /api/status    -> { scanning, lastRun }  (poll this while a scan runs)
 *   GET  /api/results   -> { results: TokenResult[] }  (reads output/results.json)
 *   POST /api/scan      -> starts a scan in the background; returns immediately
 *
 * Run with:  npm run serve
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config';
import { runScan } from './scanner';
import { log } from './util';
import * as scanState from './scanState';

const app = express();
app.use(express.json());

// Serve the static dashboard.
const publicDir = path.resolve('public');
app.use(express.static(publicDir));

const heliusReady = () =>
  Boolean(CONFIG.heliusApiKey && CONFIG.heliusApiKey !== 'your_helius_api_key_here');

// --- Config (never returns secrets) ---
app.get('/api/config', (_req, res) => {
  res.json({
    scanWindowHours: CONFIG.scanWindowHours,
    minMarketCap: CONFIG.minMarketCap,
    minVolume: CONFIG.minVolume,
    mcapMode: CONFIG.mcapMode,
    timezone: CONFIG.timezone,
    scheduleIntervalHours: CONFIG.scheduleIntervalHours,
    heliusConfigured: heliusReady(),
  });
});

// --- Status (frontend polls this) ---
app.get('/api/status', (_req, res) => {
  res.json({ scanning: scanState.isScanning(), lastRun: scanState.getLastRun() });
});

// --- Last results (from disk) ---
app.get('/api/results', (_req, res) => {
  const file = path.join(CONFIG.outputDir, CONFIG.files.mainJson);
  if (!fs.existsSync(file)) {
    res.json({ results: [] });
    return;
  }
  try {
    const results = JSON.parse(fs.readFileSync(file, 'utf8'));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: `Could not read results file: ${(err as Error).message}` });
  }
});

// --- Start a scan (non-blocking) ---
app.post('/api/scan', (_req, res) => {
  if (scanState.isScanning()) {
    res.status(409).json({ status: 'already_running' });
    return;
  }
  if (!heliusReady()) {
    res.status(400).json({
      status: 'error',
      error: 'HELIUS_API_KEY is not set. Add it to your .env file and restart the server.',
    });
    return;
  }

  scanState.beginScan();
  res.json({ status: 'started' });

  // Fire-and-forget: the frontend polls /api/status for completion.
  (async () => {
    try {
      const results = await runScan();
      const na = results.filter((r) => r.sessionCategory === 'NA').length;
      const eu = results.filter((r) => r.sessionCategory === 'EU').length;
      scanState.endScan({ ok: true, total: results.length, na, eu });
    } catch (err) {
      log.error(`Web scan failed: ${(err as Error).message}`);
      scanState.endScan({ ok: false, error: (err as Error).message });
    }
  })();
});

app.listen(CONFIG.port, () => {
  log.step(`Dashboard running at http://localhost:${CONFIG.port}`);
  if (!heliusReady()) {
    log.warn('HELIUS_API_KEY is not set — add it to .env and restart, or scans will fail.');
  }
});
