import type { Annotation, OutageInterval } from '@/types';
import { db } from '@/db';
import { uid } from '@/utils';

export async function saveAnnotation(
  interval: OutageInterval,
  payload: {
    reasonCode: string;
    reasonText: string;
    remark?: string;
  },
  by = 'local-user',
): Promise<Annotation> {
  return await db.transaction('rw', db.annotations, async () => {
    await archiveOutageCurrentAnnotations(interval.siteId, interval.startTime);
    const ann: Annotation = {
      id: uid('ann'),
      outageIntervalId: interval.id,
      configVersion: interval.configVersion,
      reasonCode: payload.reasonCode,
      reasonText: payload.reasonText,
      remark: payload.remark ?? '',
      annotatedAt: Date.now(),
      annotatedBy: by,
      isCurrent: true,
      siteId: interval.siteId,
      startTime: interval.startTime,
    };
    await db.annotations.add(ann);
    return ann;
  });
}

export const ANNOTATION_TOLERANCE_MS = 60_000;

export async function archiveOutageCurrentAnnotations(
  siteId: string,
  startTime: number,
  tolerance = ANNOTATION_TOLERANCE_MS,
): Promise<number> {
  const all = await db.annotations.toArray();
  const toArchive: string[] = [];
  for (const a of all) {
    let aSiteId = a.siteId;
    let aStartTime = a.startTime;
    if (aSiteId === undefined || aStartTime === undefined) {
      const iv = await db.outageIntervals.get(a.outageIntervalId);
      if (!iv) continue;
      aSiteId = iv.siteId;
      aStartTime = iv.startTime;
      await db.annotations.update(a.id, { siteId: aSiteId, startTime: aStartTime });
    }
    if (a.isCurrent && aSiteId === siteId && Math.abs(aStartTime - startTime) < tolerance) {
      toArchive.push(a.id);
    }
  }
  if (toArchive.length > 0) {
    await db.annotations.bulkUpdate(
      toArchive.map((id) => ({ key: id, changes: { isCurrent: false } })),
    );
  }
  return toArchive.length;
}

export async function getAnnotationHistory(intervalId: string): Promise<Annotation[]> {
  const targetIv = await db.outageIntervals.get(intervalId);
  const TOL = ANNOTATION_TOLERANCE_MS;
  const all = await db.annotations.toArray();

  if (!targetIv) {
    // 区间不存在，只按 outageIntervalId 精确匹配
    return all.filter((a) => a.outageIntervalId === intervalId).sort((a, b) => b.annotatedAt - a.annotatedAt);
  }

  const matched: Annotation[] = [];
  const seenIds = new Set<string>();

  // 1) 精确 outageIntervalId 匹配（直接匹配当前区间的标注）
  for (const a of all) {
    if (a.outageIntervalId === intervalId) {
      matched.push(a);
      seenIds.add(a.id);
    }
  }

  // 2) 容差匹配：siteId + startTime±60s（跨版本同一断报的标注）
  for (const a of all) {
    if (seenIds.has(a.id)) continue;
    let aSiteId = a.siteId;
    let aStartTime = a.startTime;
    // 旧数据可能没有冗余字段，尝试从它的 outageIntervalId 反查
    if (aSiteId === undefined || aStartTime === undefined) {
      const oldIv = await db.outageIntervals.get(a.outageIntervalId);
      if (oldIv) {
        aSiteId = oldIv.siteId;
        aStartTime = oldIv.startTime;
        await db.annotations.update(a.id, { siteId: aSiteId, startTime: aStartTime });
      }
    }
    if (aSiteId && aStartTime !== undefined
        && aSiteId === targetIv.siteId
        && Math.abs(aStartTime - targetIv.startTime) < TOL) {
      matched.push(a);
      seenIds.add(a.id);
    }
  }

  matched.sort((a, b) => b.annotatedAt - a.annotatedAt);

  // 兜底：多条当前标注时自动保留最新一条，其余归档
  const currentOnes = matched.filter((a) => a.isCurrent);
  if (currentOnes.length > 1) {
    const toArchive = currentOnes.slice(1).map((a) => a.id);
    await db.transaction('rw', db.annotations, async () => {
      for (const id of toArchive) {
        await db.annotations.update(id, { isCurrent: false });
      }
    });
    for (const a of matched) {
      if (toArchive.includes(a.id)) a.isCurrent = false;
    }
  }
  return matched;
}

export async function updateIntervalAnomalyType(
  intervalId: string,
  anomalyTypeCode: string,
): Promise<void> {
  await db.outageIntervals.update(intervalId, { anomalyTypeCode });
}
