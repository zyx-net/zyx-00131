import Dexie, { Table } from 'dexie';
import type {
  Annotation,
  ConfigVersion,
  ErrorRow,
  ExportRecord,
  OutageInterval,
  PublishRecord,
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
  dedupeFields: ['siteId', 'timestamp', 'temperature'],
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
  publishRecords!: Table<PublishRecord, string>;

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
      publishRecords: 'id, configVersion, createdAt',
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
    await this.transaction('rw', this.configVersions, this.annotations, async () => {
      await this.configVersions.toCollection().modify({ isActive: false });
      await this.configVersions.update(id, { isActive: true });
      await this.restoreConfigAnnotations(id);
    });
  }

  async restoreConfigAnnotations(configId: string): Promise<number> {
    const allAnnots = await this.annotations.toArray();
    const byOutageKey = new Map<string, Annotation[]>();

    for (const a of allAnnots) {
      let siteId = a.siteId;
      let startTime = a.startTime;
      if (siteId === undefined || startTime === undefined) {
        const iv = await this.outageIntervals.get(a.outageIntervalId);
        if (!iv) continue;
        siteId = iv.siteId;
        startTime = iv.startTime;
        await this.annotations.update(a.id, { siteId, startTime });
      }
      const key = `${siteId}_${startTime}`;
      if (!byOutageKey.has(key)) byOutageKey.set(key, []);
      byOutageKey.get(key)!.push(a);
    }

    let restoredCount = 0;
    const toUpdate: Array<{ id: string; isCurrent: boolean }> = [];

    for (const [, anns] of byOutageKey) {
      const targetAnnots = anns.filter((a) => a.configVersion === configId);
      if (targetAnnots.length > 0) {
        targetAnnots.sort((a, b) => b.annotatedAt - a.annotatedAt);
        targetAnnots.forEach((a, idx) => {
          const shouldBeCurrent = idx === 0;
          if (a.isCurrent !== shouldBeCurrent) {
            toUpdate.push({ id: a.id, isCurrent: shouldBeCurrent });
            if (shouldBeCurrent) restoredCount++;
          }
        });
        const otherAnnots = anns.filter((a) => a.configVersion !== configId);
        for (const a of otherAnnots) {
          if (a.isCurrent) {
            toUpdate.push({ id: a.id, isCurrent: false });
          }
        }
      }
    }

    if (toUpdate.length > 0) {
      await this.annotations.bulkUpdate(
        toUpdate.map((u) => ({ key: u.id, changes: { isCurrent: u.isCurrent } })),
      );
    }
    return restoredCount;
  }

  async ensureAnnotationConsistency(): Promise<void> {
    const active = await this.getActiveConfig();
    if (active) {
      await this.restoreConfigAnnotations(active.id);
    }
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
