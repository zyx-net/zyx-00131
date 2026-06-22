import { describe, it, expect, beforeEach } from 'vitest';
import { db, DEFAULT_CONFIG, AppDatabase } from '@/db';
import { generateSampleCsv, injectSampleIntoDB } from '@/sample/generator';
import { runAnalysis, filterIntervals } from '@/services/analyzer';
import { saveAnnotation, getAnnotationHistory } from '@/services/annotation';
import {
  buildCsvExport,
  buildHtmlReport,
  buildAndExportErrorsCsv,
  buildFilterSnapshotCsv,
  saveExportRecord,
} from '@/services/exporter';
import type { ConfigVersion, FilterState } from '@/types';
import { uid } from '@/utils';

async function clearDb(db: AppDatabase) {
  await Promise.all([
    db.annotations.clear(),
    db.outageIntervals.clear(),
    db.telemetryLogs.clear(),
    db.errorRows.clear(),
    db.exportRecords.clear(),
    db.configVersions.clear(),
  ]);
}

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

describe('主流程冒烟测试（按 README 复现）', () => {
  beforeEach(async () => {
    await clearDb(db);
  });

  it('样例数据注入 + 默认配置下主流程跑通', async () => {
    // ===== 1. 初始化默认配置（模拟首次启动）=====
    const v1 = makeConfig('v1', 30, true);
    await db.configVersions.add(v1);
    const active = await db.getActiveConfig();
    expect(active).toBeDefined();
    expect(active!.thresholdMinutes).toBe(30);

    // ===== 2. 生成样例数据（seed=42 确定性）=====
    const sample = generateSampleCsv({ seed: 42 });
    expect(sample.siteIds.length).toBe(6);            // ST-001 ~ ST-006
    expect(sample.csvPart1.length).toBeGreaterThan(1000);
    expect(sample.csvPart2.length).toBeGreaterThan(1000);

    // ===== 3. 注入到 DB（走完整 importFiles 链路）=====
    const before = await db.telemetryLogs.count();
    const result = await injectSampleIntoDB(sample);
    const after = await db.telemetryLogs.count();
    expect(before).toBe(0);
    expect(after).toBeGreaterThan(4000);                // 去重后约 4600+
    expect(after - before).toBe(result.logsAfter - result.logsBefore);

    // ===== 4. 跑断报分析 =====
    const analysis = await runAnalysis(v1, false);
    expect(analysis.totalProcessed).toBeGreaterThanOrEqual(8);  // 预计 10 左右
    expect(analysis.intervals.length).toBe(analysis.totalProcessed);
    // 每个区间都有正确的配置版本和站点ID
    for (const iv of analysis.intervals) {
      expect(iv.configVersion).toBe('v1');
      expect(iv.siteId).toMatch(/^ST-\d{3}$/);
      expect(iv.durationMinutes).toBeGreaterThanOrEqual(30);
    }

    // ===== 5. 错误报告（报告中心可达性）=====
    const errors = await db.errorRows.orderBy('createdAt').reverse().toArray();
    expect(errors.length).toBeGreaterThanOrEqual(20);  // 32 左右
    const missing = errors.filter((e) => e.errorType === 'MISSING_FIELD').length;
    const inverted = errors.filter((e) => e.errorType === 'TIME_INVERSION').length;
    expect(missing).toBeGreaterThan(0);
    expect(inverted).toBeGreaterThan(0);

    // buildAndExportErrorsCsv 可调用（不抛错）
    const errCsv = await buildAndExportErrorsCsv('v1');
    expect(errCsv.length).toBeGreaterThan(100);
    expect(errCsv).toContain('错误行报告');
    expect(errCsv).toContain('字段缺失');
    expect(errCsv).toContain('时间倒置');

    // ===== 6. 给任意一条断报标注 =====
    const target = analysis.intervals.find((iv) => iv.durationMinutes >= 45)!;  // 找长于 45min 的
    expect(target).toBeDefined();

    const ann1 = await saveAnnotation(target, {
      reasonCode: 'POWER_OUTAGE',
      reasonText: '站点断电',
      remark: '测试标注',
    });
    expect(ann1.isCurrent).toBe(true);
    expect(ann1.configVersion).toBe('v1');
    expect(ann1.siteId).toBe(target.siteId);

    // 标注后重新拉取 → annotation 存在
    const afterAnn = await runAnalysis(v1, false);
    const withAnn = afterAnn.intervals.find((iv) => iv.id === target.id);
    expect(withAnn?.annotation).toBeDefined();
    expect(withAnn!.annotation!.reasonCode).toBe('POWER_OUTAGE');

    // ===== 7. 筛选接口可达 =====
    const emptyFilter: FilterState = {
      timeRange: null,
      siteGroupIds: [],
      anomalyTypeCodes: [],
      annotationStatus: 'ALL',
      keyword: '',
    };
    const filteredAll = filterIntervals(afterAnn.intervals, emptyFilter);
    expect(filteredAll.length).toBe(afterAnn.intervals.length);

    const filteredAnnotated = filterIntervals(afterAnn.intervals, {
      ...emptyFilter,
      annotationStatus: 'ANNOTATED',
    });
    expect(filteredAnnotated.length).toBeGreaterThanOrEqual(1);

    const filteredUnannotated = filterIntervals(afterAnn.intervals, {
      ...emptyFilter,
      annotationStatus: 'UNANNOTATED',
    });
    expect(filteredUnannotated.length).toBe(filteredAll.length - filteredAnnotated.length);

    // ===== 8. 导出接口（CSV + HTML + 导出记录保存）=====
    const csvContent = buildCsvExport(filteredAnnotated, v1, emptyFilter);
    expect(csvContent).toContain('断报ID');
    expect(csvContent).toContain('已标注');
    expect(csvContent).toContain('POWER_OUTAGE');
    expect(csvContent).toContain('站点断电');

    const htmlContent = buildHtmlReport(filteredAnnotated, v1, emptyFilter);
    expect(htmlContent).toContain('<html');
    expect(htmlContent).toContain('已标注');

    // CSV 自带筛选条件元数据
    expect(csvContent).toContain('标注筛选:');
    expect(csvContent).toContain('配置版本:');

    // 保存导出记录 → 报告中心可查
    const savedRec = await saveExportRecord(
      'CSV',
      `test-export-${Date.now()}.csv`,
      csvContent,
      v1,
      emptyFilter,
      filteredAnnotated,
    );
    expect(savedRec).toBeTruthy();
    expect(savedRec.id).toBeTruthy();
    const saved = await db.exportRecords.get(savedRec.id);
    expect(saved).toBeDefined();
    expect(saved!.configVersion).toBe('v1');
    expect(saved!.fileType).toBe('CSV');
    expect(saved!.summary.totalIntervals).toBe(filteredAnnotated.length);

    // ===== 9. 历史面板可达性 =====
    const history = await getAnnotationHistory(target.id);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].id).toBe(ann1.id);
  });

  it('README 验收场景 4：改阈值发布 → 旧标注归档 → 弹窗历史 ≥ 2 条', async () => {
    // ===== 初始化 + 样例 =====
    const v1 = makeConfig('v1', 30, true);
    await db.configVersions.add(v1);
    const sample = generateSampleCsv({ seed: 42 });
    await injectSampleIntoDB(sample);
    const r1 = await runAnalysis(v1, false);

    // 找一条 ≥45min 的断报
    const target = r1.intervals.find((iv) => iv.durationMinutes >= 45)!;
    expect(target).toBeDefined();

    // ===== v1 标注 =====
    await saveAnnotation(target, {
      reasonCode: 'POWER_OUTAGE',
      reasonText: 'v1 站点断电',
      remark: 'v1 版本的结论',
    });

    // ===== 发布 v2，阈值 40 =====
    const v2 = makeConfig('v2', 40, true);
    await db.transaction('rw', db.configVersions, async () => {
      await db.configVersions.toCollection().modify({ isActive: false });
      await db.configVersions.add(v2);
    });

    // 重新计算（forceRecompute=true，会做迁移归档）
    const r2 = await runAnalysis(v2, true);
    // 阈值变大，区间数减少
    expect(r2.totalProcessed).toBeLessThanOrEqual(r1.totalProcessed);
    expect(r2.totalProcessed).toBeGreaterThan(0);

    // 找到 v2 中对应同一段断报（同站点 + 开始时间接近）
    const targetV2 = r2.intervals.find(
      (iv) => iv.siteId === target.siteId && Math.abs(iv.startTime - target.startTime) < 60_000,
    );
    // 45min ≥ 40，所以这条应该仍然存在
    expect(targetV2).toBeDefined();

    // ===== 关键验证 1：v2 的区间有迁移后的标注 =====
    expect(targetV2!.annotation).toBeDefined();
    expect(targetV2!.annotation!.isCurrent).toBe(true);
    expect(targetV2!.annotation!.configVersion).toBe('v2');

    // ===== 关键验证 2：数据库里同断报只有 1 条 isCurrent=true =====
    const allAnns = await db.annotations.toArray();
    const sameOutage = allAnns.filter(
      (a) => a.siteId === target.siteId && Math.abs(a.startTime - target.startTime) < 60_000,
    );
    const currentOnes = sameOutage.filter((a) => a.isCurrent);
    expect(currentOnes.length).toBe(1);
    expect(currentOnes[0].configVersion).toBe('v2');
    const archived = sameOutage.filter((a) => !a.isCurrent);
    expect(archived.length).toBeGreaterThanOrEqual(1);  // v1 的那条被归档

    // ===== 关键验证 3：getAnnotationHistory 返回 ≥ 2 条（不是 0 条！）=====
    const hist = await getAnnotationHistory(targetV2!.id);
    expect(hist.length).toBeGreaterThanOrEqual(2);  // v1 + v2 至少 2 条

    // 历史里 current 的数量 = 1
    const histCurrent = hist.filter((h) => h.isCurrent);
    expect(histCurrent.length).toBe(1);
    expect(histCurrent[0].configVersion).toBe('v2');

    // ===== 关键验证 4：手动再标一次 v2 → saveAnnotation 先归档 v2 迁移的 =====
    await saveAnnotation(targetV2!, {
      reasonCode: 'COMM_FAULT',
      reasonText: 'v2 通信故障',
      remark: 'v2 版本重新标注',
    });

    const allAfter2 = await db.annotations.toArray();
    const sameOutage2 = allAfter2.filter(
      (a) => a.siteId === target.siteId && Math.abs(a.startTime - target.startTime) < 60_000,
    );
    const current2 = sameOutage2.filter((a) => a.isCurrent);
    expect(current2.length).toBe(1);
    expect(current2[0].reasonCode).toBe('COMM_FAULT');
    // 历史 ≥ 3 条（v1 + v2 迁移 + v2 手动）
    const hist2 = await getAnnotationHistory(targetV2!.id);
    expect(hist2.length).toBeGreaterThanOrEqual(3);

    // ===== 关键验证 5：筛选 / 导出状态一致 =====
    const r3 = await runAnalysis(v2, false);
    const target3 = r3.intervals.find((iv) => iv.id === targetV2!.id)!;
    expect(target3.annotation).toBeDefined();
    expect(target3.annotation!.reasonCode).toBe('COMM_FAULT');  // 三端统一是最新结论

    // 筛选已标注 → 找到目标
    const annotated = filterIntervals(r3.intervals, {
      timeRange: null,
      siteGroupIds: [],
      anomalyTypeCodes: [],
      annotationStatus: 'ANNOTATED',
      keyword: '',
    });
    const found = annotated.find((iv) => iv.id === targetV2!.id);
    expect(found).toBeDefined();
    expect(found!.annotation!.reasonCode).toBe('COMM_FAULT');

    // 导出 CSV → 标注状态一致
    const csv = buildCsvExport(annotated, v2, {
      timeRange: null,
      siteGroupIds: [],
      anomalyTypeCodes: [],
      annotationStatus: 'ANNOTATED',
      keyword: '',
    });
    expect(csv).toContain('已标注');
    expect(csv).toContain('COMM_FAULT');
  });
});
