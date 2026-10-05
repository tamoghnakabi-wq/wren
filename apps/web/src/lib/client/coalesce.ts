/**
 * Run `fn` one call at a time: a call made while one is running doesn't start a second, overlapping
 * run; it makes the running one go once more when it ends (however many calls came in meanwhile).
 * So runs finish in the order they started, and the last one always starts after the last call.
 */
export function coalesce(fn: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await fn();
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}
