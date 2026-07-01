/**
 * Scheduled scanning:  `npm run scan:watch`
 *
 * Runs one scan immediately, then repeats every CONFIG.scheduleIntervalHours
 * (default 12h). Each individual scan still looks back over the full
 * CONFIG.scanWindowHours (default 24h) window, so consecutive 12h runs overlap
 * by ~12h and you won't miss buys that happened between runs.
 *
 * This is a simple in-process loop (no cron needed). Keep the process running
 * (e.g. via pm2, systemd, tmux, or a container) for it to keep firing.
 */
import { runScan } from './scanner';
import { CONFIG } from './config';
import { log } from './util';
import { formatInZone } from './time';

const intervalMs = CONFIG.scheduleIntervalHours * 3600 * 1000;
let running = false;

async function tick(): Promise<void> {
  if (running) {
    log.warn('Previous scan still running; skipping this tick.');
    return;
  }
  running = true;
  try {
    await runScan();
  } catch (err) {
    log.error(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
    const next = Date.now() + intervalMs;
    log.step(`Next scan around ${formatInZone(next, CONFIG.timezone)}.`);
  }
}

log.step(
  `Scheduler starting: scanning now, then every ${CONFIG.scheduleIntervalHours}h ` +
    `(each scan looks back ${CONFIG.scanWindowHours}h). Press Ctrl+C to stop.`,
);

void tick();
setInterval(() => void tick(), intervalMs);

// Keep graceful shutdown clean.
process.on('SIGINT', () => {
  log.step('Received SIGINT — shutting down scheduler.');
  process.exit(0);
});
