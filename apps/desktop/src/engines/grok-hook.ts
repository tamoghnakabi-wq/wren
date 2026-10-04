// PreToolUse hook for Grok Build (command hook contract, docs.x.ai/build/features/hooks):
// reads the event JSON on stdin, asks the Wren desktop app (localhost, per-run
// token) whether the tool may run, prints {"decision": ...} and exits 0 (allow)
// or 2 (deny). Any failure here denies, never allows.

const url = process.env.WREN_APPROVAL_URL;
const token = process.env.WREN_APPROVAL_TOKEN;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  try {
    if (!url || !token) throw new Error('Wren approval bridge is not configured.');
    const ev = JSON.parse(input || '{}');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ tool_name: ev.toolName ?? ev.tool_name ?? 'unknown', input: ev.toolInput ?? ev.tool_input ?? {}, tool_use_id: ev.toolUseId ?? ev.tool_use_id }),
    });
    const d = (await res.json()) as { behavior: 'allow' | 'deny'; message?: string };
    if (d.behavior === 'allow') {
      process.stdout.write(JSON.stringify({ decision: 'allow' }));
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({ decision: 'deny', reason: d.message ?? 'Denied by Wren.' }));
    process.exit(2);
  } catch (e) {
    process.stdout.write(JSON.stringify({ decision: 'deny', reason: `Wren could not evaluate this action: ${(e as Error).message}` }));
    process.exit(2);
  }
});
