import { useEffect, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/utils';

interface Props {
  label: string;
  value: number | string;
  icon: LucideIcon;
  trend?: string;
  trendUp?: boolean;
  accent?: 'cyan' | 'orange' | 'red' | 'green' | 'yellow';
  sub?: string;
}

const accentMap: Record<NonNullable<Props['accent']>, string> = {
  cyan: 'text-signal-400 border-signal-400/40 from-signal-400/25',
  orange: 'text-alert-400 border-alert-400/40 from-alert-400/25',
  red: 'text-fault-400 border-fault-400/40 from-fault-400/25',
  green: 'text-success-400 border-green-400/40 from-green-400/25',
  yellow: 'text-history-400 border-history-400/40 from-history-400/25',
};

export function StatCard({ label, value, icon: Icon, accent = 'cyan', sub }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const valRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!valRef.current) return;
    const el = valRef.current;
    const num = typeof value === 'number' ? value : null;
    if (num === null) {
      el.textContent = String(value);
      return;
    }
    const start = performance.now();
    const dur = 500;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(num * eased).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = num.toLocaleString();
    };
    requestAnimationFrame(step);
  }, [value]);

  return (
    <div
      ref={ref}
      className={cn(
        'relative card-border rounded-sm p-4 overflow-hidden fade-in',
      )}
    >
      <div
        className={cn(
          'absolute left-0 right-0 bottom-0 h-[2px] bg-gradient-to-r',
          accentMap[accent],
        )}
      />
      <div className="flex items-start justify-between mb-3">
        <div
          className={cn(
            'w-9 h-9 flex items-center justify-center rounded-sm border',
            accentMap[accent].split(' ').slice(0, 2).join(' '),
          )}
        >
          <Icon size={17} strokeWidth={1.8} />
        </div>
      </div>
      <div className="text-[11px] uppercase tracking-widest text-slate-500 mb-1">
        {label}
      </div>
      <div className="flex items-end gap-2">
        <span
          ref={valRef}
          className={cn('font-display text-3xl font-semibold', accentMap[accent].split(' ')[0])}
        >
          0
        </span>
      </div>
      {sub && <div className="text-[11px] text-slate-500 mt-2">{sub}</div>}
    </div>
  );
}
