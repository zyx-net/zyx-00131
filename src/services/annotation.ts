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
  const existingCurrent = await db.annotations
    .where('outageIntervalId')
    .equals(interval.id)
    .filter((a) => a.configVersion === interval.configVersion && a.isCurrent)
    .first();

  return await db.transaction('rw', db.annotations, async () => {
    if (existingCurrent) {
      await db.annotations.update(existingCurrent.id, { isCurrent: false });
    }
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

export async function getAnnotationHistory(intervalId: string): Promise<Annotation[]> {
  const targetIv = await db.outageIntervals.get(intervalId);
  if (!targetIv) {
    const direct = await db.annotations
      .where('outageIntervalId')
      .equals(intervalId)
      .reverse()
      .sortBy('annotatedAt');
    return direct;
  }
  const TOL = 60_000;
  const all = await db.annotations.toArray();
  const matched: Annotation[] = [];
  for (const a of all) {
    let aSiteId = a.siteId;
    let aStartTime = a.startTime;
    if (aSiteId === undefined || aStartTime === undefined) {
      const oldIv = await db.outageIntervals.get(a.outageIntervalId);
      if (!oldIv) continue;
      aSiteId = oldIv.siteId;
      aStartTime = oldIv.startTime;
    }
    if (aSiteId === targetIv.siteId && Math.abs(aStartTime - targetIv.startTime) < TOL) {
      matched.push(a);
    }
  }
  matched.sort((a, b) => b.annotatedAt - a.annotatedAt);
  return matched;
}

export async function updateIntervalAnomalyType(
  intervalId: string,
  anomalyTypeCode: string,
): Promise<void> {
  await db.outageIntervals.update(intervalId, { anomalyTypeCode });
}
