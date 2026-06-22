import { describe, it, expect, beforeEach } from 'vitest';
import type { Annotation, ConfigVersion, OutageInterval } from '@/types';
import { db, AppDatabase, DEFAULT_CONFIG } from '@/db';
import { saveAnnotation, archiveOutageCurrentAnnotations, getAnnotationHistory } from '@/services/annotation';
import { runAnalysis, computeOutageIntervals } from '@/services/analyzer';
import { uid } from '@/utils';

function makeConfig(id: string, thresholdMinutes: number, isActive = false): ConfigVersion {
  return {
    ...DEFAULT_CONFIG,
    id,
    name: `配置 ${id}`,
    thresholdMinutes,
    isActive,
    createdAt: Date.now(),
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
});
