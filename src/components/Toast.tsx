import { useAppStore } from '@/stores/appStore';
import { CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/utils';

export function Toast() {
  const t = useAppStore((s) => s.lastToast);
  const clear = useAppStore((s) => s.clearToast);
  if (!t) return null;
  const styles: Record<string, string> = {
    success: 'border-success-400/50 bg-success-400/10 text-success-400',
    error: 'border-fault-400/50 bg-fault-400/10 text-fault-400',
    info: 'border-signal-400/50 bg-signal-400/10 text-signal-400',
  };
  const Icon = t.type === 'success' ? CheckCircle2 : t.type === 'error' ? AlertTriangle : Info;
  return (
    <div
      onClick={clear}
      className={cn(
        'fixed top-6 right-6 z-[100] px-4 py-3 rounded-sm border backdrop-blur-sm shadow-card cursor-pointer fade-in min-w-[280px]',
        styles[t.type],
      )}
    >
      <div className="flex items-start gap-3">
        <Icon size={17} className="mt-0.5 shrink-0" />
        <div className="text-sm leading-relaxed">{t.message}</div>
      </div>
    </div>
  );
}
