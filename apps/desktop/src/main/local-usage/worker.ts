// Worker thread for scan.ts, so reading a few GB of logs never holds up the window.
import { parentPort, workerData } from 'node:worker_threads';
import { scan, type ScanInput } from './scan';

scan(workerData as ScanInput).then(
  (report) => parentPort?.postMessage({ report }),
  (e: unknown) => parentPort?.postMessage({ error: e instanceof Error ? e.message : String(e) }),
);
