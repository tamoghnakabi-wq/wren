// Client-side helpers for schedules (friendly presets <-> cron).

export function describeCronClient(cron: string): string {
  const [m, h, dom, mon, dow] = cron.split(/\s+/);
  const time = /^\d+$/.test(h) && /^\d+$/.test(m) ? fmtTime(Number(h), Number(m)) : null;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (time && dom === '*' && mon === '*') {
    if (dow === '*') return `Every day at ${time}`;
    if (dow === '1-5') return `Weekdays at ${time}`;
    if (dow === '0,6' || dow === '6,0') return `Weekends at ${time}`;
    if (/^\d$/.test(dow)) return `Every ${days[Number(dow)]} at ${time}`;
  }
  if (time && /^\d+$/.test(dom) && mon === '*' && dow === '*') return `Monthly on day ${dom} at ${time}`;
  if (m === '0' && h?.startsWith('*/')) return `Every ${h.slice(2)} hours`;
  if (h === '*' && /^\d+$/.test(m)) return `Every hour`;
  return cron;
}

function fmtTime(h: number, m: number) {
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export type Preset = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'hourly' | 'every-6h' | 'custom';

export function presetToCron(p: Preset, time: string, weekday: number, dayOfMonth: number, custom: string): string {
  const [hh, mm] = time.split(':').map((x) => Number(x) || 0);
  switch (p) {
    case 'daily':
      return `${mm} ${hh} * * *`;
    case 'weekdays':
      return `${mm} ${hh} * * 1-5`;
    case 'weekly':
      return `${mm} ${hh} * * ${weekday}`;
    case 'monthly':
      return `${mm} ${hh} ${dayOfMonth} * *`;
    case 'hourly':
      return `0 * * * *`;
    case 'every-6h':
      return `0 */6 * * *`;
    default:
      return custom;
  }
}
