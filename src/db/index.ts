import Dexie, { Table } from 'dexie';
import type {
  Annotation,
  ConfigVersion,
  ErrorRow,
  ExportRecord,
  OutageInterval,
  TelemetryLog,
} from '@/types';

const DEFAULT_ANOMALY_TYPES = [
  { code: 'COMM_LOST', name: '通信中断', color: '#FF8A3D', defaultReason: '疑似通信链路故障' },
  { code: 'SENSOR_FAULT', name: '传感器故障', color: '#FF4D6D', defaultReason: '传感器采集异常' },
  { code: 'POWER_DOWN', name: '站点断电', color: '#FBBF24', defaultReason: '站点供电中断' },
  { code: 'UNKNOWN', name: '未知异常', color: '#64748B' },
];

const DEFAULT_SITE_GROUPS = [
  { id: 'grp_east', name: '东部分站', siteIds: [] },
  { id: 'grp_west', name: '西部分站', siteIds: [] },
  { id: 'grp_north', name: '北部分站', siteIds: [] },
];

export const DEFAULT_CONFIG: Omit<ConfigVersion, 'createdAt'> = {
  id: 'v1',
  name: '默认配置 v1',
  isActive: true,
  thresholdMinutes: 30,
  dedupeFields: ['siteId', 'timestamp'],
  timeField: 'timestamp',
  timeFormat: 'ISO',
  siteGroups: DEFAULT_SITE_GROUPS,
  anomalyTypes: DEFAULT_ANOMALY_TYPES,
};

export class AppDatabase extends Dexie {
  configVersions!: Table<ConfigVersion, string>;
  telemetryLogs!: Table<TelemetryLog, string>;
  errorRows!: Table<ErrorRow, string>;
  outageIntervals!: Table<OutageInterval, string>;
  annotations!: Table<Annotation, string>;
  exportRecords!: Table<ExportRecord, string>;

  constructor() {
    super('SensorOutageDB_v2');
    this.version(1).stores({
      configVersions: 'id, createdAt',
      telemetryLogs: 'id, siteId, timestamp, importBatchId, sourceFile',
      errorRows: 'id, errorType, sourceFile, importBatchId, createdAt',
      outageIntervals:
        'id, configVersion, siteId, siteGroupId, anomalyTypeCode, startTime, endTime',
      annotations:
        'id, outageIntervalId, configVersion, annotatedAt',
      exportRecords: 'id, fileType, configVersion, createdAt',
    });
  }

  async ensureDefaultConfig(): Promise<ConfigVersion> {
    const existing = await this.configVersions.get('v1');
    if (existing) {
      await this.migrateAnnotations();
      return existing;
    }
    const cfg: ConfigVersion = { ...DEFAULT_CONFIG, createdAt: Date.now() };
    await this.configVersions.add(cfg);
    return cfg;
  }

  async migrateAnnotations(): Promise<void> {
    const anns = await this.annotations.toArray();
    const needUpdate: Array<{ id: string; siteId: string; startTime: number }> = [];
    for (const a of anns) {
      if (a.siteId !== undefined && a.startTime !== undefined) continue;
      const iv = await this.outageIntervals.get(a.outageIntervalId);
      if (!iv) continue;
      needUpdate.push({ id: a.id, siteId: iv.siteId, startTime: iv.startTime });
    }
    if (needUpdate.length > 0) {
      await this.transaction('rw', this.annotations, async () => {
        for (const u of needUpdate) {
          await this.annotations.update(u.id, { siteId: u.siteId, startTime: u.startTime });
        }
      });
    }
  }

  async getActiveConfig(): Promise<ConfigVersion> {
    const all = await this.configVersions.toArray();
    const active = all.find((c) => c.isActive);
    if (!active) {
      return await this.ensureDefaultConfig();
    }
    return active;
  }

  async setActiveConfig(id: string): Promise<void> {
    await this.transaction('rw', this.configVersions, async () => {
      await this.configVersions.toCollection().modify({ isActive: false });
      await this.configVersions.update(id, { isActive: true });
    });
  }

  async createNewConfig(base: ConfigVersion, overrides: Partial<ConfigVersion>): Promise<ConfigVersion> {
    const nextNum = (await this.configVersions.count()) + 1;
    const newCfg: ConfigVersion = {
      ...base,
      ...overrides,
      id: `v${nextNum}`,
      name: overrides.name || `配置 v${nextNum}`,
      createdAt: Date.now(),
      isActive: true,
    };
    await this.transaction('rw', this.configVersions, async () => {
      await this.configVersions.toCollection().modify({ isActive: false });
      await this.configVersions.add(newCfg);
    });
    return newCfg;
  }
}

export const db = new AppDatabase();
