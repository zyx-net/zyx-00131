import type {
  Annotation,
  ConfigVersion,
  FilterState,
  IntervalWithAnnotation,
  OutageInterval,
} from '@/types';
import { db } from '@/db';
import { hashString, uid } from '@/utils';

export interface AnalysisResult {
  intervals: IntervalWithAnnotation[];
  totalProcessed: number;
  recomputed: boolean;
}

function getSiteGroupId(siteId: string, config: ConfigVersion): string {
  for (const g of config.siteGroups) {
    if (g.siteIds.includes(siteId)) return g.id;
  }
  return 'default';
}

function intervalId(configId: string, siteId: string, startTime: number): string {
  return `out_${hashString(`${configId}|${siteId}|${startTime}`)}`;
}

export async function computeOutageIntervals(
  config: ConfigVersion,
): Promise<OutageInterval[]> {
  const thresholdMs = config.thresholdMinutes * 60 * 1000;
  const allLogs = await db.telemetryLogs.orderBy('timestamp').toArray();

  const bySite = new Map<string, typeof allLogs>();
  for (const log of allLogs) {
    if (!bySite.has(log.siteId)) bySite.set(log.siteId, []);
    bySite.get(log.siteId)!.push(log);
  }

  const result: OutageInterval[] = [];
  for (const [siteId, logs] of bySite) {
    logs.sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 1; i < logs.length; i++) {
      const prev = logs[i - 1];
      const curr = logs[i];
      const gap = curr.timestamp - prev.timestamp;
      if (gap > thresholdMs) {
        const atCode = 'COMM_LOST';
        result.push({
          id: intervalId(config.id, siteId, prev.timestamp),
          configVersion: config.id,
          siteId,
          siteGroupId: getSiteGroupId(siteId, config),
          anomalyTypeCode: config.anomalyTypes.some((t) => t.code === atCode) ? atCode : config.anomalyTypes[0]?.code || 'UNKNOWN',
          startTime: prev.timestamp,
          endTime: curr.timestamp,
          durationMinutes: Math.round(gap / 60000 * 10) / 10,
          firstLogId: prev.id,
          lastLogId: curr.id,
        });
      }
    }
  }
  result.sort((a, b) => a.startTime - b.startTime);
  return result;
}

export async function runAnalysis(config: ConfigVersion, forceRecompute = false): Promise<AnalysisResult> {
  const existing = await db.outageIntervals.where('configVersion').equals(config.id).count();
  let recomputed = false;
  if (forceRecompute || existing === 0) {
    const computed = await computeOutageIntervals(config);
    await db.transaction('rw', db.outageIntervals, db.annotations, async () => {
      await db.outageIntervals.where('configVersion').equals(config.id).delete();
      if (computed.length > 0) {
        await db.outageIntervals.bulkPut(computed);
      }
      if (forceRecompute) {
        await db.annotations.where('configVersion').equals(config.id).modify({ isCurrent: false });
        const allAnnots = await db.annotations.toArray();
        const oldAnnots = allAnnots.filter((a) => a.configVersion !== config.id);
        if (oldAnnots.length > 0) {
          const enriched: Array<{ ann: Annotation; siteId: string; startTime: number }> = [];
          for (const a of oldAnnots) {
            let sId = a.siteId;
            let sTime = a.startTime;
            if (sId === undefined || sTime === undefined) {
              const oldIv = await db.outageIntervals.get(a.outageIntervalId);
              if (!oldIv) continue;
              sId = oldIv.siteId;
              sTime = oldIv.startTime;
            }
            enriched.push({ ann: a, siteId: sId, startTime: sTime });
          }
          const TOL = 60_000;
          const toCopy: Annotation[] = [];
          for (const iv of computed) {
            const match = enriched.find(
              (e) => e.siteId === iv.siteId && Math.abs(e.startTime - iv.startTime) < TOL,
            );
            if (match) {
              toCopy.push({
                ...match.ann,
                id: uid('ann'),
                outageIntervalId: iv.id,
                configVersion: config.id,
                annotatedAt: Date.now(),
                isCurrent: true,
                siteId: iv.siteId,
                startTime: iv.startTime,
              });
            }
          }
          if (toCopy.length > 0) await db.annotations.bulkAdd(toCopy);
        }
      }
    });
    recomputed = true;
  }
  const intervals = await db.outageIntervals.where('configVersion').equals(config.id).toArray();
  const ivIds = intervals.map((iv) => iv.id);
  const annMap = new Map<string, Annotation>();
  if (ivIds.length > 0) {
    const anns = await db.annotations
      .where('outageIntervalId')
      .anyOf(ivIds)
      .filter((a) => a.configVersion === config.id && a.isCurrent)
      .toArray();
    for (const a of anns) annMap.set(a.outageIntervalId, a);
  }
  const combined: IntervalWithAnnotation[] = intervals.map((iv) => ({
    ...iv,
    annotation: annMap.get(iv.id),
  }));
  return { intervals: combined, totalProcessed: intervals.length, recomputed };
}

export function filterIntervals(
  intervals: IntervalWithAnnotation[],
  filter: FilterState,
): IntervalWithAnnotation[] {
  return intervals.filter((iv) => {
    if (filter.timeRange) {
      const [f, t] = filter.timeRange;
      if (iv.endTime < f || iv.startTime > t) return false;
    }
    if (filter.siteGroupIds.length > 0 && !filter.siteGroupIds.includes(iv.siteGroupId)) {
      return false;
    }
    if (filter.anomalyTypeCodes.length > 0 && !filter.anomalyTypeCodes.includes(iv.anomalyTypeCode)) {
      return false;
    }
    if (filter.annotationStatus === 'ANNOTATED' && !iv.annotation) return false;
    if (filter.annotationStatus === 'UNANNOTATED' && iv.annotation) return false;
    return true;
  });
}
