import { useEffect, useState } from 'react';
import {
  Database,
  FileWarning,
  AlertCircle,
  BarChart2,
  CheckSquare,
  Zap,
  Sparkles,
  ArrowRight,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { StatCard } from '@/components/StatCard';
import { FileDropZone } from '@/components/FileDropZone';
import { useAppStore } from '@/stores/appStore';
import { db } from '@/db';
import { runAnalysis } from '@/services/analyzer';
import { generateSampleCsv, injectSampleIntoDB } from '@/sample/generator';
import type { DashboardStats, ImportStats } from '@/types';
import { formatDateTime } from '@/utils';
import { clearAllData } from '@/services/parser';

export function Dashboard() {
  const [stats, setStats] = useState<DashboardStats>({
    totalFiles: 0,
    totalLogs: 0,
    totalOutages: 0,
    totalErrors: 0,
    annotationRate: 0,
  });
  const [busy, setBusy] = useState(false);
  const [sampleInfo, setSampleInfo] = useState<{ part1: string; part2: string } | null>(null);
  const activeConfig = useAppStore((s) => s.activeConfig);
  const lastImport = useAppStore((s) => s.lastImport);
  const showToast = useAppStore((s) => s.showToast);
  const reloadConfigs = useAppStore((s) => s.reloadConfigs);

  const refresh = async () => {
    if (!activeConfig) return;
    const [logs, errors, outages, anns] = await Promise.all([
      db.telemetryLogs.count(),
      db.errorRows.count(),
      db.outageIntervals.where('configVersion').equals(activeConfig.id).count(),
      db.annotations
        .filter((a) => a.configVersion === activeConfig.id && a.isCurrent)
        .count(),
    ]);
    const files = new Set((await db.telemetryLogs.orderBy('sourceFile').keys())).size;
    setStats({
      totalFiles: files,
      totalLogs: logs,
      totalOutages: outages,
      totalErrors: errors,
      annotationRate: outages > 0 ? Math.round((anns / outages) * 1000) / 10 : 0,
    });
  };

  useEffect(() => {
    void refresh();
  }, [activeConfig, lastImport]);

  const handleGenSample = async () => {
    setBusy(true);
    try {
      const sample = generateSampleCsv({ days: 3, intervalMinutes: 5 });
      setSampleInfo({ part1: sample.csvPart1, part2: sample.csvPart2 });
      const res = await injectSampleIntoDB(sample);
      await reloadConfigs();
      const cfg = (await useAppStore.getState().activeConfig)!;
      await runAnalysis(cfg, true);
      showToast(
        'success',
        `样例数据导入完成：新增 ${res.logsAfter - res.logsBefore} 条日志（含 ${sample.totalOutages} 处人工断报、2 份文件重复记录）`,
      );
      void refresh();
    } catch (e) {
      showToast('error', `生成失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const downloadPart = (which: 1 | 2) => {
    if (!sampleInfo) return;
    const blob = new Blob([which === 1 ? sampleInfo.part1 : sampleInfo.part2], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `telemetry_sample_part${which}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleRecompute = async () => {
    if (!activeConfig) return;
    setBusy(true);
    try {
      const r = await runAnalysis(activeConfig, true);
      showToast('success', `重新计算完成，识别 ${r.totalProcessed} 个断报区间`);
      void refresh();
    } catch (e) {
      showToast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    if (!confirm('确定清空所有日志、断报、标注记录吗？此操作不可恢复。')) return;
    setBusy(true);
    try {
      await clearAllData();
      showToast('success', '数据已清空');
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6 p-6 deep-dot-grid min-h-screen">
      <header className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="h-5 w-1 bg-signal-400 rounded-sm" />
            <h1 className="font-display text-xl text-signal-400 tracking-wider glow-text">
              仪表盘
            </h1>
          </div>
          <p className="text-sm text-slate-400">
            导入遥测日志、快速预览分析状态、一键生成样例数据体验全流程
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/analysis" className="btn-primary flex items-center gap-2">
            <BarChart2 size={14} /> 进入分析
            <ArrowRight size={14} />
          </Link>
        </div>
      </header>

      <section className="grid grid-cols-stats gap-4">
        <StatCard
          label="导入日志文件"
          value={stats.totalFiles}
          icon={Database}
          accent="cyan"
          sub={activeConfig ? `当前配置 ${activeConfig.id.toUpperCase()}` : ''}
        />
        <StatCard
          label="有效遥测记录"
          value={stats.totalLogs}
          icon={CheckSquare}
          accent="green"
          sub={lastImport ? `最近导入: ${formatDateTime(lastImport.createdAt).slice(5)}` : '等待导入'}
        />
        <StatCard
          label="断报区间数"
          value={stats.totalOutages}
          icon={AlertCircle}
          accent="orange"
          sub={`阈值 ${activeConfig?.thresholdMinutes || 30} 分钟`}
        />
        <StatCard
          label="错误行（报告）"
          value={stats.totalErrors}
          icon={FileWarning}
          accent="red"
          sub={stats.totalErrors > 0 ? '可在报告中心查看' : '未发现异常行'}
        />
        <StatCard
          label="标注完成率"
          value={`${stats.annotationRate}%`}
          icon={BarChart2}
          accent="yellow"
          sub="标注/总断报 × 100%"
        />
      </section>

      <section className="grid grid-cols-5 gap-5">
        <div className="col-span-3">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-4 w-1 bg-alert-400 rounded-sm" />
              <h2 className="font-display text-signal-400 tracking-wider text-sm">
                遥测日志导入
              </h2>
            </div>
          </div>
          <FileDropZone onImportDone={() => void refresh()} />
          {lastImport && <ImportSummaryCard stats={lastImport} />}
        </div>
        <div className="col-span-2 space-y-4">
          <div className="card-border rounded-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Sparkles size={16} className="text-history-400" />
                <h2 className="font-display text-sm tracking-wider text-signal-400">
                  快速体验 · 样例数据
                </h2>
              </div>
            </div>
            <div className="text-[12px] text-slate-400 leading-relaxed mb-4">
              一键生成 3 天的 6 个站点遥测日志，自动拆分为{' '}
              <span className="text-signal-400">两份 CSV 文件</span>，包含：
              <ul className="mt-2 space-y-1 pl-4 list-disc">
                <li>故意写入 <span className="text-history-400">重复记录</span>（测试去重）</li>
                <li>多处 <span className="text-alert-400">大间隔断报</span>（{'>'} 30 分钟阈值）</li>
                <li>
                  <span className="text-fault-400">字段缺失行</span> 与{' '}
                  <span className="text-fault-400">时间倒置行</span>（进入错误报告）
                </li>
              </ul>
            </div>
            <div className="space-y-2">
              <button
                disabled={busy}
                onClick={handleGenSample}
                className="btn-primary w-full flex items-center justify-center gap-2"
              >
                <Zap size={14} />
                {busy ? '处理中...' : '生成并导入样例数据'}
              </button>
              {sampleInfo && (
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    onClick={() => downloadPart(1)}
                    className="btn-ghost text-xs py-1.5 flex items-center justify-center gap-1.5"
                  >
                    <Database size={12} /> 下载 part1.csv
                  </button>
                  <button
                    onClick={() => downloadPart(2)}
                    className="btn-ghost text-xs py-1.5 flex items-center justify-center gap-1.5"
                  >
                    <Database size={12} /> 下载 part2.csv
                  </button>
                </div>
              )}
              <div className="text-[10px] text-slate-600 text-center pt-1">
                验收提示：下载两份 CSV 后手动导入，验证重复记录被正确识别
              </div>
            </div>
          </div>

          <div className="card-border rounded-sm p-5 space-y-3">
            <div className="flex items-center gap-2">
              <RefreshCw size={16} className="text-signal-400" />
              <h2 className="font-display text-sm tracking-wider text-signal-400">
                分析操作
              </h2>
            </div>
            <button
              onClick={handleRecompute}
              disabled={busy || !activeConfig}
              className="btn-ghost w-full flex items-center justify-center gap-2"
            >
              <RefreshCw size={13} /> 按当前阈值重新计算断报
            </button>
            <button
              onClick={handleClear}
              disabled={busy}
              className="btn-danger w-full flex items-center justify-center gap-2"
            >
              <Trash2 size={13} /> 清空所有日志与标注
            </button>
            <div className="text-[10px] text-slate-600 pt-1 leading-relaxed">
              * 修改阈值后需"重新计算"，旧标注将按配置版本保留为历史记录，不会丢失。
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function ImportSummaryCard({ stats }: { stats: ImportStats }) {
  return (
    <div className="mt-3 card-border rounded-sm p-4 bg-deep-800/40 fade-in">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-widest text-slate-500">
          本次导入摘要 · 批次 {stats.batchId.slice(-6)}
        </div>
        <div className="text-[10px] text-slate-600">{formatDateTime(stats.createdAt)}</div>
      </div>
      <div className="grid grid-cols-4 gap-3 text-sm">
        <div>
          <div className="text-[10px] text-slate-500">总行数</div>
          <div className="font-display text-signal-400">{stats.totalRows}</div>
        </div>
        <div>
          <div className="text-[10px] text-slate-500">新增入库</div>
          <div className="font-display text-success-400">{stats.insertedRows}</div>
        </div>
        <div>
          <div className="text-[10px] text-slate-500">去重</div>
          <div className="font-display text-history-400">{stats.duplicateRows}</div>
        </div>
        <div>
          <div className="text-[10px] text-slate-500">错误行</div>
          <div className="font-display text-fault-400">{stats.errorRows}</div>
        </div>
      </div>
      <div className="mt-2 text-[10px] text-slate-600 truncate">
        文件: {stats.sourceFiles.join(', ')}
      </div>
    </div>
  );
}
