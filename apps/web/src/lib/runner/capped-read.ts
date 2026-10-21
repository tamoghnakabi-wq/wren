import type { Readable } from 'node:stream';

// Reading a file out of the cloud computer with a byte limit (W-191). The SDK's readFileToBuffer
// collects the whole file into one buffer, however big, so an agent could make the function that
// runs its task hold any amount. This reads the SDK's stream instead, counts the bytes as they
// arrive and stops (closing the stream and its request) as soon as the file is bigger than the
// caller allows. The count decides, not a size asked for first: the file can grow while it's read.

export const MB = 1024 * 1024;

export type CappedRead =
  | { status: 'ok'; data: Buffer }
  | { status: 'missing' }
  /** Bigger than the limit. Nothing past it was kept, and the transfer was ended. */
  | { status: 'too_large' }
  /** The caller's signal ended it (the task was stopped). */
  | { status: 'stopped' }
  /** It took longer than `timeoutMs`. */
  | { status: 'timed_out' };

/** The part of the SDK's Sandbox this needs: its streaming read. */
export interface StreamingFiles {
  readFile(file: { path: string }, opts?: { signal?: AbortSignal }): Promise<NodeJS.ReadableStream | null>;
}

export async function readCapped(sb: StreamingFiles, path: string, maxBytes: number, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CappedRead> {
  if (opts.signal?.aborted) return { status: 'stopped' };
  // The request's own signal: the SDK hands it to its fetch, so aborting it ends the transfer
  // whatever the stream does.
  const request = new AbortController();
  let ended: 'stopped' | 'timed_out' | undefined;
  let stream: NodeJS.ReadableStream | null = null;
  const end = (why: 'stopped' | 'timed_out') => {
    ended ??= why;
    request.abort(new Error(why === 'stopped' ? 'The read was stopped.' : 'The read took too long.'));
    close(stream);
  };
  const onAbort = () => end('stopped');
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => end('timed_out'), opts.timeoutMs);
  try {
    const opening = sb.readFile({ path }, { signal: request.signal });
    // A stream that only arrives after the read ended is closed at once.
    opening.then(
      (s) => {
        if (request.signal.aborted) close(s);
      },
      () => {},
    );
    stream = await new Promise<NodeJS.ReadableStream | null>((resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
      opening.then(resolve, reject);
    });
    if (stream === null) return { status: 'missing' };
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (size + b.byteLength > maxBytes) {
        request.abort();
        close(stream);
        return { status: 'too_large' };
      }
      chunks.push(b);
      size += b.byteLength;
    }
    // A stream closed by a Stop or the time limit may end quietly instead of failing.
    if (ended) return { status: ended };
    return { status: 'ok', data: Buffer.concat(chunks, size) };
  } catch (e) {
    if (ended) return { status: ended };
    throw e;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    close(stream);
  }
}

/** End a stream without an error (one nobody listens to would be thrown as unhandled). */
function close(s: NodeJS.ReadableStream | null) {
  const r = s as Partial<Pick<Readable, 'destroy' | 'destroyed'>> | null;
  if (r && typeof r.destroy === 'function' && !r.destroyed) r.destroy();
}

/** The part of the SDK's finished command this needs: its output as a stream of log lines. */
export interface CommandLogs {
  logs(opts?: { signal?: AbortSignal }): AsyncIterable<{ stream: string; data: string }>;
}

/**
 * A finished command's stdout, read through the SDK's log stream up to `maxBytes` of output (stdout and stderr
 * both count, as both come in). `stdout()` would collect all of it into this function, and what a command
 * prints in the agent's computer is the agent's to decide (W-191): past the limit the stream is closed and
 * the rest is never fetched.
 */
export async function commandOutput(cmd: CommandLogs, maxBytes: number): Promise<{ stdout: string; truncated: boolean }> {
  const stop = new AbortController();
  let out = '';
  let size = 0;
  let truncated = false;
  try {
    for await (const line of cmd.logs({ signal: stop.signal })) {
      size += Buffer.byteLength(line.data);
      if (size > maxBytes) {
        truncated = true;
        break; // ends the iteration, which closes the stream
      }
      if (line.stream === 'stdout') out += line.data;
    }
  } finally {
    stop.abort();
  }
  return { stdout: out, truncated };
}
