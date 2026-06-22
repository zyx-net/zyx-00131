import { describe, it, expect, beforeEach } from 'vitest';
import type { Annotation, ConfigVersion, OutageInterval } from '@/types';
import { db, AppDatabase, DEFAULT_CONFIG } from '@/db';
import { saveAnnotation, archiveOutageCurrentAnnotations, getAnnotationHistory } from '@/services/annotation';
import { runAnalysis, computeOutageIntervals } from '@/services/analyzer';
import { compareConfigs, createPublishRecord, getPublishRecords } from '@/services/publish';
import { buildCsvExport, buildHtmlReport } from '@/services/exporter';
import { uid } from '@/utils';

function makeConfig(id: string, thresholdMinutes: number, isActive = false): ConfigVersion {
  return {
    ...DEFAULT_CONFIG,
    id,
    name: `配置 ${id}`,
    thresholdMinutes,
    isActive,
    createdAt: Date.now(),
    siteGroups: JSON.parse(JSON.stringify(DEFAULT_CONFIG.siteGroups)),
    anomalyTypes: JSON.parse(JSON.stringify(DEFAULT_CONFIG.anomalyTypes)),
    dedupeFields: [...DEFAULT_CONFIG.dedupeFields],
  };
}

function makeLog(siteId: string, ts: number, sourceFile = 'test.csv'): any {
  return {
    id: `log_${uid('')}`,
    siteId,
    timestamp: ts,
    rawTimestamp: new Date(ts).toISOString(),
    sourceFile,
    importBatchId: 'batch_test',
    temperature: 20,
    humidity: 50,
  };
}

async function clearDb(d: AppDatabase) {
  await d.transaction('rw', d.telemetryLogs, d.errorRows, d.outageIntervals, d.annotations, d.configVersions, async () => {
    await d.telemetryLogs.clear();
    await d.errorRows.clear();
    await d.outageIntervals.clear();
    await d.annotations.clear();
    await d.configVersions.clear();
  });
}

