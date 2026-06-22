import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ConfigVersion, FilterState, ImportStats } from '@/types';
import { db } from '@/db';

interface AppState {
  loading: boolean;
  initialized: boolean;
  configs: ConfigVersion[];
  activeConfig: ConfigVersion | null;
  filter: FilterState;
  lastImport: ImportStats | null;
  lastToast: { type: 'success' | 'error' | 'info'; message: string } | null;
  initialize: () => Promise<void>;
  reloadConfigs: () => Promise<void>;
  setActiveConfig: (id: string) => Promise<void>;
  addConfig: (cfg: ConfigVersion) => Promise<void>;
  setFilter: (patch: Partial<FilterState>) => void;
  resetFilter: () => void;
  setLastImport: (s: ImportStats | null) => void;
  showToast: (type: 'success' | 'error' | 'info', message: string) => void;
  clearToast: () => void;
}

const defaultFilter: FilterState = {
  configVersion: 'v1',
  timeRange: null,
  siteGroupIds: [],
  anomalyTypeCodes: [],
  annotationStatus: 'ALL',
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      loading: false,
      initialized: false,
      configs: [],
      activeConfig: null,
      filter: defaultFilter,
      lastImport: null,
      lastToast: null,

      async initialize() {
        if (get().initialized) return;
        set({ loading: true });
        try {
          const active = await db.ensureDefaultConfig();
          await get().reloadConfigs();
          const f = get().filter;
          if (f.configVersion !== active.id) {
            set({ filter: { ...f, configVersion: active.id } });
          }
          set({ initialized: true });
        } finally {
          set({ loading: false });
        }
      },

      async reloadConfigs() {
        const all = await db.configVersions.orderBy('createdAt').toArray();
        const active = all.find((c) => c.isActive) || all[0];
        set({
          configs: all,
          activeConfig: active || null,
          filter: active ? { ...get().filter, configVersion: active.id } : get().filter,
        });
      },

      async setActiveConfig(id: string) {
        await db.setActiveConfig(id);
        await get().reloadConfigs();
      },

      async addConfig(cfg: ConfigVersion) {
        await db.configVersions.put(cfg);
        await get().reloadConfigs();
      },

      setFilter(patch) {
        set((state) => ({ filter: { ...state.filter, ...patch } }));
      },

      resetFilter() {
        const activeId = get().activeConfig?.id || 'v1';
        set({ filter: { ...defaultFilter, configVersion: activeId } });
      },

      setLastImport(s) {
        set({ lastImport: s });
      },

      showToast(type, message) {
        set({ lastToast: { type, message } });
        setTimeout(() => set({ lastToast: null }), 3500);
      },

      clearToast() {
        set({ lastToast: null });
      },
    }),
    {
      name: 'sensor-outage-app-v1',
      partialize: (s) => ({ filter: s.filter }),
    },
  ),
);
