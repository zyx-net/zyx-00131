import { NavLink } from 'react-router-dom';
import {
  BarChart3,
  Settings,
  FileSpreadsheet,
  LayoutDashboard,
  Radio,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';

const items = [
  { to: '/', icon: LayoutDashboard, label: '仪表盘', end: true },
  { to: '/analysis', icon: BarChart3, label: '断报分析' },
  { to: '/config', icon: Settings, label: '配置管理' },
  { to: '/reports', icon: FileSpreadsheet, label: '报告中心' },
];

export function SideNav() {
  const { activeConfig, configs } = useAppStore();

  return (
    <aside className="w-60 shrink-0 h-screen sticky top-0 border-r border-signal-400/15 bg-deep-950/70 backdrop-blur-sm flex flex-col">
      <div className="px-5 py-5 border-b border-signal-400/10 flex items-center gap-3">
        <div className="w-9 h-9 rounded-sm bg-signal-400/15 border border-signal-400/40 flex items-center justify-center text-signal-400">
          <Radio size={18} strokeWidth={1.8} />
        </div>
        <div>
          <div className="font-display text-sm text-signal-400 tracking-wider glow-text">
            SENSOR · INSIGHT
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-widest">
            Outage Analyzer
          </div>
        </div>
      </div>

      <nav className="flex-1 py-3 px-2 space-y-1">
        {items.map(({ to, icon: Icon, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-sm text-sm transition-all ${
                isActive
                  ? 'bg-signal-400/15 text-signal-400 border-l-2 border-signal-400 shadow-glow-signal'
                  : 'text-slate-400 hover:text-signal-300 hover:bg-signal-400/5'
              }`
            }
          >
            <Icon size={17} strokeWidth={1.7} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="px-3 pb-4 pt-3 border-t border-signal-400/10">
        <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5 px-2">
          当前配置版本
        </div>
        <div className="px-3 py-2 rounded-sm bg-deep-800/80 border border-signal-400/20">
          <div className="text-signal-400 text-sm font-display">
            {activeConfig?.id?.toUpperCase()}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5 truncate">
            {activeConfig?.name || '—'}
          </div>
          <div className="flex items-center gap-1.5 mt-1.5 text-[10px]">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-history-400" />
            <span className="text-slate-500">
              {configs.length} 个版本 · 阈值 {activeConfig?.thresholdMinutes || 30} 分钟
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
