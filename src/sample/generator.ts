import type { TelemetryLog } from '@/types';
import { db } from '@/db';
import { hashFields, uid } from '@/utils';
import { importFiles } from '@/services/parser';

const SITE_COUNT = 6;
const SITES_PER_GROUP = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

function pad(n: number, w = 2) {
  return String(n).padStart(w, '0');
}
function iso(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

export interface SampleOptions {
  days?: number;
  intervalMinutes?: number;
  seed?: number;
}

export interface GeneratedSample {
  csvPart1: string;
  csvPart2: string;
  siteIds: string[];
  totalRows: number;
  totalOutages: number;
}

export function generateSampleCsv(opts: SampleOptions = {}): GeneratedSample {
  const days = opts.days ?? 3;
  const intervalMs = (opts.intervalMinutes ?? 5) * 60 * 1000;
  const seed = opts.seed ?? 42;
  const rand = rng(seed);

  const now = Date.now();
  const start = now - days * DAY_MS + 2 * 60 * 60 * 1000;

  const siteIds: string[] = [];
  for (let i = 1; i <= SITE_COUNT; i++) {
    siteIds.push(`ST-${pad(i, 3)}`);
  }
  const groups = ['grp_east', 'grp_west', 'grp_north'];
  const siteToGroup: Record<string, string> = {};
  siteIds.forEach((sid, idx) => {
    siteToGroup[sid] = groups[Math.floor(idx / SITES_PER_GROUP)];
  });

  const headers = ['siteId', 'timestamp', 'temperature', 'humidity', 'pressure', 'battery'];

  // 预规划断报区间：每站点插入 1-2 处"大间隔"（> 30分钟，将被识别为断报）
  type OutagePlan = { siteId: string; gapIdx: number; gapMinutes: number };
  const outagePlans: OutagePlan[] = [];
  const stepsPerDay = Math.floor(DAY_MS / intervalMs);
  for (let s = 0; s < siteIds.length; s++) {
    const siteId = siteIds[s];
    const count = 1 + Math.floor(rand() * 2);
    for (let k = 0; k < count; k++) {
      const gapIdx = Math.floor(stepsPerDay * (0.3 + 0.5 * rand()));
      const gapMinutes = [45, 65, 120, 180][Math.floor(rand() * 4)];
      outagePlans.push({ siteId, gapIdx, gapMinutes });
    }
  }

  // 把每个站点数据按时间分片，跨两份CSV文件，制造重复记录
  const part1Rows: string[][] = [];
  const part2Rows: string[][] = [];
  let total = 0;
  for (let s = 0; s < siteIds.length; s++) {
    const siteId = siteIds[s];
    const siteOutages = outagePlans.filter((p) => p.siteId === siteId);
    const outIdxSet = new Set(siteOutages.map((p) => p.gapIdx));
    const extraGap: Record<number, number> = {};
    siteOutages.forEach((p) => (extraGap[p.gapIdx] = p.gapMinutes));
    void siteToGroup;

    let t = start;
    let idx = 0;
    const splitPoint = start + (days * DAY_MS) / 2;
    while (t < now) {
      const temp = (15 + rand() * 20).toFixed(1);
      const hum = (30 + rand() * 50).toFixed(0);
      const press = (990 + rand() * 40).toFixed(0);
      const batt = (70 + rand() * 30).toFixed(0);
      const row = [siteId, iso(t), temp, hum, press, batt];

      const addToP1 = t <= splitPoint;
      if (addToP1) part1Rows.push(row);
      else part2Rows.push(row);
      total++;

      // 制造"字段缺失"的行（错误行）
      if (rand() < 0.005) {
        const badRow = [siteId, iso(t), '', hum, press, batt]; // temperature缺失
        if (addToP1) part1Rows.push(badRow);
        else part2Rows.push(badRow);
        total++;
      }
      // 制造"时间倒置"行
      if (rand() < 0.004) {
        const badRow = [siteId, iso(t - 3 * 60 * 1000), temp, hum, press, batt];
        if (addToP1) part1Rows.push(badRow);
        else part2Rows.push(badRow);
        total++;
      }
      // 制造"重复记录"：在文件边界前后多写一份
      if (Math.abs(t - splitPoint) < intervalMs * 1.5) {
        if (addToP1) part2Rows.push([...row]); // 写到第二份
        total++;
      }

      // 正常推进
      let step = intervalMs;
      if (outIdxSet.has(idx)) {
        step += extraGap[idx] * 60 * 1000;
      }
      // 偶尔小抖动（<阈值，不算断报）
      if (rand() < 0.02) {
        step += Math.floor(rand() * 15 * 60 * 1000);
      }
      t += step;
      idx++;
    }
  }

  // 轻微洗牌（保持站点内顺序，但整体打乱）
  const toCsv = (rows: string[][]) => {
    return [headers.join(',')].concat(rows.map((r) => r.join(','))).join('\n') + '\n';
  };

  return {
    csvPart1: toCsv(part1Rows),
    csvPart2: toCsv(part2Rows),
    siteIds,
    totalRows: total,
    totalOutages: outagePlans.length,
  };
}

export async function injectSampleIntoDB(
  sample: GeneratedSample,
): Promise<{
  batchId1: string;
  batchId2: string;
  logsBefore: number;
  logsAfter: number;
}> {
  const active = await db.getActiveConfig();
  const before = await db.telemetryLogs.count();

  const f1 = new File([sample.csvPart1], 'telemetry_sample_part1.csv', { type: 'text/csv' });
  const f2 = new File([sample.csvPart2], 'telemetry_sample_part2.csv', { type: 'text/csv' });

  const s1 = await importFiles([f1], active);
  const s2 = await importFiles([f2], active);

  // 更新默认配置的 siteGroups：将站点分配进去
  const groups = active.siteGroups.map((g) => ({ ...g, siteIds: [...g.siteIds] }));
  sample.siteIds.forEach((sid, idx) => {
    const gIdx = Math.floor(idx / 2);
    if (groups[gIdx] && !groups[gIdx].siteIds.includes(sid)) {
      groups[gIdx].siteIds.push(sid);
    }
  });
  await db.configVersions.update(active.id, { siteGroups: groups });

  const after = await db.telemetryLogs.count();
  return { batchId1: s1.batchId, batchId2: s2.batchId, logsBefore: before, logsAfter: after };
}

export function hashRowForLog(row: Record<string, any>, dedupeFields: string[], sourceFile: string, batchId: string): TelemetryLog {
  const siteId = String(row.siteId);
  const timestamp = new Date(row.timestamp).getTime();
  return {
    ...row,
    id: `log_${hashFields({ ...row, timestamp }, dedupeFields)}`,
    siteId,
    timestamp,
    rawTimestamp: row.timestamp,
    sourceFile,
    importBatchId: batchId || uid('batch'),
  };
}
