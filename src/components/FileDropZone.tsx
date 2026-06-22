import { useCallback, useRef, useState } from 'react';
import { UploadCloud, FileText, AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react';
import type { ImportStats } from '@/types';
import type { ParserProgress } from '@/services/parser';
import { importFiles } from '@/services/parser';
import { useAppStore } from '@/stores/appStore';
import { runAnalysis } from '@/services/analyzer';
import { cn } from '@/utils';

interface FileState {
  name: string;
  size: number;
  progress: number;
  status: 'pending' | 'parsing' | 'done' | 'error';
  errors: number;
  duplicates: number;
}

interface Props {
  onImportDone?: (stats: ImportStats) => void;
}

export function FileDropZone({ onImportDone }: Props) {
  const [dragging, setDragging] = useState(false);
  const [files, setFiles] = useState<FileState[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeConfig = useAppStore((s) => s.activeConfig);
  const showToast = useAppStore((s) => s.showToast);
  const setLastImport = useAppStore((s) => s.setLastImport);
  const reloadConfigs = useAppStore((s) => s.reloadConfigs);

  const updateFile = (name: string, patch: Partial<FileState>) => {
    setFiles((prev) => prev.map((f) => (f.name === name ? { ...f, ...patch } : f)));
  };

  const addFiles = useCallback(
    async (list: FileList | File[]) => {
      const arr = Array.from(list).filter((f) => f.name.endsWith('.csv'));
      if (arr.length === 0) {
        showToast('error', '请选择 CSV 格式的遥测日志文件');
        return;
      }
      if (!activeConfig) {
        showToast('error', '尚未加载配置，请先完成初始化');
        return;
      }
      setBusy(true);
      const states: FileState[] = arr.map((f) => ({
        name: f.name,
        size: f.size,
        progress: 0,
        status: 'parsing',
        errors: 0,
        duplicates: 0,
      }));
      setFiles((prev) => [...prev.filter((x) => x.status !== 'done'), ...states]);

      try {
        await reloadConfigs();
        const cfg = (await useAppStore.getState().activeConfig) || activeConfig;
        const stats = await importFiles(arr, cfg, (p: ParserProgress) => {
          updateFile(p.fileName, {
            progress: p.total ? Math.round((p.current / p.total) * 100) : 0,
            errors: p.errors,
            duplicates: p.duplicates,
          });
        });
        arr.forEach((f) => updateFile(f.name, { status: 'done', progress: 100 }));
        showToast(
          'success',
          `导入完成：新增 ${stats.insertedRows} 条，去重 ${stats.duplicateRows}，错误 ${stats.errorRows}`,
        );
        setLastImport(stats);

        // 重新分析当前配置版本的断报
        void runAnalysis(cfg, true).then((r) => {
          showToast(
            r.recomputed ? 'info' : 'success',
            `断报分析完成：识别 ${r.totalProcessed} 个断报区间`,
          );
        });

        onImportDone?.(stats);
      } catch (e) {
        arr.forEach((f) => updateFile(f.name, { status: 'error' }));
        showToast('error', `导入失败：${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
    },
    [activeConfig, onImportDone, reloadConfigs, setLastImport, showToast],
  );

  const clearDone = () => setFiles((p) => p.filter((f) => f.status !== 'done'));

  return (
    <div className="card-border rounded-sm p-5">
      <div
        className={cn(
          'relative border-2 border-dashed rounded-sm py-10 px-6 text-center transition-all',
          dragging
            ? 'border-signal-400 bg-signal-400/5 shadow-glow-signal'
            : 'border-signal-400/20 hover:border-signal-400/40',
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files) void addFiles(e.dataTransfer.files);
        }}
      >
        <div className="mx-auto w-12 h-12 rounded-full bg-signal-400/10 border border-signal-400/30 flex items-center justify-center mb-3">
          <UploadCloud className="text-signal-400" size={22} strokeWidth={1.6} />
        </div>
        <div className="text-signal-300 font-display text-sm tracking-wide mb-1">
          拖拽 CSV 遥测日志到此处，或
          <button
            className="ml-1 text-signal-400 underline underline-offset-4 hover:glow-text"
            onClick={() => inputRef.current?.click()}
          >
            点击选择文件
          </button>
        </div>
        <div className="text-[11px] text-slate-500 mt-1">
          必填字段：siteId、timestamp · 多文件批量导入，自动去重和错误隔离
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".csv"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {files.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">
              导入进度（{files.length} 个文件）
            </span>
            <button className="text-slate-500 hover:text-signal-400" onClick={clearDone}>
              清空已完成
            </button>
          </div>
          {files.map((f) => (
            <div
              key={f.name}
              className="bg-deep-800/40 border border-signal-400/10 rounded-sm p-2.5 flex items-center gap-3"
            >
              {f.status === 'done' ? (
                <CheckCircle2 size={16} className="text-success-400 shrink-0" />
              ) : f.status === 'error' ? (
                <AlertTriangle size={16} className="text-fault-400 shrink-0" />
              ) : (
                <Loader2 size={16} className="text-signal-400 shrink-0 animate-spin" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <FileText size={13} className="text-slate-500" />
                  <span className="text-sm truncate">{f.name}</span>
                  <span className="text-[10px] text-slate-500">
                    {(f.size / 1024).toFixed(1)} KB
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="flex-1 h-1 bg-deep-900 rounded-sm overflow-hidden">
                    <div
                      className={cn(
                        'h-full transition-all',
                        f.status === 'error' ? 'bg-fault-400' : 'bg-signal-400',
                      )}
                      style={{ width: `${f.progress}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-slate-500 w-8 text-right">
                    {f.progress}%
                  </span>
                </div>
                {(f.errors > 0 || f.duplicates > 0) && (
                  <div className="mt-1 flex gap-3 text-[10px]">
                    {f.duplicates > 0 && (
                      <span className="text-history-400">重复 {f.duplicates}</span>
                    )}
                    {f.errors > 0 && (
                      <span className="text-fault-400">错误 {f.errors}</span>
                    )}
                  </div>
                )}
              </div>
              {busy && (
                <X
                  size={14}
                  className="text-slate-600 hover:text-slate-400 cursor-pointer shrink-0"
                  onClick={() => setFiles((p) => p.filter((x) => x.name !== f.name))}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
