import { useEffect, useState } from 'react';
import { Settings, Save, Plus, X, Trash2, GripVertical, Tag, Palette, Clock, RefreshCw, Copy, ChevronRight } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AnomalyType, ConfigVersion, SiteGroup } from '@/types';
import { db } from '@/db';
import { runAnalysis } from '@/services/analyzer';
import { cn, uid } from '@/utils';

type Tab = 'threshold' | 'groups' | 'types' | 'versions';

export function Config() {
  const configs = useAppStore((s) => s.configs);
  const activeConfig = useAppStore((s) => s.activeConfig);
  const reloadConfigs = useAppStore((s) => s.reloadConfigs);
  const setActiveConfig = useAppStore((s) => s.setActiveConfig);
  const showToast = useAppStore((s) => s.showToast);
  const setFilter = useAppStore((s) => s.setFilter);

  const [tab, setTab] = useState<Tab>('threshold');
  const [draft, setDraft] = useState<ConfigVersion | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (activeConfig) {
      setDraft(JSON.parse(JSON.stringify(activeConfig)));
      setDirty(false);
    }
  }, [activeConfig?.id]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  if (!draft || !activeConfig) {
    return <div className="p-10 text-slate-500 text-center">加载中...</div>;
  }

  const markDirty = () => setDirty(true);

  const handlePublishNewVersion = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const nextIdNum = (await db.configVersions.count()) + 1;
      const newCfg: ConfigVersion = {
        ...draft,
        id: `v${nextIdNum}`,
        createdAt: Date.now(),
        isActive: true,
        name: draft.name === activeConfig.name ? `${draft.id}→v${nextIdNum}` : draft.name,
      };
      await db.transaction('rw', db.configVersions, async () => {
        await db.configVersions.toCollection().modify({ isActive: false });
        await db.configVersions.add(newCfg);
      });
      await reloadConfigs();
      setFilter({ configVersion: newCfg.id });
      // 自动重新计算新配置的断报
      const r = await runAnalysis(newCfg, true);
      setDirty(false);
      showToast(
        'success',
        `配置 v${nextIdNum} 已发布为当前版本，重新识别 ${r.totalProcessed} 个断报区间（旧标注保留为历史）`,
      );
    } catch (e) {
      showToast('error', `发布失败: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const addGroup = () => {
    setDraft({
      ...draft!,
      siteGroups: [
        ...draft!.siteGroups,
        { id: uid('grp'), name: `新分组 ${draft!.siteGroups.length + 1}`, siteIds: [] },
      ],
    });
    markDirty();
  };

  const updateGroup = (id: string, patch: Partial<SiteGroup>) => {
    setDraft({
      ...draft!,
      siteGroups: draft!.siteGroups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    });
    markDirty();
  };

  const removeGroup = (id: string) => {
    setDraft({ ...draft!, siteGroups: draft!.siteGroups.filter((g) => g.id !== id) });
    markDirty();
  };

  const addType = () => {
    setDraft({
      ...draft!,
      anomalyTypes: [
        ...draft!.anomalyTypes,
        {
          code: `TYPE_${(draft!.anomalyTypes.length + 1).toString().padStart(2, '0')}`,
          name: '新异常类型',
          color: '#00D4FF',
          defaultReason: '',
        },
      ],
    });
    markDirty();
  };

  const updateType = (code: string, patch: Partial<AnomalyType>) => {
    setDraft({
      ...draft!,
      anomalyTypes: draft!.anomalyTypes.map((t) => (t.code === code ? { ...t, ...patch } : t)),
    });
    markDirty();
  };

  const removeType = (code: string) => {
    setDraft({ ...draft!, anomalyTypes: draft!.anomalyTypes.filter((t) => t.code !== code) });
    markDirty();
  };

  const switchToVersion = async (id: string) => {
    setBusy(true);
    try {
      await setActiveConfig(id);
      setFilter({ configVersion: id });
      showToast('success', `已切换到配置 ${id.toUpperCase()}`);
    } finally {
      setBusy(false);
    }
  };

  const cloneActiveToDraft = () => {
    if (!activeConfig) return;
    setDraft({
      ...JSON.parse(JSON.stringify(activeConfig)),
      id: draft!.id,
      siteGroups: draft!.siteGroups,
    });
    setDirty(true);
  };

  const tabs: Array<{ id: Tab; label: string; icon: any }> = [
    { id: 'threshold', label: '阈值与解析', icon: Clock },
    { id: 'groups', label: '站点分组', icon: Tag },
    { id: 'types', label: '异常类型', icon: Palette },
    { id: 'versions', label: '版本历史', icon: Settings },
  ];

  return (
    <div className="p-6 space-y-5 min-h-screen deep-dot-grid">
      <header className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <div className="h-5 w-1 bg-signal-400" />
            <h1 className="font-display text-xl text-signal-400 tracking-wider glow-text">
              配置管理
            </h1>
          </div>
          <p className="text-sm text-slate-400">
            编辑 {draft.id.toUpperCase()} · 修改后发布为新版本，旧版本的标注会保留为历史
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={cloneActiveToDraft}
            className="btn-ghost flex items-center gap-1.5 text-xs"
            disabled={!activeConfig}
          >
            <Copy size={13} /> 恢复已发布
          </button>
          <button
            onClick={handlePublishNewVersion}
            disabled={!dirty || busy}
            className="btn-primary flex items-center gap-2"
          >
            <Save size={14} />
            {busy ? '发布中...' : dirty ? '发布为新版本 v+' : '无改动'}
            {dirty && <ChevronRight size={14} />}
          </button>
        </div>
      </header>

      <div className="card-border rounded-sm overflow-hidden">
        <div className="flex border-b border-signal-400/15 bg-deep-800/40">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex items-center gap-2 px-5 py-3 text-sm transition-all relative',
                tab === t.id
                  ? 'text-signal-400 bg-signal-400/5'
                  : 'text-slate-500 hover:text-signal-300',
              )}
            >
              <t.icon size={14} />
              {t.label}
              {tab === t.id && (
                <div className="absolute bottom-0 left-3 right-3 h-0.5 bg-signal-400" />
              )}
            </button>
          ))}
          {dirty && (
            <div className="ml-auto pr-4 flex items-center text-[11px] text-history-400">
              <RefreshCw size={11} className="animate-spin mr-1" style={{ animationDuration: '3s' }} />
              草稿已修改，点击"发布新版本"生效
            </div>
          )}
        </div>

        <div className="p-6">
          {tab === 'threshold' && (
            <div className="grid grid-cols-2 gap-8 max-w-4xl">
              <div>
                <div className="text-[11px] uppercase tracking-widest text-slate-500 mb-1.5">
                  配置版本名称
                </div>
                <input
                  className="input-base w-full"
                  value={draft.name}
                  onChange={(e) => { setDraft({ ...draft, name: e.target.value }); markDirty(); }}
                />
                <div className="text-[10px] text-slate-600 mt-1">仅用于显示，版本ID由系统自动分配</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-widest text-slate-500 mb-1.5">
                  <Clock size={11} className="inline mr-1" />
                  断报阈值（分钟）
                </div>
                <input
                  type="number"
                  min={1}
                  className="input-base w-full"
                  value={draft.thresholdMinutes}
                  onChange={(e) => {
                    const v = Math.max(1, parseInt(e.target.value || '1', 10));
                    setDraft({ ...draft, thresholdMinutes: v });
                    markDirty();
                  }}
                />
                <div className="text-[10px] text-slate-600 mt-1">
                  相邻两条记录超过此间隔即判定为一次断报
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-widest text-slate-500 mb-1.5">
                  时间字段名
                </div>
                <input
                  className="input-base w-full"
                  value={draft.timeField}
                  onChange={(e) => { setDraft({ ...draft, timeField: e.target.value }); markDirty(); }}
                />
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-widest text-slate-500 mb-1.5">
                  时间格式
                </div>
                <select
                  className="input-base w-full"
                  value={draft.timeFormat}
                  onChange={(e) => { setDraft({ ...draft, timeFormat: e.target.value }); markDirty(); }}
                >
                  <option value="ISO">ISO 8601 自动识别</option>
                  <option value="UNIX_S">Unix 秒级时间戳</option>
                  <option value="UNIX_MS">Unix 毫秒时间戳</option>
                </select>
              </div>
              <div className="col-span-2">
                <div className="text-[11px] uppercase tracking-widest text-slate-500 mb-1.5">
                  重复判定字段（按顺序拼接哈希）
                </div>
                <div className="flex flex-wrap gap-2 mb-2">
                  {draft.dedupeFields.map((f, i) => (
                    <span
                      key={i}
                      className="tag group flex items-center gap-1.5"
                    >
                      <GripVertical size={11} className="opacity-40" />
                      {f}
                      <X
                        size={11}
                        className="cursor-pointer opacity-60 hover:text-fault-400 hover:opacity-100"
                        onClick={() => {
                          setDraft({
                            ...draft,
                            dedupeFields: draft.dedupeFields.filter((_, j) => j !== i),
                          });
                          markDirty();
                        }}
                      />
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    id="new-field"
                    className="input-base flex-1 text-xs"
                    placeholder="输入字段名后回车添加，如 temperature"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const v = (e.target as HTMLInputElement).value.trim();
                        if (v && !draft.dedupeFields.includes(v)) {
                          setDraft({ ...draft, dedupeFields: [...draft.dedupeFields, v] });
                          (e.target as HTMLInputElement).value = '';
                          markDirty();
                        }
                      }
                    }}
                  />
                </div>
                <div className="text-[10px] text-slate-600 mt-1">
                  回车添加字段 · 默认 siteId + timestamp 可定位 99% 的重复记录
                </div>
              </div>
            </div>
          )}

          {tab === 'groups' && (
            <div className="space-y-4 max-w-5xl">
              <div className="flex justify-between items-center">
                <div className="text-[11px] text-slate-500">
                  将站点分配到分组后，断报区间会按分组聚合统计
                </div>
                <button onClick={addGroup} className="btn-ghost text-xs flex items-center gap-1.5">
                  <Plus size={13} /> 新增分组
                </button>
              </div>
              <div className="grid grid-cols-3 gap-4">
                {draft.siteGroups.map((g) => (
                  <div
                    key={g.id}
                    className="card-border rounded-sm p-4 space-y-3 fade-in"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        className="input-base flex-1 text-sm py-1.5"
                        value={g.name}
                        onChange={(e) => updateGroup(g.id, { name: e.target.value })}
                      />
                      <button
                        onClick={() => removeGroup(g.id)}
                        className="p-1.5 rounded-sm text-slate-500 hover:text-fault-400 hover:bg-fault-400/10"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <textarea
                      className="input-base w-full text-xs min-h-[80px] font-mono"
                      value={g.siteIds.join('\n')}
                      placeholder={'每行一个站点ID\n如：\nST-001\nST-002'}
                      onChange={(e) => {
                        const ids = e.target.value.split(/[\n,;\s]+/).map((s) => s.trim()).filter(Boolean);
                        updateGroup(g.id, { siteIds: Array.from(new Set(ids)) });
                      }}
                    />
                    <div className="text-[10px] text-slate-600 flex justify-between">
                      <span>空格/逗号/换行分隔</span>
                      <span className="text-signal-400">{g.siteIds.length} 个站点</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'types' && (
            <div className="space-y-4 max-w-5xl">
              <div className="flex justify-between items-center">
                <div className="text-[11px] text-slate-500">
                  异常类型用于分类和图表颜色，标注弹窗中可按站点修改
                </div>
                <button onClick={addType} className="btn-ghost text-xs flex items-center gap-1.5">
                  <Plus size={13} /> 新增类型
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {draft.anomalyTypes.map((t) => (
                  <div
                    key={t.code}
                    className="card-border rounded-sm p-4 flex items-start gap-3 fade-in"
                  >
                    <div
                      className="w-3 h-full min-h-[72px] rounded-sm shrink-0"
                      style={{ backgroundColor: t.color + '33', borderLeft: `3px solid ${t.color}` }}
                    />
                    <div className="flex-1 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <div className="text-[10px] text-slate-500 mb-0.5">类型编码</div>
                          <input
                            className="input-base w-full text-xs py-1.5"
                            value={t.code}
                            onChange={(e) => {
                              const oldCode = t.code;
                              const newCode = e.target.value;
                              const others = draft.anomalyTypes.filter((x) => x.code !== oldCode);
                              if (others.some((x) => x.code === newCode)) return;
                              updateType(oldCode, { code: newCode });
                            }}
                          />
                        </div>
                        <div>
                          <div className="text-[10px] text-slate-500 mb-0.5">显示名称</div>
                          <input
                            className="input-base w-full text-xs py-1.5"
                            value={t.name}
                            onChange={(e) => updateType(t.code, { name: e.target.value })}
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-2 items-start">
                        <div className="col-span-1">
                          <div className="text-[10px] text-slate-500 mb-0.5">颜色</div>
                          <input
                            type="color"
                            value={t.color}
                            onChange={(e) => updateType(t.code, { color: e.target.value })}
                            className="w-full h-8 rounded-sm bg-deep-800 border border-signal-400/15 cursor-pointer"
                          />
                        </div>
                        <div className="col-span-2">
                          <div className="text-[10px] text-slate-500 mb-0.5">默认原因模板</div>
                          <input
                            className="input-base w-full text-xs py-1.5"
                            value={t.defaultReason || ''}
                            placeholder="可选，例如：通信链路中断"
                            onChange={(e) => updateType(t.code, { defaultReason: e.target.value })}
                          />
                        </div>
                        <div className="pt-5 flex justify-end">
                          <button
                            onClick={() => removeType(t.code)}
                            disabled={draft.anomalyTypes.length <= 1}
                            className="p-1.5 rounded-sm text-slate-500 hover:text-fault-400 hover:bg-fault-400/10 disabled:opacity-30"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'versions' && (
            <div className="max-w-4xl space-y-3">
              <div className="text-[11px] text-slate-500 mb-2">
                所有已发布的配置版本 · 切换后会按该版本规则重新展示分析结果
              </div>
              {configs.length === 0 ? (
                <div className="text-slate-600 text-center py-10">暂无已发布版本</div>
              ) : (
                configs.map((c) => (
                  <div
                    key={c.id}
                    className={cn(
                      'card-border rounded-sm p-4 flex items-center gap-4 transition-all fade-in',
                      c.isActive && 'border-signal-400/50 shadow-glow-signal',
                    )}
                  >
                    <div
                      className={cn(
                        'w-10 h-10 rounded-sm flex items-center justify-center font-display shrink-0',
                        c.isActive
                          ? 'bg-signal-400/20 text-signal-400 border border-signal-400/50'
                          : 'bg-deep-800 text-slate-500 border border-signal-400/10',
                      )}
                    >
                      {c.id.toUpperCase().slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-display text-sm">{c.name}</span>
                        {c.isActive && (
                          <span className="text-[10px] px-2 py-0.5 rounded-sm bg-signal-400/15 border border-signal-400/30 text-signal-400">
                            当前激活
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        阈值 {c.thresholdMinutes} 分钟 · {c.siteGroups.length} 分组 · {c.anomalyTypes.length} 类型 ·
                        发布于 {new Date(c.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        disabled={c.isActive || busy}
                        onClick={() => switchToVersion(c.id)}
                        className={cn(
                          'btn-ghost text-xs flex items-center gap-1.5',
                          c.isActive && 'opacity-40 cursor-not-allowed',
                        )}
                      >
                        <RefreshCw size={12} />
                        {c.isActive ? '使用中' : '切换到此版本'}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
