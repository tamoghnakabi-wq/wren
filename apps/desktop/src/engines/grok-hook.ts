// PreToolUse hook for Grok Build (command hook contract, docs.x.ai/build/features/hooks):
// reads the event JSON on stdin, asks the Wren desktop app (localhost, per-run
// token) whether the tool may run, prints {"decision": ...} and exits 0 (allow)
// or 2 (deny). Any failure here denies, never allows.
import { APPROVE_HELPER_MS, postToWren } from './bridge-client';

const url = process.env.WREN_APPROVAL_URL;
const token = process.env.WREN_APPROVAL_TOKEN;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  try {
    if (!url || !token) throw new Error('Wren approval bridge is not configured.');
    const ev = JSON.parse(input || '{}');
    // Not fetch, which gives up after 5 minutes: the user may take longer to decide (see bridge-client.ts).
    // Grok treats a hook that runs out of time (3600 s) as "allow", so this one denies well before that.
    const d = ((await postToWren(url, token, { tool_name: ev.toolName ?? ev.tool_name ?? 'unknown', input: ev.toolInput ?? ev.tool_input ?? {}, tool_use_id: ev.toolUseId ?? ev.tool_use_id }, { timeoutMs: APPROVE_HELPER_MS })) ?? {}) as { behavior?: unknown; message?: unknown };
    if (d.behavior === 'allow') {
      process.stdout.write(JSON.stringify({ decision: 'allow' }));
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({ decision: 'deny', reason: d.behavior === 'deny' && typeof d.message === 'string' && d.message ? d.message : 'Denied by Wren.' }));
    process.exit(2);
  } catch (e) {
    process.stdout.write(JSON.stringify({ decision: 'deny', reason: `Wren could not evaluate this action: ${(e as Error).message}` }));
    process.exit(2);
  }
});
