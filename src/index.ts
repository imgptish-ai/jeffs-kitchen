/**
 * Entry point for a single manual scan:  `npm run scan`
 */
import { runScan } from './scanner';
import { log } from './util';

runScan()
  .then(() => {
    log.step('Done.');
    process.exit(0);
  })
  .catch((err) => {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
