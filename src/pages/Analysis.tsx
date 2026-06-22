import { useEffect, useMemo, useState } from 'react';
import {
  Filter,
  Download,
  RefreshCw,
  Calendar,
  Tag,
  Check,
  ChevronDown,
  Table,
  X,
} from 'lucide-react';
import { TimelineChart } from '@/components/TimelineChart';
import { AnnotationModal } from '@/components/AnnotationModal';
import { useAppStore } from '@/stores/appStore';
import { db } from '@/db';
import type {
  AnnotationFilter,
  ConfigVersion,
  IntervalWithAnnotation,
} from '@/types';
import { filterIntervals, runAnalysis } from '@/services/analyzer';
import {
  buildCsvExport,
  buildHtmlReport,
  downloadBlob,
  saveExportRecord,
} from '@/services/exporter';
import { cn, formatDateTime, formatDuration } from '@/utils';

export function Analysis() {
  const activeConfig = useAppStore((s) => s.activeConfig);
  const filter = useAppStore((s) => s.filter);
  const setFilter = useAppStore((s) => s.setFilter);
  const resetFilter = useAppStore((s) => s.resetFilter);
  const showToast = useAppStore((s) => s.showToast);
  const reloadConfigs = useAppStore((s) => s.reloadConfigs);

  const [allIntervals, setAllIntervals] = useState<IntervalWithAnnotation[]>([]);
  const [selected, setSelected] = useState<IntervalWithAnnotation | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [config, setConfig] = useState<ConfigVersion | null>(null);
  const [dataVersion, setDataVersion] = useState(0);

  const loadData = async (force = false) => {
    if (!activeConfig) return;
    setLoading(true);
    try {
      await reloadConfigs();
      const cfg = (await useAppStore.getState().activeConfig) || activeConfig;
      await db.restoreConfigAnnotations(cfg.id);
      const r = await runAnalysis(cfg, force);
      setConfig(cfg);
      setAllIntervals(r.intervals);
      setDataVersion((v) => v + 1);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData(false);
  }, [activeConfig?.id]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void loadData(false);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  const filtered = useMemo(() => {
    if (!config) return [];
    let f = filter;
    if (f.configVersion !== config.id) f = { ...f, configVersion: config.id };
    return filterIntervals(allIntervals, f);
  }, [allIntervals, filter, config, dataVersion]);

  const summary = useMemo(() => {
    const ann = filtered.filter((i) => i.annotation).length;
    const totalMins = filtered.reduce((s, i) => s + i.durationMinutes, 0);
    return {
      total: filtered.length,
      annotated: ann,
      rate: filtered.length > 0 ? Math.round((ann / filtered.length) * 1000) / 10 : 0,
      totalHours: Math.round((totalMins / 60) * 10) / 10,
    };
  }, [filtered]);

  const sitesStats = useMemo(() => {
    const map = new Map<string, { count: number; duration: number; annotated: number; last: number }>();
    for (const iv of filtered) {
      const s = map.get(iv.siteId) || { count: 0, duration: 0, annotated: 0, last: 0 };
      s.count++;
      s.duration += iv.durationMinutes;
      if (iv.annotation) s.annotated++;
      if (iv.endTime > s.last) s.last = iv.endTime;
      map.set(iv.siteId, s);
    }
    return Array.from(map.entries())
      .map(([site, v]) => ({ site, ...v, avgMins: v.count ? v.duration / v.count : 0 }))
      .sort((a, b) => b.count - a.count);
  }, [filtered]);

  if (!config) {
    return (
      <div className="p-10 text-center text-slate-500">
        正在加载配置...
      </div>
    );
  }

  const toggleItem = (key: 'siteGroupIds' | 'anomalyTypeCodes', value: string) => {
    const arr = filter[key] as string[];
    const has = arr.includes(value);
    setFilter({ [key]: has ? arr.filter((x) => x !== value) : [...arr, value] } as any);
  };

  const handleExport = async (type: 'CSV' | 'HTML') => {
    setExportBusy(true);
    try {
      let content: string;
      const name = `outage-report-${config.id}-${Date.now()}.${type.toLowerCase()}`;
      if (type === 'CSV') content = buildCsvExport(filtered, config, filter);
      else content = buildHtmlReport(filtered, config, filter);
      const mime = type === 'CSV' ? 'text/csv;charset=utf-8' : 'text/html;charset=utf-8';
      const blob = new Blob([type === 'CSV' ? '\uFEFF' + content : content], { type: mime });
      await saveExportRecord(type, name, content, config, filter, filtered);
      downloadBlob(blob, name);
      showToast('success', `已导出 ${name}，筛选条件已嵌入`);
    } catch (e) {
      showToast('error', `导出失败: ${(e as Error).message}`);
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <div className="p-6 space-y-5 min-h-screen deep-dot-grid">
      <header className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="h-5 w-1 bg-signal-400" />
            <h1 className="font-display text-xl text-signal-400 tracking-wider glow-text">
              断报分析
            </h1>
          </div>
          <p className="text-sm text-slate-400">
            共 {summary.total} 个区间 · 已标注 {summary.annotated} ({summary.rate}%) · 累计断报 {summary.totalHours} 小时
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMenuOpen(menuOpen === 'export' ? null : 'export')}
            disabled={exportBusy || filtered.length === 0}
            className="btn-primary flex items-center gap-2 relative"
          >
            <Download size={14} />
            {exportBusy ? '导出中...' : '导出报告'}
            <ChevronDown size={14} />
          </button>
          {menuOpen === 'export' && (
            <div className="absolute mt-24 right-6 z-40 card-border rounded-sm overflow-hidden fade-in w-44">
              {(['CSV', 'HTML'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setMenuOpen(null);
                    void handleExport(t);
                  }}
                  className="w-full text-left px-4 py-2.5 text-sm hover:bg-signal-400/10 text-slate-300 flex items-center gap-2 border-b border-signal-400/10 last:border-0"
                >
                  {t === 'CSV' ? <Table size={13} /> : <Download size={13} />}
                  导出为 {t}（含筛选快照）
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => void loadData(true)}
            className="btn-ghost flex items-center gap-2"
            disabled={loading}
          >
            <RefreshCw size={13} className={cn(loading && 'animate-spin')} /> 重新计算
          </button>
        </div>
      </header>

      {/* 筛选面板 */}
      <div className="card-border rounded-sm p-4 fade-in">
        <div className="flex items-center gap-2 mb-3">
          <Filter size={14} className="text-signal-400" />
          <span className="font-display text-sm text-signal-400 tracking-wider">筛选条件</span>
          <div className="ml-auto flex items-center gap-2 text-[11px]">
            {filter.siteGroupIds.length > 0 && <ActiveTag label={`分组:${filter.siteGroupIds.length}`} onClear={() => setFilter({ siteGroupIds: [] })} />}
            {filter.anomalyTypeCodes.length > 0 && <ActiveTag label={`异常:${filter.anomalyTypeCodes.length}`} onClear={() => setFilter({ anomalyTypeCodes: [] })} />}
            {filter.annotationStatus !== 'ALL' && (
              <ActiveTag
                label={filter.annotationStatus === 'ANNOTATED' ? '已标注' : '未标注'}
                onClear={() => setFilter({ annotationStatus: 'ALL' })}
              />
            )}
            {filter.timeRange && (
              <ActiveTag
                label={
                  `${formatDateTime(filter.timeRange[0]).slice(5, 11)} ~ ${formatDateTime(filter.timeRange[1]).slice(5, 11)}`
                }
                onClear={() => setFilter({ timeRange: null })}
              />
            )}
            <button onClick={resetFilter} className="text-slate-500 hover:text-signal-400 ml-2">
              重置
            </button>
          </div>
        </div>

        <div className="grid grid-cols-5 gap-4 text-sm">
          <div>
            <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">
              <Calendar size={11} /> 时间范围
            </label>
            <div className="space-y-1.5">
              <input
                type="datetime-local"
                className="input-base w-full text-xs"
                value={filter.timeRange ? new Date(filter.timeRange[0] - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}
                onChange={(e) => {
                  const t1 = e.target.value ? new Date(e.target.value).getTime() : null;
                  const t2 = filter.timeRange?.[1] || null;
                  if (t1) setFilter({ timeRange: [t1, t2 || Date.now()] });
                  else setFilter({ timeRange: null });
                }}
              />
              <input
                type="datetime-local"
                className="input-base w-full text-xs"
                value={filter.timeRange ? new Date(filter.timeRange[1] - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}
                onChange={(e) => {
                  const t2 = e.target.value ? new Date(e.target.value).getTime() : null;
                  const t1 = filter.timeRange?.[0] || 0;
                  if (t2) setFilter({ timeRange: [t1, t2] });
                  else setFilter({ timeRange: null });
                }}
              />
            </div>
          </div>
          <div className="col-span-2">
            <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">
              <Tag size={11} /> 站点分组
            </label>
            <div className="flex flex-wrap gap-1.5">
              {config.siteGroups.map((g) => (
                <Chip
                  key={g.id}
                  label={`${g.name} (${g.siteIds.length})`}
                  active={filter.siteGroupIds.includes(g.id)}
                  onClick={() => toggleItem('siteGroupIds', g.id)}
                />
              ))}
            </div>
          </div>
          <div>
            <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">
              异常类型
            </label>
            <div className="flex flex-wrap gap-1.5">
              {config.anomalyTypes.map((t) => (
                <Chip
                  key={t.code}
                  label={t.name}
                  color={t.color}
                  active={filter.anomalyTypeCodes.includes(t.code)}
                  onClick={() => toggleItem('anomalyTypeCodes', t.code)}
                />
              ))}
            </div>
          </div>
          <div>
            <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">
              <Check size={11} /> 标注状态
            </label>
            <select
              value={filter.annotationStatus}
              onChange={(e) => setFilter({ annotationStatus: e.target.value as AnnotationFilter })}
              className="input-base w-full text-xs"
            >
              <option value="ALL">全部</option>
              <option value="ANNOTATED">已标注</option>
              <option value="UNANNOTATED">未标注</option>
            </select>
          </div>
        </div>
      </div>

      {loading && filtered.length === 0 ? (
        <div className="card-border rounded-sm p-12 text-center text-slate-500">
          <RefreshCw size={22} className="animate-spin mx-auto mb-3 text-signal-400" />
          正在分析...
        </div>
      ) : (
        <>
          <TimelineChart
            intervals={filtered}
            config={config}
            onSelect={(iv) => {
              setSelected(iv);
              setModalOpen(true);
            }}
            selectedId={selected?.id}
          />

          {/* 站点健康度表 */}
          <div className="card-border rounded-sm p-5 fade-in">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Table size={14} className="text-signal-400" />
                <h3 className="font-display text-sm tracking-wider text-signal-400">
                  站点断报统计
                </h3>
              </div>
              <span className="text-[11px] text-slate-600">
                {sitesStats.length} 个站点
              </span>
            </div>
            <div className="overflow-x-auto scroll-slim">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-signal-400/15 text-left">
                    <th className="py-2.5 px-3 text-[10px] uppercase tracking-widest text-slate-500">站点ID</th>
                    <th className="py-2.5 px-3 text-[10px] uppercase tracking-widest text-slate-500">断报次数</th>
                    <th className="py-2.5 px-3 text-[10px] uppercase tracking-widest text-slate-500">累计时长</th>
                    <th className="py-2.5 px-3 text-[10px] uppercase tracking-widest text-slate-500">平均时长</th>
                    <th className="py-2.5 px-3 text-[10px] uppercase tracking-widest text-slate-500">已标注</th>
                    <th className="py-2.5 px-3 text-[10px] uppercase tracking-widest text-slate-500">最近断报</th>
                  </tr>
                </thead>
                <tbody>
                  {sitesStats.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-10 text-center text-slate-600">
                        暂无数据
                      </td>
                    </tr>
                  ) : (
                    sitesStats.map((s, i) => {
                      const pct = s.count > 0 ? (s.annotated / s.count) * 100 : 0;
                      return (
                        <tr
                          key={s.site}
                          className={cn(
                            'border-b border-signal-400/5 hover:bg-signal-400/5 transition-colors cursor-pointer',
                            i % 2 && 'bg-deep-800/20',
                          )}
                          onClick={() => {
                            const firstIv = filtered.find((x) => x.siteId === s.site);
                            if (firstIv) {
                              setSelected(firstIv);
                              setModalOpen(true);
                            }
                          }}
                        >
                          <td className="py-2.5 px-3 font-mono text-signal-400">{s.site}</td>
                          <td className="py-2.5 px-3 text-alert-400 font-display">{s.count}</td>
                          <td className="py-2.5 px-3">{formatDuration(s.duration)}</td>
                          <td className="py-2.5 px-3 text-slate-400">{formatDuration(s.avgMins)}</td>
                          <td className="py-2.5 px-3">
                            <div className="flex items-center gap-2">
                              <div className="w-20 h-1.5 bg-deep-900 rounded-sm overflow-hidden">
                                <div className="h-full bg-success-400" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="text-[11px] text-slate-500">{pct.toFixed(0)}%</span>
                            </div>
                          </td>
                          <td className="py-2.5 px-3 font-mono text-[11px] text-slate-500">
                            {formatDateTime(s.last)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <AnnotationModal
        open={modalOpen}
        interval={selected}
        config={config}
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          void loadData(false);
        }}
      />
    </div>
  );
}

function Chip({
  label,
  active,
  onClick,
  color,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      style={color && active ? { borderColor: color + '99', color, backgroundColor: color + '15' } : undefined}
      className={cn(
        'px-2.5 py-1 text-[11px] rounded-sm border transition-all',
        active
          ? 'border-signal-400 bg-signal-400/15 text-signal-400 shadow-glow-signal'
          : 'border-signal-400/15 bg-deep-800/30 text-slate-400 hover:text-signal-300 hover:border-signal-400/30',
      )}
    >
      {label}
    </button>
  );
}

function ActiveTag({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-signal-400/10 border border-signal-400/30 text-signal-400">
      {label}
      <X size={10} onClick={(e) => { e.stopPropagation(); onClear(); }} className="cursor-pointer hover:text-signal-300" />
    </span>
  );
}