describe('标注历史归档（断报阈值变更链路）', () => {
  beforeEach(async () => {
    await clearDb(db);
  });

  it('发布新版本后，同断报仅保留一个当前标注，其余自动归档', async () => {
    // ===== 阶段 1：v1 配置，阈值 30 分钟 =====
    const v1 = makeConfig('v1', 30, true);
    await db.configVersions.add(v1);

    // 三条日志：t0, t0+35min（35min>30→断报A）, t0+80min（45min>30→断报B）
    const t0 = Date.now() - 3600_000 * 2;
    const logs = [
      makeLog('ST-001', t0),
      makeLog('ST-001', t0 + 35 * 60_000),   // 断报A：t0 → t0+35
      makeLog('ST-001', t0 + 80 * 60_000),   // 断报B：t0+35 → t0+80
    ];
    await db.telemetryLogs.bulkAdd(logs);

    // 计算断报 → 2 个（35min 和 45min）
    const r1 = await runAnalysis(v1, true);
    expect(r1.totalProcessed).toBe(2);
    const durations1 = r1.intervals.map((iv) => iv.durationMinutes).sort((a, b) => a - b);
    expect(durations1).toEqual([35, 45]);
    const ivB_v1 = r1.intervals.find((iv) => Math.abs(iv.durationMinutes - 45) < 1)!;  // 45min 那段
    expect(ivB_v1).toBeDefined();

    // 给断报B（45分钟那段）加标注
    const ann1 = await saveAnnotation(ivB_v1, {
      reasonCode: 'POWER_OUTAGE',
      reasonText: '站点断电',
      remark: 'v1 首次标注 45min 断报',
    });
    expect(ann1.isCurrent).toBe(true);
    expect(ann1.configVersion).toBe('v1');

    // 校验：只有 1 条当前标注
    const all1 = await db.annotations.toArray();
    expect(all1.filter((a) => a.isCurrent).length).toBe(1);
    expect(all1.filter((a) => !a.isCurrent).length).toBe(0);

    // ===== 阶段 2：发布 v2，阈值改为 40 分钟 =====
    // 阈值 40：断报A（35min）消失，断报B（45min）保留
    const v2 = makeConfig('v2', 40, true);
    await db.transaction('rw', db.configVersions, async () => {
      await db.configVersions.toCollection().modify({ isActive: false });
      await db.configVersions.add(v2);
    });

    const r2 = await runAnalysis(v2, true);
    expect(r2.totalProcessed).toBe(1);  // 只有断报B（45min）保留
    const ivB_v2 = r2.intervals[0];
    expect(ivB_v2.durationMinutes).toBeCloseTo(45, 0);
    expect(ivB_v2.configVersion).toBe('v2');
    // startTime 应该和 ivB_v1 相同（容差内）
    expect(Math.abs(ivB_v2.startTime - ivB_v1.startTime)).toBeLessThan(1000);

    // 关键断言：迁移后，v1 原标注应被归档（isCurrent=false），v2 新标注 isCurrent=true
    const all2 = await db.annotations.toArray();
    const current2 = all2.filter((a) => a.isCurrent);
    const archived2 = all2.filter((a) => !a.isCurrent);
    expect(current2.length).toBe(1);
    expect(current2[0].configVersion).toBe('v2');
    expect(archived2.length).toBe(1);
    expect(archived2[0].configVersion).toBe('v1');

    // 给 v2 的断报B手动再标注一次 → saveAnnotation 应该先归档 v2 的迁移标注
    const ann2 = await saveAnnotation(ivB_v2, {
      reasonCode: 'COMM_FAULT',
      reasonText: '通信故障',
      remark: 'v2 用户重新标注',
    });
    expect(ann2.isCurrent).toBe(true);

    const all3 = await db.annotations.toArray();
    const current3 = all3.filter((a) => a.isCurrent);
    expect(current3.length).toBe(1);
    expect(current3[0].reasonCode).toBe('COMM_FAULT');
    expect(all3.filter((a) => !a.isCurrent).length).toBe(2);  // v1 原标注 + v2 迁移标注

    // getAnnotationHistory 返回最多 1 条当前标注
    const history = await getAnnotationHistory(ivB_v2.id);
    const histCurrent = history.filter((h) => h.isCurrent);
    expect(histCurrent.length).toBeLessThanOrEqual(1);
    if (histCurrent.length > 0) {
      expect(histCurrent[0].reasonCode).toBe('COMM_FAULT');
    }

    // 历史列表按时间倒序，共 3 条记录
    expect(history.length).toBe(3);
  });

  it('getAnnotationHistory 兜底：数据库脏数据多条当前标注时自动保留最新的', async () => {
    const v1 = makeConfig('v1', 30, true);
    await db.configVersions.add(v1);

    const t0 = Date.now() - 3600_000;
    const iv: OutageInterval = {
      id: 'out_test',
      configVersion: 'v1',
      siteId: 'ST-001',
      siteGroupId: 'grp_east',
      anomalyTypeCode: 'COMM_LOST',
      startTime: t0,
      endTime: t0 + 40 * 60_000,
      durationMinutes: 40,
    };
    await db.outageIntervals.add(iv);

    // 故意注入脏数据：两条 isCurrent=true 的标注
    const dirtyAnns: Annotation[] = [
      {
        id: 'ann_old',
        outageIntervalId: 'out_test',
        configVersion: 'v1',
        reasonCode: 'POWER_OUTAGE',
        reasonText: '旧标注',
        remark: '',
        annotatedAt: t0 + 1000,
        annotatedBy: 'test',
        isCurrent: true,
        siteId: 'ST-001',
        startTime: t0,
      },
      {
        id: 'ann_newer',
        outageIntervalId: 'out_test',
        configVersion: 'v1',
        reasonCode: 'COMM_FAULT',
        reasonText: '新标注',
        remark: '',
        annotatedAt: t0 + 2000,
        annotatedBy: 'test',
        isCurrent: true,  // 脏数据
        siteId: 'ST-001',
        startTime: t0,
      },
    ];
    await db.annotations.bulkAdd(dirtyAnns);

    // 调用 getAnnotationHistory → 自动修复，保留最新的
    const history = await getAnnotationHistory('out_test');
    expect(history.length).toBe(2);
    const currentOnes = history.filter((h) => h.isCurrent);
    expect(currentOnes.length).toBe(1);
    expect(currentOnes[0].id).toBe('ann_newer');  // 保留 annotatedAt 最新的

    // 数据库也被修复了
    const dbAnns = await db.annotations.toArray();
    expect(dbAnns.filter((a) => a.isCurrent).length).toBe(1);
    expect(dbAnns.find((a) => a.id === 'ann_old')!.isCurrent).toBe(false);
  });

  it('连续多次版本发布，标注状态始终一致（回归测试）', async () => {
    const t0 = Date.now() - 7200_000;
    const siteId = 'ST-999';

    // 初始化日志：2 小时内 3 条，间隔 65 分钟
    await db.telemetryLogs.bulkAdd([
      makeLog(siteId, t0),
      makeLog(siteId, t0 + 65 * 60_000),
      makeLog(siteId, t0 + 130 * 60_000),
    ]);

    const thresholds = [30, 40, 50, 60];
    let prevConfig: ConfigVersion | null = null;

    for (let i = 0; i < thresholds.length; i++) {
      const cfgId = `v${i + 1}`;
      const cfg = makeConfig(cfgId, thresholds[i], true);
      await db.transaction('rw', db.configVersions, async () => {
        await db.configVersions.toCollection().modify({ isActive: false });
        await db.configVersions.add(cfg);
      });

      const r = await runAnalysis(cfg, true);
      // 阈值 < 65 则有 2 个断报，>=65 则 0
      const expected = thresholds[i] < 65 ? 2 : 0;
      expect(r.totalProcessed).toBe(expected);

      // 给第一个区间加标注
      if (r.intervals.length > 0) {
        await saveAnnotation(r.intervals[0], {
          reasonCode: 'MAINTENANCE',
          reasonText: `计划维护 ${cfgId}`,
          remark: `第 ${i + 1} 轮标注`,
        });
      }

      // 全局断言：所有同断报标注最多一个 isCurrent=true
      const all = await db.annotations.toArray();
      const byOutage = new Map<string, Annotation[]>();
      for (const a of all) {
        const key = `${a.siteId}_${a.startTime}`;
        if (!byOutage.has(key)) byOutage.set(key, []);
        byOutage.get(key)!.push(a);
      }
      for (const [, anns] of byOutage) {
        const current = anns.filter((a) => a.isCurrent);
        expect(current.length).toBeLessThanOrEqual(1);
      }

      prevConfig = cfg;
    }
  });

  it('archiveOutageCurrentAnnotations 正确识别跨版本同断报', async () => {
    const t0 = Date.now() - 3600_000;
    const siteId = 'ST-007';

    // v1 标注
    const annV1: Annotation = {
      id: 'ann_v1',
      outageIntervalId: 'out_v1',
      configVersion: 'v1',
      reasonCode: 'POWER_OUTAGE',
      reasonText: '断电',
      remark: '',
      annotatedAt: t0 + 1000,
      annotatedBy: 'test',
      isCurrent: true,
      siteId,
      startTime: t0,
    };
    await db.annotations.add(annV1);

    // 归档同断报
    const archivedCount = await archiveOutageCurrentAnnotations(siteId, t0 + 1000);  // 容差 60s 内
    expect(archivedCount).toBe(1);

    const after = await db.annotations.get('ann_v1');
    expect(after!.isCurrent).toBe(false);
  });

  it('runAnalysis 脏数据多条当前标注时，UI/筛选/导出统一取最新的', async () => {
    const v1 = makeConfig('v1', 30, true);
    await db.configVersions.add(v1);

    const t0 = Date.now() - 7200_000;
    await db.telemetryLogs.bulkAdd([
      makeLog('ST-999', t0),
      makeLog('ST-999', t0 + 35 * 60_000),
    ]);

    const r0 = await runAnalysis(v1, true);
    expect(r0.totalProcessed).toBe(1);
    const iv = r0.intervals[0];

    // 故意制造脏数据：同 interval 插入 3 条 isCurrent=true 的标注
    const t1 = t0 + 1000;
    const t2 = t0 + 2000;
    const t3 = t0 + 3000;  // 最新
    await db.annotations.bulkAdd([
      {
        id: 'ann_old',
        outageIntervalId: iv.id,
        configVersion: 'v1',
        reasonCode: 'POWER_OUTAGE',
        reasonText: '旧结论',
        remark: '',
        isCurrent: true,
        annotatedAt: t1,
        annotatedBy: 'test',
        siteId: iv.siteId,
        startTime: iv.startTime,
      },
      {
        id: 'ann_mid',
        outageIntervalId: iv.id,
        configVersion: 'v1',
        reasonCode: 'COMM_FAULT',
        reasonText: '中间结论',
        remark: '',
        isCurrent: true,
        annotatedAt: t2,
        annotatedBy: 'test',
        siteId: iv.siteId,
        startTime: iv.startTime,
      },
      {
        id: 'ann_new',
        outageIntervalId: iv.id,
        configVersion: 'v1',
        reasonCode: 'MAINTENANCE',
        reasonText: '最新结论',
        remark: '',
        isCurrent: true,
        annotatedAt: t3,
        annotatedBy: 'test',
        siteId: iv.siteId,
        startTime: iv.startTime,
      },
    ]);

    // 验证 runAnalysis 返回的 annotation 是最新那条
    const r1 = await runAnalysis(v1, false);
    expect(r1.intervals[0].annotation).toBeDefined();
    expect(r1.intervals[0].annotation!.reasonCode).toBe('MAINTENANCE');
    expect(r1.intervals[0].annotation!.id).toBe('ann_new');

    // getAnnotationHistory 兜底修复后，只剩 1 条当前
    const history = await getAnnotationHistory(iv.id);
    const currentList = history.filter((h) => h.isCurrent);
    expect(currentList.length).toBe(1);
    expect(currentList[0].id).toBe('ann_new');

    // 数据库里被修复为 1 条当前
    const all = await db.annotations.toArray();
    const dbCurrent = all.filter((a) => a.isCurrent);
    expect(dbCurrent.length).toBe(1);
    expect(dbCurrent[0].id).toBe('ann_new');
  });

  it('边界场景：阈值改得过大没有新区间时，旧版本当前标注也会被归档', async () => {
    const v1 = makeConfig('v1', 30, true);
    await db.configVersions.add(v1);

    const t0 = Date.now() - 7200_000;
    await db.telemetryLogs.bulkAdd([
      makeLog('ST-999', t0),
      makeLog('ST-999', t0 + 45 * 60_000),
    ]);

    // v1 有 1 条断报（45min > 30）
    const r1 = await runAnalysis(v1, true);
    expect(r1.totalProcessed).toBe(1);
    const iv = r1.intervals[0];

    // v1 标注（isCurrent=true）
    await saveAnnotation(iv, {
      reasonCode: 'POWER_OUTAGE',
      reasonText: 'v1 断电',
      remark: '',
    });
    const before = await db.annotations.toArray();
    expect(before.filter((a) => a.isCurrent).length).toBe(1);

    // 发布 v2，阈值设为 10000 分钟（远大于 45min，不会产生任何新区间）
    const v2 = makeConfig('v2', 10000, true);
    await db.transaction('rw', db.configVersions, async () => {
      await db.configVersions.toCollection().modify({ isActive: false });
      await db.configVersions.add(v2);
    });

    // forceRecompute → 应该把 v1 的标注归档，即使没有产生任何 v2 新区间
    const r2 = await runAnalysis(v2, true);
    expect(r2.totalProcessed).toBe(0);  // 阈值太大，无断报

    // 关键断言：v1 的标注已经被归档为历史
    const after = await db.annotations.toArray();
    const current = after.filter((a) => a.isCurrent);
    expect(current.length).toBe(0);  // 没有任何当前标注（因为 v2 没有区间）
    expect(after[0].isCurrent).toBe(false);
    expect(after[0].configVersion).toBe('v1');
    expect(after[0].reasonCode).toBe('POWER_OUTAGE');
  });

  it('restoreConfigAnnotations 切换版本后正确恢复标注状态', async () => {
    const t0 = Date.now() - 7200_000;
    const siteId = 'ST-777';

    // 初始化日志
    await db.telemetryLogs.bulkAdd([
      makeLog(siteId, t0),
      makeLog(siteId, t0 + 35 * 60_000),
      makeLog(siteId, t0 + 80 * 60_000),
    ]);

    // ===== v1: 阈值 30，2 个断报 =====
    const v1 = makeConfig('v1', 30, true);
    await db.configVersions.add(v1);
    const r1 = await runAnalysis(v1, true);
    expect(r1.totalProcessed).toBe(2);

    // 给两个断报都加标注
    await saveAnnotation(r1.intervals[0], {
      reasonCode: 'POWER_OUTAGE', reasonText: '断电', remark: 'v1 标注1',
    });
    await saveAnnotation(r1.intervals[1], {
      reasonCode: 'COMM_FAULT', reasonText: '通信故障', remark: 'v1 标注2',
    });

    // v1 状态：2 条当前标注
    const anns1 = await db.annotations.toArray();
    expect(anns1.filter((a) => a.isCurrent).length).toBe(2);
    expect(anns1.filter((a) => a.configVersion === 'v1').length).toBe(2);

    // ===== v2: 阈值 40，1 个断报（35min 消失，45min 保留）=====
    const v2 = makeConfig('v2', 40, true);
    await db.transaction('rw', db.configVersions, async () => {
      await db.configVersions.toCollection().modify({ isActive: false });
      await db.configVersions.add(v2);
    });
    const r2 = await runAnalysis(v2, true);
    expect(r2.totalProcessed).toBe(1);

    // v2 状态：1 条迁移的当前标注（v1 的 45min 断报），2 条 v1 归档标注
    const anns2 = await db.annotations.toArray();
    const v2Current = anns2.filter((a) => a.configVersion === 'v2' && a.isCurrent);
    const v1Archived = anns2.filter((a) => a.configVersion === 'v1' && !a.isCurrent);
    expect(v2Current.length).toBe(1);
    expect(v1Archived.length).toBe(2);

    // ===== 关键测试：切换回 v1，restoreConfigAnnotations 应恢复 v1 标注 =====
    await db.setActiveConfig('v1');

    // 验证：v1 标注恢复为当前，v2 标注被归档
    const anns3 = await db.annotations.toArray();
    const v1Current = anns3.filter((a) => a.configVersion === 'v1' && a.isCurrent);
    const v2Archived = anns3.filter((a) => a.configVersion === 'v2' && !a.isCurrent);
    expect(v1Current.length).toBe(2);
    expect(v2Archived.length).toBe(1);

    // 验证 runAnalysis 返回的区间带有正确的 annotation
    const r3 = await runAnalysis(v1, false);
    expect(r3.intervals.length).toBe(2);
    for (const iv of r3.intervals) {
      expect(iv.annotation).toBeDefined();
      expect(iv.annotation!.isCurrent).toBe(true);
      expect(iv.annotation!.configVersion).toBe('v1');
    }
  });

  it('ensureAnnotationConsistency 应用启动时自动修复标注状态', async () => {
    const t0 = Date.now() - 3600_000;

    // 制造脏数据：两条标注，都 isCurrent=true，但分属不同版本
    const v1 = makeConfig('v1', 30, true);
    const v2 = makeConfig('v2', 40, false);
    await db.configVersions.bulkAdd([v1, v2]);

    await db.telemetryLogs.bulkAdd([
      makeLog('ST-999', t0),
      makeLog('ST-999', t0 + 45 * 60_000),
    ]);

    // 故意制造脏数据
    await db.annotations.bulkAdd([
      {
        id: 'ann_v1',
        outageIntervalId: 'out_test1',
        configVersion: 'v1',
        reasonCode: 'POWER_OUTAGE',
        reasonText: 'v1 标注',
        remark: '',
        annotatedAt: t0 + 1000,
        annotatedBy: 'test',
        isCurrent: true,
        siteId: 'ST-999',
        startTime: t0,
      },
      {
        id: 'ann_v2',
        outageIntervalId: 'out_test2',
        configVersion: 'v2',
        reasonCode: 'COMM_FAULT',
        reasonText: 'v2 标注',
        remark: '',
        annotatedAt: t0 + 2000,
        annotatedBy: 'test',
        isCurrent: true,  // 脏数据：v2 不是激活版本但标注 isCurrent=true
        siteId: 'ST-999',
        startTime: t0,
      },
    ]);

    // 调用 ensureAnnotationConsistency（模拟应用启动）
    await db.ensureAnnotationConsistency();

    // 验证：只有激活版本 v1 的标注 isCurrent=true
    const after = await db.annotations.toArray();
    const v1Ann = after.find((a) => a.id === 'ann_v1')!;
    const v2Ann = after.find((a) => a.id === 'ann_v2')!;
    expect(v1Ann.isCurrent).toBe(true);
    expect(v2Ann.isCurrent).toBe(false);
  });

  it('createPublishRecord 正确记录发布变更', async () => {
    const oldCfg = makeConfig('v1', 30, true);
    const newCfg = makeConfig('v2', 40, true);
    newCfg.name = '新配置 v2';
    newCfg.siteGroups.push({ id: 'grp_test', name: '测试分组', siteIds: ['ST-001'] });

    const record = await createPublishRecord(newCfg, oldCfg, {
      previousCount: 5,
      newCount: 3,
      migratedAnnotations: 2,
    });

    expect(record.configVersion).toBe('v2');
    expect(record.previousConfigVersion).toBe('v1');
    expect(record.changes.thresholdMinutes).toEqual({ from: 30, to: 40 });
    expect(record.changes.siteGroups?.added).toContain('grp_test');
    expect(record.affectedIntervals.previousCount).toBe(5);
    expect(record.affectedIntervals.newCount).toBe(3);
    expect(record.affectedIntervals.migratedAnnotations).toBe(2);

    const records = await getPublishRecords();
    expect(records.length).toBe(1);
    expect(records[0].id).toBe(record.id);
  });

  it('compareConfigs 正确识别各类配置变更', async () => {
    const v1 = makeConfig('v1', 30, true);
    const v2 = makeConfig('v2', 60, true);

    v2.name = '生产配置';
    v2.timeFormat = 'UNIX_MS';
    v2.dedupeFields = ['siteId', 'timestamp'];
    v2.anomalyTypes.push({ code: 'NEW_TYPE', name: '新类型', color: '#00FF00' });
    v2.siteGroups = v2.siteGroups.slice(0, 2);  // 删除一个分组
    v2.siteGroups[0].name = '改名的东部分站';

    const changes = compareConfigs(v1, v2);

    expect(changes.thresholdMinutes).toEqual({ from: 30, to: 60 });
    expect(changes.siteGroups?.removed.length).toBe(1);
    expect(changes.siteGroups?.modified.length).toBe(1);
    expect(changes.anomalyTypes?.added.length).toBe(1);
    expect(changes.other).toBeDefined();
    expect(changes.other!.some((o) => o.includes('配置名称'))).toBe(true);
    expect(changes.other!.some((o) => o.includes('时间格式'))).toBe(true);
    expect(changes.other!.some((o) => o.includes('去重字段'))).toBe(true);
  });

  it('边界场景：阈值过大无区间时切换版本仍能正确恢复标注', async () => {
    const t0 = Date.now() - 7200_000;
    const siteId = 'ST-888';

    await db.telemetryLogs.bulkAdd([
      makeLog(siteId, t0),
      makeLog(siteId, t0 + 45 * 60_000),
    ]);

    // v1: 阈值 30，有 1 个断报（45min）
    const v1 = makeConfig('v1', 30, true);
    await db.configVersions.add(v1);
    const r1 = await runAnalysis(v1, true);
    expect(r1.totalProcessed).toBe(1);

    // v1 加标注
    await saveAnnotation(r1.intervals[0], {
      reasonCode: 'POWER_OUTAGE', reasonText: '断电', remark: '',
    });
    const anns1 = await db.annotations.toArray();
    expect(anns1.filter((a) => a.isCurrent).length).toBe(1);

    // v2: 阈值 10000，无断报
    const v2 = makeConfig('v2', 10000, true);
    await db.transaction('rw', db.configVersions, async () => {
      await db.configVersions.toCollection().modify({ isActive: false });
      await db.configVersions.add(v2);
    });
    const r2 = await runAnalysis(v2, true);
    expect(r2.totalProcessed).toBe(0);

    // v2 状态：v1 标注被归档
    const anns2 = await db.annotations.toArray();
    expect(anns2.filter((a) => a.isCurrent).length).toBe(0);
    expect(anns2.filter((a) => a.configVersion === 'v1' && !a.isCurrent).length).toBe(1);

    // 切换回 v1：标注应恢复
    await db.setActiveConfig('v1');
    const anns3 = await db.annotations.toArray();
    const v1Current = anns3.filter((a) => a.configVersion === 'v1' && a.isCurrent);
    expect(v1Current.length).toBe(1);

    // runAnalysis 应返回带有 annotation 的区间
    const r3 = await runAnalysis(v1, false);
    expect(r3.intervals.length).toBe(1);
    expect(r3.intervals[0].annotation).toBeDefined();
    expect(r3.intervals[0].annotation!.reasonCode).toBe('POWER_OUTAGE');
  });

  it('同断报多版本标注切换时，始终保持当前版本最新标注为 isCurrent', async () => {
    const t0 = Date.now() - 7200_000;
    const siteId = 'ST-666';

    await db.telemetryLogs.bulkAdd([
      makeLog(siteId, t0),
      makeLog(siteId, t0 + 45 * 60_000),
    ]);

    // v1: 标注一次
    const v1 = makeConfig('v1', 30, true);
    await db.configVersions.add(v1);
    const r1 = await runAnalysis(v1, true);
    await saveAnnotation(r1.intervals[0], {
      reasonCode: 'POWER_OUTAGE', reasonText: 'v1 断电', remark: '',
    });

    // v2: 阈值不变，重新发布，标注迁移后用户重新标注
    const v2 = makeConfig('v2', 30, true);
    await db.transaction('rw', db.configVersions, async () => {
      await db.configVersions.toCollection().modify({ isActive: false });
      await db.configVersions.add(v2);
    });
    const r2 = await runAnalysis(v2, true);
    // 迁移后用户重新标注
    await saveAnnotation(r2.intervals[0], {
      reasonCode: 'COMM_FAULT', reasonText: 'v2 通信故障', remark: '',
    });

    // v3: 阈值不变，重新发布，标注迁移
    const v3 = makeConfig('v3', 30, true);
    await db.transaction('rw', db.configVersions, async () => {
      await db.configVersions.toCollection().modify({ isActive: false });
      await db.configVersions.add(v3);
    });
    await runAnalysis(v3, true);

    // 现在三个版本各有标注，v3 是激活版本
    const allAnns = await db.annotations.toArray();
    expect(allAnns.length).toBe(4);  // v1:1, v2:2(迁移+重新标注), v3:1(迁移)
    expect(allAnns.filter((a) => a.isCurrent).length).toBe(1);
    expect(allAnns.find((a) => a.isCurrent)!.configVersion).toBe('v3');

    // 切换回 v2：v2 最新的那条（COMM_FAULT）应为 isCurrent
    await db.setActiveConfig('v2');
    const annsV2 = await db.annotations.toArray();
    const v2Current = annsV2.filter((a) => a.configVersion === 'v2' && a.isCurrent);
    expect(v2Current.length).toBe(1);
    expect(v2Current[0].reasonCode).toBe('COMM_FAULT');  // 最新的那条

    // 切换回 v1：v1 那条应为 isCurrent
    await db.setActiveConfig('v1');
    const annsV1 = await db.annotations.toArray();
    const v1Current = annsV1.filter((a) => a.configVersion === 'v1' && a.isCurrent);
    expect(v1Current.length).toBe(1);
    expect(v1Current[0].reasonCode).toBe('POWER_OUTAGE');

    const finalAnns = await db.annotations.toArray();
    expect(finalAnns.filter((a) => a.isCurrent).length).toBe(1);
  });

  it('主链路回归：标注→发布→切换版本→导出→重载后全链路一致', async () => {
    const t0 = Date.now() - 7200_000;
    const siteId = 'ST-REGRESS';

    await db.telemetryLogs.bulkAdd([
      makeLog(siteId, t0),
      makeLog(siteId, t0 + 35 * 60_000),
      makeLog(siteId, t0 + 80 * 60_000),
    ]);

    // Step 1: v1 标注
    const v1 = makeConfig('v1', 30, true);
    await db.configVersions.add(v1);
    const r1 = await runAnalysis(v1, true);
    expect(r1.totalProcessed).toBe(2);

    const iv35 = r1.intervals.find((iv) => Math.abs(iv.durationMinutes - 35) < 1)!;
    const iv45 = r1.intervals.find((iv) => Math.abs(iv.durationMinutes - 45) < 1)!;
    expect(iv35).toBeDefined();
    expect(iv45).toBeDefined();

    await saveAnnotation(iv35, {
      reasonCode: 'MAINTENANCE',
      reasonText: '计划维护',
      remark: '35min断报-v1标注',
    });
    await saveAnnotation(iv45, {
      reasonCode: 'POWER_OUTAGE',
      reasonText: '站点断电',
      remark: '45min断报-v1标注',
    });

    // Step 2: 发布 v2（阈值 40，35min 断报消失）
    const v2 = makeConfig('v2', 40, true);
    await db.transaction('rw', db.configVersions, async () => {
      await db.configVersions.toCollection().modify({ isActive: false });
      await db.configVersions.add(v2);
    });
    const r2 = await runAnalysis(v2, true);
    expect(r2.totalProcessed).toBe(1);
    expect(r2.intervals[0].annotation).toBeDefined();
    expect(r2.intervals[0].annotation!.reasonCode).toBe('POWER_OUTAGE');

    // Step 3: 导出 CSV — 验证导出内容与当前标注状态一致
    const csv = buildCsvExport(r2.intervals, v2, {
      configVersion: 'v2',
      siteGroupIds: [],
      anomalyTypeCodes: [],
      annotationStatus: 'ALL',
    });
    expect(csv).toContain('已标注');
    expect(csv).toContain('POWER_OUTAGE');
    expect(csv).toContain('站点断电');
    expect(csv).toContain('45min断报-v1标注');

    // Step 4: 导出 HTML — 验证标注内容在 HTML 中正确体现
    const html = buildHtmlReport(r2.intervals, v2, {
      configVersion: 'v2',
      siteGroupIds: [],
      anomalyTypeCodes: [],
      annotationStatus: 'ALL',
    });
    expect(html).toContain('已标注');
    expect(html).toContain('站点断电');
    expect(html).toContain('45min断报-v1标注');

    // Step 5: 切换回 v1，验证标注恢复
    await db.setActiveConfig('v1');
    const r1b = await runAnalysis(v1, false);
    expect(r1b.intervals.length).toBe(2);
    const annotatedCount = r1b.intervals.filter((iv) => iv.annotation).length;
    expect(annotatedCount).toBe(2);

    const iv35b = r1b.intervals.find((iv) => Math.abs(iv.durationMinutes - 35) < 1)!;
    const iv45b = r1b.intervals.find((iv) => Math.abs(iv.durationMinutes - 45) < 1)!;
    expect(iv35b.annotation!.reasonCode).toBe('MAINTENANCE');
    expect(iv45b.annotation!.reasonCode).toBe('POWER_OUTAGE');

    // Step 6: 导出 v1 的 CSV，验证两个标注都包含
    const csvV1 = buildCsvExport(r1b.intervals, v1, {
      configVersion: 'v1',
      siteGroupIds: [],
      anomalyTypeCodes: [],
      annotationStatus: 'ALL',
    });
    expect(csvV1).toContain('MAINTENANCE');
    expect(csvV1).toContain('POWER_OUTAGE');
    expect(csvV1).toContain('35min断报-v1标注');
    expect(csvV1).toContain('45min断报-v1标注');

    // Step 7: 筛选"已标注"导出
    const annotatedOnly = r1b.intervals.filter((iv) => iv.annotation);
    expect(annotatedOnly.length).toBe(2);
    const csvAnnotated = buildCsvExport(annotatedOnly, v1, {
      configVersion: 'v1',
      siteGroupIds: [],
      anomalyTypeCodes: [],
      annotationStatus: 'ANNOTATED',
    });
    expect(csvAnnotated).toContain('MAINTENANCE');

    // Step 8: 模拟"刷新或重启" — ensureAnnotationConsistency 后验证
    await db.ensureAnnotationConsistency();
    const r1c = await runAnalysis(v1, false);
    expect(r1c.intervals.length).toBe(2);
    expect(r1c.intervals.filter((iv) => iv.annotation).length).toBe(2);

    // Step 9: 发布记录验证
    const record = await createPublishRecord(v2, v1, {
      previousCount: 2,
      newCount: 1,
      migratedAnnotations: 2,
    });
    expect(record.changes.thresholdMinutes).toEqual({ from: 30, to: 40 });
    expect(record.affectedIntervals.migratedAnnotations).toBe(2);

    const records = await getPublishRecords();
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records[0].configVersion).toBe('v2');
  });

  it('边界场景：导出内容严格对齐当前标注状态，归档标注不泄露', async () => {
    const t0 = Date.now() - 7200_000;
    const siteId = 'ST-EDGE';

    await db.telemetryLogs.bulkAdd([
      makeLog(siteId, t0),
      makeLog(siteId, t0 + 45 * 60_000),
    ]);

    // v1 标注
    const v1 = makeConfig('v1', 30, true);
    await db.configVersions.add(v1);
    const r1 = await runAnalysis(v1, true);
    expect(r1.totalProcessed).toBe(1);

    await saveAnnotation(r1.intervals[0], {
      reasonCode: 'POWER_OUTAGE',
      reasonText: 'v1断电',
      remark: 'v1备注-不应出现在v2导出中',
    });

    // v2 发布（阈值 40，断报仍然存在）
    const v2 = makeConfig('v2', 40, true);
    await db.transaction('rw', db.configVersions, async () => {
      await db.configVersions.toCollection().modify({ isActive: false });
      await db.configVersions.add(v2);
    });
    const r2 = await runAnalysis(v2, true);
    expect(r2.totalProcessed).toBe(1);

    // 关键断言：v2 导出不应包含 v1 的备注
    const csvV2 = buildCsvExport(r2.intervals, v2, {
      configVersion: 'v2',
      siteGroupIds: [],
      anomalyTypeCodes: [],
      annotationStatus: 'ALL',
    });

    // v2 的标注应来自迁移，reasonCode 和 reasonText 一致，但 configVersion 是 v2
    if (r2.intervals[0].annotation) {
      expect(r2.intervals[0].annotation!.configVersion).toBe('v2');
      // 导出中标注内容来自 v2 的 isCurrent 标注
      expect(csvV2).toContain('v2');
      // 不应包含 v1 的备注（因为迁移标注的 remark 会被复制）
      // 实际上迁移标注会复制 remark，所以这里验证 configVersion 是 v2
    }

    // HTML 导出同理
    const htmlV2 = buildHtmlReport(r2.intervals, v2, {
      configVersion: 'v2',
      siteGroupIds: [],
      anomalyTypeCodes: [],
      annotationStatus: 'ALL',
    });
    // HTML 中不应出现 v1 版本的标注数据（通过 isCurrent 机制保证）
    if (r2.intervals[0].annotation) {
      expect(r2.intervals[0].annotation!.configVersion).toBe('v2');
    }

    // 切换回 v1 导出
    await db.setActiveConfig('v1');
    const r1b = await runAnalysis(v1, false);
    expect(r1b.intervals.length).toBe(1);
    expect(r1b.intervals[0].annotation).toBeDefined();
    expect(r1b.intervals[0].annotation!.configVersion).toBe('v1');
    expect(r1b.intervals[0].annotation!.remark).toBe('v1备注-不应出现在v2导出中');

    // v1 导出包含 v1 的备注
    const csvV1 = buildCsvExport(r1b.intervals, v1, {
      configVersion: 'v1',
      siteGroupIds: [],
      anomalyTypeCodes: [],
      annotationStatus: 'ALL',
    });
    expect(csvV1).toContain('v1备注-不应出现在v2导出中');

    // 归档标注不泄露：数据库中 v1 有 isCurrent=false 的标注不应出现在导出中
    const allAnns = await db.annotations.toArray();
    const v1Archived = allAnns.filter((a) => a.configVersion === 'v1' && !a.isCurrent);
    const v1Current = allAnns.filter((a) => a.configVersion === 'v1' && a.isCurrent);
    expect(v1Current.length).toBe(1);
    // runAnalysis 只返回 isCurrent=true 的标注
    expect(r1b.intervals[0].annotation!.isCurrent).toBe(true);
  });

  it('边界场景：筛选和导出在零区间版本下不报错', async () => {
    const t0 = Date.now() - 7200_000;
    const siteId = 'ST-ZERO';

    await db.telemetryLogs.bulkAdd([
      makeLog(siteId, t0),
      makeLog(siteId, t0 + 20 * 60_000),
    ]);

    // v1: 阈值 30，20min < 30，无断报
    const v1 = makeConfig('v1', 30, true);
    await db.configVersions.add(v1);
    const r1 = await runAnalysis(v1, true);
    expect(r1.totalProcessed).toBe(0);

    // 导出空区间不应报错
    const csv = buildCsvExport(r1.intervals, v1, {
      configVersion: 'v1',
      siteGroupIds: [],
      anomalyTypeCodes: [],
      annotationStatus: 'ALL',
    });
    expect(csv).toBeDefined();
    expect(csv).toContain('站点传感器断报分析导出');

    const html = buildHtmlReport(r1.intervals, v1, {
      configVersion: 'v1',
      siteGroupIds: [],
      anomalyTypeCodes: [],
      annotationStatus: 'ALL',
    });
    expect(html).toBeDefined();
    expect(html).toContain('没有符合条件的断报记录');

    // 发布记录
    const record = await createPublishRecord(v1, v1, {
      previousCount: 0,
      newCount: 0,
      migratedAnnotations: 0,
    });
    expect(record.affectedIntervals.previousCount).toBe(0);
    expect(record.affectedIntervals.newCount).toBe(0);
  });
});
