import { useEffect, useState } from 'react';
import { X, Tag, Clock, MapPin, AlertTriangle, History, Check, Save } from 'lucide-react';
import type { Annotation, ConfigVersion, IntervalWithAnnotation } from '@/types';
import { REASON_OPTIONS } from '@/types';
import { formatDateTime, formatDuration, cn } from '@/utils';
import { saveAnnotation, getAnnotationHistory, updateIntervalAnomalyType } from '@/services/annotation';
import { useAppStore } from '@/stores/appStore';

interface Props {
  open: boolean;
  interval: IntervalWithAnnotation | null;
  config: ConfigVersion;
  onClose: () => void;
  onSaved: () => void;
}

export function AnnotationModal({ open, interval, config, onClose, onSaved }: Props) {
  const [reasonCode, setReasonCode] = useState<string>('');
  const [reasonText, setReasonText] = useState('');
  const [remark, setRemark] = useState('');
  const [anomalyType, setAnomalyType] = useState<string>('');
  const [history, setHistory] = useState<Annotation[]>([]);
  const [saving, setSaving] = useState(false);
  const showToast = useAppStore((s) => s.showToast);

  useEffect(() => {
    if (!open || !interval) return;
    const existing = interval.annotation;
    setReasonCode(existing?.reasonCode || '');
    setReasonText(existing?.reasonText || '');
    setRemark(existing?.remark || '');
    setAnomalyType(interval.anomalyTypeCode);
    void getAnnotationHistory(interval.id).then(setHistory);
  }, [open, interval]);

  if (!open || !interval) return null;

  const anomalyObj = config.anomalyTypes.find((t) => t.code === anomalyType);
  const groupObj = config.siteGroups.find((g) => g.id === interval.siteGroupId);

  const handleSave = async () => {
    if (!reasonCode.trim() || !reasonText.trim()) {
      showToast('error', '请选择原因并填写原因描述');
      return;
    }
    setSaving(true);
    try {
      if (anomalyType !== interval.anomalyTypeCode) {
        await updateIntervalAnomalyType(interval.id, anomalyType);
      }
      await saveAnnotation(
        { ...interval, anomalyTypeCode: anomalyType },
        { reasonCode, reasonText, remark },
      );
      showToast('success', '标注已保存，已记录到历史');
      onSaved();
      onClose();
    } catch (e) {
      showToast('error', `保存失败: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const pickReason = (code: string, label: string) => {
    setReasonCode(code);
    setReasonText(label);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 fade-in">
      <div
        className="absolute inset-0 bg-deep-950/85 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-5xl max-h-[92vh] overflow-hidden rounded-sm card-border shadow-card flex flex-col slide-in-right">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-signal-400/15">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle size={16} className="text-alert-400" />
              <span className="font-display text-signal-400 tracking-wider text-sm">
                断报区间标注
              </span>
            </div>
            <div className="text-[11px] text-slate-500 font-mono">
              区间ID: {interval.id.slice(0, 24)}... · 配置版本 {config.id.toUpperCase()}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-sm hover:bg-signal-400/10 flex items-center justify-center text-slate-400 hover:text-signal-400"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto scroll-slim">
          <div className="grid grid-cols-5 min-h-0">
            {/* 左：详情 + 标注表单 */}
            <div className="col-span-3 p-6 border-r border-signal-400/10 space-y-5">
              {/* 详情卡片 */}
              <div className="bg-deep-800/40 rounded-sm border border-signal-400/10 p-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-500 mb-1">
                      <MapPin size={11} /> 站点
                    </div>
                    <div className="font-mono text-signal-400">{interval.siteId}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      分组: {groupObj?.name || '未分组'}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-500 mb-1">
                      <Tag size={11} /> 异常类型
                    </div>
                    <select
                      value={anomalyType}
                      onChange={(e) => setAnomalyType(e.target.value)}
                      className="input-base w-full"
                      style={{ borderColor: anomalyObj?.color + '55' }}
                    >
                      {config.anomalyTypes.map((t) => (
                        <option key={t.code} value={t.code}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-500 mb-1">
                      <Clock size={11} /> 开始时间
                    </div>
                    <div className="font-mono text-[12px]">{formatDateTime(interval.startTime)}</div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-500 mb-1">
                      <Clock size={11} /> 结束时间
                    </div>
                    <div className="font-mono text-[12px]">{formatDateTime(interval.endTime)}</div>
                  </div>
                  <div className="col-span-2">
                    <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">
                      持续时长
                    </div>
                    <div className="text-alert-400 font-display text-2xl">
                      {formatDuration(interval.durationMinutes)}
                    </div>
                  </div>
                </div>
              </div>

              {/* 标注表单 */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Check size={14} className="text-success-400" />
                  <span className="font-display text-signal-400 text-sm tracking-wider">
                    标注原因
                  </span>
                </div>

                <div className="mb-3">
                  <div className="text-[11px] text-slate-500 mb-1.5">快捷选择</div>
                  <div className="flex flex-wrap gap-2">
                    {REASON_OPTIONS.map((r) => (
                      <button
                        key={r.code}
                        onClick={() => pickReason(r.code, r.label)}
                        className={cn(
                          'px-3 py-1.5 text-xs rounded-sm border transition-all',
                          reasonCode === r.code
                            ? 'bg-signal-400/20 border-signal-400 text-signal-400 shadow-glow-signal'
                            : 'bg-deep-800/50 border-signal-400/15 text-slate-400 hover:text-signal-300 hover:border-signal-400/40',
                        )}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <div className="text-[11px] text-slate-500 mb-1.5">原因代码</div>
                    <input
                      className="input-base w-full"
                      placeholder="如 POWER_OUTAGE"
                      value={reasonCode}
                      onChange={(e) => setReasonCode(e.target.value)}
                    />
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-500 mb-1.5">原因描述</div>
                    <input
                      className="input-base w-full"
                      placeholder="如 站点电源中断"
                      value={reasonText}
                      onChange={(e) => setReasonText(e.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <div className="text-[11px] text-slate-500 mb-1.5">备注（可选）</div>
                  <textarea
                    className="input-base w-full min-h-[84px] resize-y"
                    placeholder="详细说明现场情况、处理过程等..."
                    value={remark}
                    onChange={(e) => setRemark(e.target.value)}
                  />
                </div>
              </div>
            </div>

            {/* 右：历史版本标注 */}
            <div className="col-span-2 p-6 bg-deep-900/40">
              <div className="flex items-center gap-2 mb-3">
                <History size={14} className="text-history-400" />
                <span className="font-display text-history-400 text-sm tracking-wider">
                  标注历史
                </span>
                <span className="text-[10px] text-slate-600 ml-auto">{history.length} 条记录</span>
              </div>
              <div className="space-y-2.5 max-h-[500px] overflow-y-auto scroll-slim pr-1">
                {history.length === 0 ? (
                  <div className="text-center py-10 text-slate-600 text-xs">
                    暂无历史标注记录
                  </div>
                ) : (
                  history.map((h, idx) => (
                    <div
                      key={h.id}
                      className={cn(
                        'rounded-sm border p-3 transition-all',
                        h.isCurrent
                          ? 'border-success-400/40 bg-success-400/5'
                          : 'border-signal-400/10 bg-deep-800/40 opacity-70',
                      )}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-1.5">
                          {h.isCurrent ? (
                            <span className="text-[10px] text-success-400 flex items-center gap-1">
                              <Check size={10} /> 当前标注
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-500">
                              配置 {h.configVersion.toUpperCase()}
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-slate-600 font-mono">
                          {formatDateTime(h.annotatedAt).slice(5)}
                        </span>
                      </div>
                      <div className="text-sm text-signal-300">{h.reasonText}</div>
                      {h.remark && (
                        <div className="text-[11px] text-slate-500 mt-1.5 leading-relaxed">
                          {h.remark}
                        </div>
                      )}
                      <div className="text-[10px] text-slate-600 mt-2 font-mono">
                        [{h.reasonCode}] · {h.annotatedBy} · #{idx + 1}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 底部 */}
        <div className="flex items-center justify-end gap-3 px-6 py-3 border-t border-signal-400/15 bg-deep-900/60">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            className="btn-primary flex items-center gap-2"
            onClick={handleSave}
            disabled={saving}
          >
            <Save size={14} />
            {saving ? '保存中...' : '保存标注'}
          </button>
        </div>
      </div>
    </div>
  );
}
