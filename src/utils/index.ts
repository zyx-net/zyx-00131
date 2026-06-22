export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function hashString(input: string): string {
  let h1 = 0xdeadbeef ^ 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 = Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  h1 = Math.imul(h1 ^ (h1 >>> 16), 1597334677);
  const hex = (h1 >>> 0).toString(16).padStart(8, '0');
  return hex;
}

export function hashFields(obj: Record<string, any>, fields: string[]): string {
  const parts = fields.map((f) => String(obj[f] ?? '__NUL__'));
  return hashString(parts.join('|'));
}

export function parseTimestamp(raw: string, _format: string): number | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // 尝试纯数字时间戳
  const num = Number(s);
  if (!Number.isNaN(num) && /^\d+$/.test(s)) {
    if (num > 1e14) return Math.floor(num);
    if (num > 1e11) return num;
    if (num > 1e8) return num * 1000;
  }
  const ts = Date.parse(s);
  if (!Number.isNaN(ts)) return ts;
  return null;
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return '-';
  const d = new Date(ts);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const se = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${mo}-${da} ${h}:${mi}:${se}`;
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes.toFixed(1)} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  if (h < 24) return `${h}小时${m}分钟`;
  const d = Math.floor(h / 24);
  const hr = h - d * 24;
  return `${d}天${hr}小时${m}分钟`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function getErrorTypeLabel(t: string): string {
  switch (t) {
    case 'TIME_INVERSION': return '时间倒置';
    case 'MISSING_FIELD': return '字段缺失';
    case 'PARSE_ERROR': return '解析错误';
    default: return t;
  }
}
