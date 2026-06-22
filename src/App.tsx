import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { useEffect } from 'react';
import { SideNav } from '@/components/SideNav';
import { Toast } from '@/components/Toast';
import { Dashboard } from '@/pages/Dashboard';
import { Analysis } from '@/pages/Analysis';
import { Config } from '@/pages/Config';
import { Reports } from '@/pages/Reports';
import { useAppStore } from '@/stores/appStore';

export default function App() {
  const initialize = useAppStore((s) => s.initialize);
  const loading = useAppStore((s) => s.loading);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  return (
    <Router>
      <div className="min-h-screen flex bg-deep-950 text-slate-200 deep-grid-bg">
        <SideNav />
        <main className="flex-1 min-w-0">
          {loading ? (
            <div className="h-screen flex items-center justify-center">
              <div className="text-center space-y-4 fade-in">
                <div className="w-14 h-14 mx-auto rounded-sm border-2 border-signal-400 border-t-transparent animate-spin" />
                <div className="font-display text-signal-400 tracking-widest text-sm">
                  INITIALIZING...
                </div>
                <div className="text-[11px] text-slate-500">正在加载本地数据库</div>
              </div>
            </div>
          ) : (
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/analysis" element={<Analysis />} />
              <Route path="/config" element={<Config />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="*" element={<Dashboard />} />
            </Routes>
          )}
        </main>
        <Toast />
      </div>
    </Router>
  );
}
