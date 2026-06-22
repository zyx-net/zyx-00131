import { useMemo } from 'react';
import type { ConfigVersion, IntervalWithAnnotation } from '@/types';
import { formatDateTime, formatDuration } from '@/utils';

interface Props {
  intervals: IntervalWithAnnotation[];
  config: ConfigVersion;
  onSelect: (iv: IntervalWithAnnotation) => void;
  selectedId?: string | null;
}

export function TimelineChart({ intervals, config, onSelect, selectedId }: Props) {
  const { sites, minT, maxT, rows } = useMemo(() => {
    const set = new Set<string>();
    intervals.forEach((iv) => set.add(iv.siteId));
    const siteArr = Array.from(set).sort();
    let min = Infinity;
    let max = -Infinity;
    intervals.forEach((iv) => {
      if (iv.startTime < min) min = iv.startTime;
      if (iv.endTime > max) max = iv.endTime;
    });
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = Date.now() - 86400000;
      max = Date.now();
    }
    const pad = (max - min) * 0.03;
    min -= pad;
    max += pad;

    const total = max - min;
    const r = siteArr.map((site) => {
      const siteIvs = intervals.filter((iv) => iv.siteId === site);
      return {
        site,
        items: siteIvs.map((iv) => {
          const anomaly = config.anomalyTypes.find((t) => t.code === iv.anomalyTypeCode);
          const annotated = !!iv.annotation;
          return {
            id: iv.id,
            left: ((iv.startTime - min) / total) * 100,
            width: Math.max(0.3, ((iv.endTime - iv.startTime) / total) * 100),
            color: anomaly?.color || '#FF8A3D',
            annotated,
            duration: iv.durationMinutes,
            interval: iv,
          };
        }),
      };
    });
    return { sites: siteArr, minT: min, maxT: max, rows: r };
  }, [intervals, config]);

  // 生成 5 个时间刻度
  const ticks = useMemo(() => {
    const arr = [];
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      const t = minT + ((maxT - minT) * i) / steps;
      arr.push({ pct: (i / steps) * 100, t });
    }
    return arr;
  }, [minT, maxT]);

  if (intervals.length === 0) {
    return (
      <div className="card-border rounded-sm p-12 text-center">
        <div className="text-slate-500 text-sm">没有符合条件的断报区间</div>
        <div className="text-[11px] text-slate-600 mt-1">请先导入遥测日志或调整筛选条件</div>
      </div>
    );
  }

  return (
    <div className="card-border rounded-sm p-5 fade-in">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="font-display text-signal-400 text-sm tracking-wider">
            断报时间轴
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {formatDateTime(minT)} ~ {formatDateTime(maxT)} · {sites.length} 个站点 ·{' '}
            {intervals.length} 个区间
          </div>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-alert-400/70 inline-block" />
            <span className="text-slate-400">未标注</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm bg-success-400/70 inline-block" />
            <span className="text-slate-400">已标注</span>
          </div>
        </div>
      </div>

      <div className="relative">
        <div className="relative h-7 border-b border-signal-400/15 ml-28 mr-2">
          {ticks.map((tk, i) => (
            <div
              key={i}
              className="absolute top-0 -translate-x-1/2 h-full border-l border-signal-400/10"
              style={{ left: `${tk.pct}%` }}
            >
              <div className="text-[10px] text-slate-500 -translate-x-1/2 pl-1 whitespace-nowrap font-mono">
                {formatDateTime(tk.t).slice(5, 16)}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-1 space-y-1.5">
          {rows.map((row) => (
            <div key={row.site} className="flex items-stretch h-9 group">
              <div className="w-28 shrink-0 pr-3 flex items-center justify-end">
                <span className="font-mono text-[11px] text-slate-400 group-hover:text-signal-400 transition-colors">
                  {row.site}
                </span>
              </div>
              <div className="flex-1 relative bg-deep-800/40 rounded-sm overflow-hidden border border-signal-400/10">
                {/* 网格竖线 */}
                {ticks.map((tk, i) => (
                  <div
                    key={i}
                    className="absolute top-0 bottom-0 border-l border-signal-400/5"
                    style={{ left: `${tk.pct}%` }}
                  />
                ))}
                {row.items.map((it) => (
                  <button
                    key={it.id}
                    onClick={() => onSelect(it.interval)}
                    style={{
                      left: `${it.left}%`,
                      width: `${it.width}%`,
                      backgroundColor: it.annotated
                        ? 'rgba(54, 211, 153, 0.75)'
                        : it.color,
                      boxShadow:
                        selectedId === it.id
                          ? `0 0 0 2px #00D4FF, 0 0 10px rgba(0,212,255,0.4)`
                          : undefined,
                      opacity: selectedId && selectedId !== it.id ? 0.55 : 1,
                    }}
                    className="absolute top-1.5 bottom-1.5 rounded-sm transition-all cursor-pointer hover:brightness-110 hover:scale-y-110 hover:shadow-glow-signal animate-pulse-signal"
                    title={`${it.interval.siteId} · ${formatDuration(it.duration)}`}
                  />
                ))}
              </div>
              <div className="w-1 shrink-0" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
