/**
 * Tiny in-memory record of "is a scan running, and how did the last one go".
 * The web server reads/writes this so the frontend can poll status instead of
 * holding a long HTTP request open while a scan runs.
 *
 * Single-process / single-user by design. If a scan is in flight when the
 * server restarts, state simply resets to idle — the next scan is unaffected.
 */
export interface LastRun {
  startedAt: number;
  finishedAt: number | null;
  ok: boolean;
  error: string | null;
  total: number;
  na: number;
  eu: number;
}

let scanning = false;
let lastRun: LastRun | null = null;

export function isScanning(): boolean {
  return scanning;
}

export function getLastRun(): LastRun | null {
  return lastRun;
}

export function beginScan(): void {
  scanning = true;
  lastRun = {
    startedAt: Date.now(),
    finishedAt: null,
    ok: false,
    error: null,
    total: 0,
    na: 0,
    eu: 0,
  };
}

export function endScan(update: Partial<LastRun>): void {
  scanning = false;
  if (lastRun) lastRun = { ...lastRun, finishedAt: Date.now(), ...update };
}
