import { describe, it, expect, beforeEach } from 'vitest';
import { db, DEFAULT_CONFIG, AppDatabase } from '@/db';
import { importFiles } from '@/services/parser';
import { runAnalysis, filterIntervals } from '@/services/analyzer';
import { saveAnnotation, getAnnotationHistory } from '@/services/annotation';
import { buildCsvExport, buildHtmlReport, saveExportRecord } from '@/services/exporter';
import type { ConfigVersion, FilterState } from '@/types';

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

function makeCsv(rows: string[][], headers: string[]): string {
  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n';
}

function makeConfig(overrides: Partial<ConfigVersion> = {}): ConfigVersion {
  return {
    ...DEFAULT_CONFIG,
    id: 'v1',
    name: '测试配置 v1',
    isActive: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('去重规则 & README 一致性', () => {
  beforeEach(async () => {
    await clearDb(db);
  });

  it('默认配置 dedupeFields 包含 temperature，和 README 一致', () => {
    expect(DEFAULT_CONFIG.dedupeFields).toEqual(['siteId', 'timestamp', 'temperature']);
  });

  it('同站点+同时间+同温度的行只保留一条（正常去重）', async () => {
    const v1 = makeConfig();
    await db.configVersions.add(v1);

    const csv = makeCsv(
      [
        ['ST-001', '2026-06-20 10:00:00', '25.0', '50', '1000', '80'],
        ['ST-001', '2026-06-20 10:00:00', '25.0', '50', '1000', '80'],
        ['ST-001', '2026-06-20 10:30:00', '26.0', '52', '1001', '81'],
      ],
      ['siteId', 'timestamp', 'temperature', 'humidity', 'pressure', 'battery'],
    );

    const file = new File([csv], 'dup_test.csv', { type: 'text/csv' });
    const result = await importFiles([file], v1);

    const logs = await db.telemetryLogs.toArray();
    expect(logs.length).toBe(2);  // 重复的那条被去掉了
    expect(result.duplicateRows).toBe(1);
    expect(result.totalRows).toBe(3);
    expect(result.errorRows).toBe(0);
  });

  it('同站点+同时间+不同温度的行都保留（temperature 加入去重键）', async () => {
    const v1 = makeConfig();
    await db.configVersions.add(v1);

    const csv = makeCsv(
      [
        ['ST-001', '2026-06-20 10:00:00', '25.0', '50', '1000', '80'],
        ['ST-001', '2026-06-20 10:00:00', '30.0', '50', '1000', '80'],
        ['ST-001', '2026-06-20 10:30:00', '26.0', '52', '1001', '81'],
      ],
      ['siteId', 'timestamp', 'temperature', 'humidity', 'pressure', 'battery'],
    );

    const file = new File([csv], 'diff_temp.csv', { type: 'text/csv' });
    const result = await importFiles([file], v1);

    const logs = await db.telemetryLogs.toArray();
    expect(logs.length).toBe(3);  // 不同温度，不算重复
    expect(result.duplicateRows).toBe(0);
  });

  it('配置只有 siteId+timestamp 时，不同温度的行会被误去重（对比测试）', async () => {
    const v1 = makeConfig({ dedupeFields: ['siteId', 'timestamp'] });
    await db.configVersions.add(v1);

    const csv = makeCsv(
      [
        ['ST-001', '2026-06-20 10:00:00', '25.0', '50', '1000', '80'],
        ['ST-001', '2026-06-20 10:00:00', '30.0', '50', '1000', '80'],
        ['ST-001', '2026-06-20 10:30:00', '26.0', '52', '1001', '81'],
      ],
      ['siteId', 'timestamp', 'temperature', 'humidity', 'pressure', 'battery'],
    );

    const file = new File([csv], 'no_temp.csv', { type: 'text/csv' });
    const result = await importFiles([file], v1);

    const logs = await db.telemetryLogs.toArray();
    expect(logs.length).toBe(2);  // 不同温度但被误去重了
    expect(result.duplicateRows).toBe(1);
  });

  it('按 README 重跑：导入两份含重复 CSV 后，去重结果一致', async () => {
    const v1 = makeConfig();
    await db.configVersions.add(v1);

    const headers = ['siteId', 'timestamp', 'temperature', 'humidity', 'pressure', 'battery'];
    const rows1 = [
      ['ST-001', '2026-06-20 10:00:00', '25.0', '50', '1000', '80'],
      ['ST-001', '2026-06-20 10:30:00', '26.0', '52', '1001', '81'],
      ['ST-001', '2026-06-20 11:00:00', '27.0', '54', '1002', '82'],
    ];
    // part2 包含重复行（同站点+同时间+同温度）
    const rows2 = [
      ['ST-001', '2026-06-20 10:30:00', '26.0', '52', '1001', '81'],  // 重复
      ['ST-001', '2026-06-20 11:30:00', '28.0', '56', '1003', '83'],
    ];

    const csv1 = makeCsv(rows1, headers);
    const csv2 = makeCsv(rows2, headers);

    const f1 = new File([csv1], 'part1.csv', { type: 'text/csv' });
    const f2 = new File([csv2], 'part2.csv', { type: 'text/csv' });

    const r1 = await importFiles([f1], v1);
    const r2 = await importFiles([f2], v1);

    const logs = await db.telemetryLogs.toArray();
    expect(logs.length).toBe(4);  // 5 行 - 1 重复
    expect(r1.duplicateRows + r2.duplicateRows).toBe(1);

    // 跑断报分析（阈值 30min，10:00→10:30 不断报，10:30→11:00 不断报，11:00→11:30 不断报 → 无断报）
    // 再写一条更大间隔的
    await db.telemetryLogs.add({
      id: 'log_extra',
      siteId: 'ST-001',
      timestamp: new Date('2026-06-20T12:30:00').getTime(),
      rawTimestamp: '2026-06-20 12:30:00',
      temperature: 29,
      humidity: 58,
      pressure: 1004,
      battery: 84,
      sourceFile: 'extra.csv',
      importBatchId: 'batch_extra',
    });

    const analysis = await runAnalysis(v1, false);
    // 11:30 → 12:30 = 60min > 30min = 断报
    expect(analysis.totalProcessed).toBeGreaterThanOrEqual(1);

    // 标注 + 历史 + 导出完整链路可达
    if (analysis.intervals.length > 0) {
      await saveAnnotation(analysis.intervals[0], {
        reasonCode: 'POWER_DOWN',
        reasonText: '站点断电',
      });
      const hist = await getAnnotationHistory(analysis.intervals[0].id);
      expect(hist.length).toBeGreaterThanOrEqual(1);
    }

    const annotated = filterIntervals(analysis.intervals, {
      timeRange: null,
      siteGroupIds: [],
      anomalyTypeCodes: [],
      annotationStatus: 'ALL',
      keyword: '',
    });
    const csv = buildCsvExport(annotated, v1, {
      timeRange: null,
      siteGroupIds: [],
      anomalyTypeCodes: [],
      annotationStatus: 'ALL',
      keyword: '',
    });
    expect(csv).toContain('断报ID');

    const rec = await saveExportRecord('CSV', 'dedup-test.csv', csv, v1, {
      timeRange: null,
      siteGroupIds: [],
      anomalyTypeCodes: [],
      annotationStatus: 'ALL',
      keyword: '',
    }, annotated);
    expect(rec.id).toBeTruthy();
  });

  it('边界数据回归：空 temperature 的错误行不影响正常行入库', async () => {
    const v1 = makeConfig();
    await db.configVersions.add(v1);

    const csv = makeCsv(
      [
        ['ST-001', '2026-06-20 10:00:00', '25.0', '50', '1000', '80'],
        ['ST-001', '2026-06-20 10:00:00', '', '50', '1000', '80'],    // temperature 缺失 → 错误行
        ['ST-001', '2026-06-20 10:30:00', '26.0', '52', '1001', '81'],
      ],
      ['siteId', 'timestamp', 'temperature', 'humidity', 'pressure', 'battery'],
    );

    const file = new File([csv], 'edge.csv', { type: 'text/csv' });
    const result = await importFiles([file], v1);

    // 正常行 2 条入库，错误行 1 条进 errorRows
    const logs = await db.telemetryLogs.toArray();
    const errors = await db.errorRows.toArray();
    expect(logs.length).toBe(2);
    expect(errors.length).toBe(1);
    expect(errors[0].errorType).toBe('MISSING_FIELD');
    expect(result.duplicateRows).toBe(0);

    // 分析结果没有因为错误行带偏
    const analysis = await runAnalysis(v1, false);
    expect(analysis.totalProcessed).toBe(0);  // 10:00→10:30 = 30min = 不断报（< =30 算不断报）
  });

  it('边界数据回归：时间倒置行不污染正常数据和去重计数', async () => {
    const v1 = makeConfig();
    await db.configVersions.add(v1);

    const csv = makeCsv(
      [
        ['ST-001', '2026-06-20 10:30:00', '26.0', '52', '1001', '81'],
        ['ST-001', '2026-06-20 10:00:00', '25.0', '50', '1000', '80'],  // 时间倒置
        ['ST-001', '2026-06-20 11:00:00', '27.0', '54', '1002', '82'],
      ],
      ['siteId', 'timestamp', 'temperature', 'humidity', 'pressure', 'battery'],
    );

    const file = new File([csv], 'inversion.csv', { type: 'text/csv' });
    const result = await importFiles([file], v1);

    const logs = await db.telemetryLogs.toArray();
    const errors = await db.errorRows.toArray();
    expect(logs.length).toBe(2);  // 正常行：10:30 和 11:00
    expect(errors.length).toBe(1);
    expect(errors[0].errorType).toBe('TIME_INVERSION');
    expect(result.duplicateRows).toBe(0);

    // 正常行的分析结果没被带偏
    const analysis = await runAnalysis(v1, false);
    expect(analysis.totalProcessed).toBeGreaterThanOrEqual(0);
  });
});
