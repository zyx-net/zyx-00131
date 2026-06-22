import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  History,
  Download,
  Filter,
  Trash2,
  Calendar,
  FileSpreadsheet,
  FileText,
  Tag,
} from 'lucide-react';
import { db } from '@/db';
import type { ErrorRow, ExportRecord } from '@/types';
import { useAppStore } from '@/stores/appStore';
import { buildAndExportErrorsCsv, downloadBlob } from '@/services/exporter';
import { cn, formatBytes, formatDateTime, getErrorTypeLabel } from '@/utils';

type Tab = 'errors' | 'exports';

function ErrorStat({ label, value, color }: { label: string; value: number; color: 'fault' | 'orange' | 'yellow' | 'cyan' }) {
  const colorMap: Record<string, string> = {
    fault: 'text-fault-400',
    orange: 'text-alert-400',
    yellow: 'text-history-400',
    cyan: 'text-signal-400',
  };
  return (
    <div className="card-border rounded-sm p-4">
      <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">{label}</div>
      <div className={cn('font-display text-2xl', colorMap[color])}>{value}</div>
    </div>
  );
}

export function Reports() {
  const activeConfig = useAppStore((s) => s.activeConfig);
  const showToast = useAppStore((s) => s.showToast);
  const [tab, setTab] = useState<Tab>('errors');
  const [errors, setErrors] = useState<ErrorRow[]>([]);
  const [exports, setExports] = useState<ExportRecord[]>([]);
  const [filterType, setFilterType] = useState<string>('ALL');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [errs, exps] = await Promise.all([
      db.errorRows.orderBy('createdAt').reverse().toArray(),
      db.exportRecords.orderBy('createdAt').reverse().toArray(),
    ]);
    setErrors(errs);
    setExports(exps);
  };
  useEffect(() => { void load(); }, [activeConfig?.id]);

  const filteredErrors = errors.filter((e) => filterType === 'ALL' || e.errorType === filterType);

  const handleExportErrors = async () => {
    setBusy(true);
    try {
      const csv = await buildAndExportErrorsCsv(activeConfig?.id || 'v1');
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
      const name = `error-report-${Date.now()}.csv`;
      downloadBlob(blob, name);
      showToast('success', `错误报告已导出：${name}`);
    } catch (e) {
      showToast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadExport = async (rec: ExportRecord) => {
    try {
      downloadBlob(rec.fileContent, rec.fileName);
      showToast('info', `正在重新下载：${rec.fileName}`);
    } catch (e) {
      showToast('error', (e as Error).message);
    }
  };

  const handleDeleteExport = async (id: string) => {
    if (!confirm('删除该导出记录？（不会影响本地已下载文件）')) return;
    try {
      await db.exportRecords.delete(id);
      showToast('success', '导出记录已删除');
      void load();
    } catch (e) {
      showToast('error', (e as Error).message);
    }
  };

  const errorTypeStats = errors.reduce<Record<string, number>>((acc, e) => {
    acc[e.errorType] = (acc[e.errorType] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="p-6 space-y-5 min-h-screen deep-dot-grid">
      <header>
        <div className="flex items-center gap-2 mb-2">
          <div className="h-5 w-1 bg-signal-400" />
          <h1 className="font-display text-xl text-signal-400 tracking-wider glow-text">报告中心</h1>
        </div>
        <p className="text-sm text-slate-400">
          错误行报告 · 历史导出记录（均携带筛选条件元数据，可复核复现）
        </p>
      </header>

      <div className="card-border rounded-sm overflow-hidden">
        <div className="flex border-b border-signal-400/15 bg-deep-800/40">
          {([['errors', AlertTriangle, '错误行报告', errors.length, 'fault'],
             ['exports', History, '历史导出记录', exports.length, 'cyan']] as const).map(
            ([key, Icon, label, count, color]) => (
            <button
              key={key}
              onClick={() => setTab(key as Tab)}
              className={cn(
                'flex items-center gap-2 px-5 py-3 text-sm relative',
                tab === key ? 'text-signal-400 bg-signal-400/5' : 'text-slate-500 hover:text-signal-300',
              )}
            >
              <Icon size={14} />
              {label}
              <span className={cn(
                'ml-1 text-[10px] px-1.5 py-0.5 rounded-sm border',
                color === 'fault'
                  ? 'bg-fault-400/15 text-fault-400 border-fault-400/30'
                  : 'bg-signal-400/15 text-signal-400 border-signal-400/30',
              )}>
                {count}
              </span>
              {tab === key && <div className="absolute bottom-0 left-3 right-3 h-0.5 bg-signal-400" />}
            </button>
          ))}
        </div>

        <div className="p-6">
          {tab === 'errors' && (
            <div className="space-y-5">
              <div className="grid grid-cols-4 gap-4">
                <ErrorStat label="错误总数" value={errors.length} color="fault" />
                <ErrorStat label="字段缺失" value={errorTypeStats.MISSING_FIELD || 0} color="orange" />
                <ErrorStat label="时间倒置" value={errorTypeStats.TIME_INVERSION || 0} color="yellow" />
                <ErrorStat label="解析错误" value={errorTypeStats.PARSE_ERROR || 0} color="cyan" />
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Filter size={13} className="text-signal-400" />
                  <span className="text-[11px] uppercase tracking-widest text-slate-500">错误类型</span>
                  {(['ALL', 'MISSING_FIELD', 'TIME_INVERSION', 'PARSE_ERROR'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setFilterType(t)}
                      className={cn(
                        'px-2 py-0.5 text-[11px] rounded-sm border transition-all',
                        filterType === t
                          ? 'bg-signal-400/15 border-signal-400/50 text-signal-400'
                          : 'border-signal-400/15 text-slate-500 hover:text-signal-300',
                      )}
                    >
                      {t === 'ALL' ? '全部' : getErrorTypeLabel(t)}
                    </button>
                  ))}
                </div>
                <button onClick={handleExportErrors} disabled={busy || errors.length === 0}
                  className="btn-primary text-xs flex items-center gap-1.5">
                  <Download size={12} /> {busy ? '导出中...' : '导出错误报告 CSV'}
                </button>
              </div>

              <div className="overflow-x-auto scroll-slim card-border rounded-sm">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-signal-400/20 bg-deep-800/60 text-left">
                      <th className="py-2.5 px-3 text-[10px] uppercase tracking-widest text-slate-500 w-10">#</th>
                      <th className="py-2.5 px-3 text-[10px] uppercase tracking-widest text-slate-500">错误类型</th>
                      <th className="py-2.5 px-3 text-[10px] uppercase tracking-widest text-slate-500">来源文件</th>
                      <th className="py-2.5 px-3 text-[10px] uppercase tracking-widest text-slate-500">行号</th>
                      <th className="py-2.5 px-3 text-[10px] uppercase tracking-widest text-slate-500">错误描述</th>
                      <th className="py-2.5 px-3 text-[10px] uppercase tracking-widest text-slate-500">批次</th>
                      <th className="py-2.5 px-3 text-[10px] uppercase tracking-widest text-slate-500">时间</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredErrors.length === 0 ? (
                      <tr><td colSpan={7} className="py-10 text-center text-slate-600">暂无错误记录</td></tr>
                    ) : filteredErrors.slice(0, 500).map((e, i) => (
                      <tr key={e.id} className={cn(
                        'border-b border-signal-400/5 hover:bg-signal-400/5',
                        i % 2 && 'bg-deep-800/20',
                      )}>
                        <td className="py-2 px-3 text-[11px] text-slate-600">{i + 1}</td>
                        <td className="py-2 px-3">
                          <span className={cn(
                            'text-[11px] px-2 py-0.5 rounded-sm',
                            e.errorType === 'MISSING_FIELD' && 'bg-alert-400/10 text-alert-400 border border-alert-400/30',
                            e.errorType === 'TIME_INVERSION' && 'bg-history-400/10 text-history-400 border border-history-400/30',
                            e.errorType === 'PARSE_ERROR' && 'bg-fault-400/10 text-fault-400 border border-fault-400/30',
                          )}>
                            {getErrorTypeLabel(e.errorType)}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-[11px] font-mono text-slate-400 max-w-[200px] truncate" title={e.sourceFile}>{e.sourceFile}</td>
                        <td className="py-2 px-3 text-[11px] text-slate-500 font-mono">L{e.lineNumber}</td>
                        <td className="py-2 px-3 text-[11px] text-slate-400 max-w-[400px] truncate" title={e.errorMessage}>{e.errorMessage}</td>
                        <td className="py-2 px-3 text-[10px] text-slate-600 font-mono">{e.importBatchId.slice(-8)}</td>
                        <td className="py-2 px-3 text-[11px] text-slate-500 font-mono whitespace-nowrap">{formatDateTime(e.createdAt).slice(5)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredErrors.length > 500 && (
                  <div className="px-3 py-2 text-center text-[11px] text-slate-600 border-t border-signal-400/10">
                    仅显示前 500 条，完整内容请导出 CSV 查看
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'exports' && (
            <div className="space-y-3">
              {exports.length === 0 ? (
                <div className="text-center py-16 text-slate-600">
                  <FileSpreadsheet size={32} className="mx-auto mb-3 opacity-40" />
                  <div className="text-sm">暂无导出记录</div>
                  <div className="text-[11px] mt-1">进入断报分析页点击"导出报告"，记录会保存在此处</div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {exports.map((rec) => (
                    <div key={rec.id} className="card-border rounded-sm p-4 fade-in hover:border-signal-400/30 transition-colors">
                      <div className="flex items-start gap-3">
                        <div className={cn(
                          'w-10 h-10 rounded-sm flex items-center justify-center shrink-0',
                          rec.fileType === 'HTML'
                            ? 'bg-signal-400/15 border border-signal-400/30 text-signal-400'
                            : 'bg-alert-400/15 border border-alert-400/30 text-alert-400',
                        )}>
                          {rec.fileType === 'HTML' ? <FileText size={16} /> : <FileSpreadsheet size={16} />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-mono text-sm text-signal-300 truncate" title={rec.fileName}>{rec.fileName}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-3 flex-wrap">
                            <span className="flex items-center gap-1"><Calendar size={10} />{formatDateTime(rec.createdAt).slice(5, 16)}</span>
                            <span>配置 {rec.configVersion.toUpperCase()}</span>
                            <span>{rec.summary.totalIntervals} 条</span>
                          </div>
                          <div className="mt-2 pt-2 border-t border-signal-400/10 space-y-1">
                            <div className="text-[10px] uppercase tracking-widest text-slate-600 mb-1">筛选快照</div>
                            {rec.filterSnapshot.timeRange && (
                              <div className="text-[10px] text-slate-500 flex items-center gap-1">
                                <Calendar size={9} /> {formatDateTime(rec.filterSnapshot.timeRange[0]).slice(5,11)} ~ {formatDateTime(rec.filterSnapshot.timeRange[1]).slice(5,11)}
                              </div>
                            )}
                            {rec.filterSnapshot.siteGroupIds.length > 0 && (
                              <div className="text-[10px] text-slate-500 flex items-center gap-1 flex-wrap">
                                <Tag size={9} /> 分组: {rec.filterSnapshot.siteGroupIds.join(', ')}
                              </div>
                            )}
                            <div className="text-[10px] text-slate-500">
                              标注: {rec.filterSnapshot.annotationStatus} · 异常: {rec.filterSnapshot.anomalyTypeCodes.length ? rec.filterSnapshot.anomalyTypeCodes.join(',') : '全部'}
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-col gap-1.5 shrink-0">
                          <button onClick={() => handleDownloadExport(rec)}
                            className="btn-ghost text-[11px] px-2 py-1 flex items-center gap-1">
                            <Download size={11} /> 重下
                          </button>
                          <button onClick={() => handleDeleteExport(rec.id)}
                            className="text-[11px] px-2 py-1 rounded-sm text-slate-500 hover:text-fault-400 hover:bg-fault-400/10 border border-transparent hover:border-fault-400/30 flex items-center gap-1">
                            <Trash2 size={11} /> 删除
                          </button>
                        </div>
                      </div>
                      <div className="text-[10px] text-slate-600 mt-2 pt-2 border-t border-signal-400/5 font-mono truncate">
                        文件大小: {formatBytes(rec.fileContent.size)} · ID {rec.id.slice(-10)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
