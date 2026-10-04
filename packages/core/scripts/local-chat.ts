import { createModelClient } from '../src/models/index';
const c = createModelClient({ source: 'local', baseUrl: 'http://127.0.0.1:1234/v1' });
const t0 = Date.now();
const r = await c.stream({ model: process.argv[2] ?? 'kestrel-ai/kestrel-4b', instructions: 'You are terse.', events: [{ id: 'u', type: 'message', status: 'done', data: { role: 'user', text: 'Say hi in 3 words.' } }], tools: [], hosted: [] }, () => {});
console.log(JSON.stringify(r.text), r.usage, Date.now() - t0, 'ms');
