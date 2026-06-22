import type { ConfigVersion, PublishRecord } from '@/types';
import { db } from '@/db';
import { uid } from '@/utils';

export function compareConfigs(
  oldCfg: ConfigVersion,
  newCfg: ConfigVersion,
): PublishRecord['changes'] {
  const changes: PublishRecord['changes'] = {};

  if (oldCfg.thresholdMinutes !== newCfg.thresholdMinutes) {
    changes.thresholdMinutes = {
      from: oldCfg.thresholdMinutes,
      to: newCfg.thresholdMinutes,
    };
  }

  const oldGroupIds = new Set(oldCfg.siteGroups.map((g) => g.id));
  const newGroupIds = new Set(newCfg.siteGroups.map((g) => g.id));
  const addedGroups = [...newGroupIds].filter((id) => !oldGroupIds.has(id));
  const removedGroups = [...oldGroupIds].filter((id) => !newGroupIds.has(id));
  const modifiedGroups: string[] = [];
  for (const g of newCfg.siteGroups) {
    if (oldGroupIds.has(g.id)) {
      const oldG = oldCfg.siteGroups.find((og) => og.id === g.id)!;
      if (JSON.stringify(oldG) !== JSON.stringify(g)) {
        modifiedGroups.push(g.id);
      }
    }
  }
  if (addedGroups.length > 0 || removedGroups.length > 0 || modifiedGroups.length > 0) {
    changes.siteGroups = {
      added: addedGroups,
      removed: removedGroups,
      modified: modifiedGroups,
    };
  }

  const oldTypeCodes = new Set(oldCfg.anomalyTypes.map((t) => t.code));
  const newTypeCodes = new Set(newCfg.anomalyTypes.map((t) => t.code));
  const addedTypes = [...newTypeCodes].filter((code) => !oldTypeCodes.has(code));
  const removedTypes = [...oldTypeCodes].filter((code) => !newTypeCodes.has(code));
  const modifiedTypes: string[] = [];
  for (const t of newCfg.anomalyTypes) {
    if (oldTypeCodes.has(t.code)) {
      const oldT = oldCfg.anomalyTypes.find((ot) => ot.code === t.code)!;
      if (JSON.stringify(oldT) !== JSON.stringify(t)) {
        modifiedTypes.push(t.code);
      }
    }
  }
  if (addedTypes.length > 0 || removedTypes.length > 0 || modifiedTypes.length > 0) {
    changes.anomalyTypes = {
      added: addedTypes,
      removed: removedTypes,
      modified: modifiedTypes,
    };
  }

  const other: string[] = [];
  if (oldCfg.timeField !== newCfg.timeField) {
    other.push(`时间字段: ${oldCfg.timeField} → ${newCfg.timeField}`);
  }
  if (oldCfg.timeFormat !== newCfg.timeFormat) {
    other.push(`时间格式: ${oldCfg.timeFormat} → ${newCfg.timeFormat}`);
  }
  if (JSON.stringify(oldCfg.dedupeFields) !== JSON.stringify(newCfg.dedupeFields)) {
    other.push(`去重字段: [${oldCfg.dedupeFields.join(', ')}] → [${newCfg.dedupeFields.join(', ')}]`);
  }
  if (oldCfg.name !== newCfg.name) {
    other.push(`配置名称: ${oldCfg.name} → ${newCfg.name}`);
  }
  if (other.length > 0) {
    changes.other = other;
  }

  return changes;
}

export async function createPublishRecord(
  newCfg: ConfigVersion,
  oldCfg: ConfigVersion | null,
  affectedIntervals: PublishRecord['affectedIntervals'],
  by = 'local-user',
): Promise<PublishRecord> {
  const changes = oldCfg ? compareConfigs(oldCfg, newCfg) : { other: ['初始配置发布'] };
  const record: PublishRecord = {
    id: uid('pub'),
    configVersion: newCfg.id,
    configName: newCfg.name,
    previousConfigVersion: oldCfg?.id || null,
    changes,
    affectedIntervals,
    createdAt: Date.now(),
    publishedBy: by,
  };
  await db.publishRecords.add(record);
  return record;
}

export async function getPublishRecords(): Promise<PublishRecord[]> {
  return await db.publishRecords.orderBy('createdAt').reverse().toArray();
}

export function formatChangeSummary(record: PublishRecord): string {
  const parts: string[] = [];
  const c = record.changes;
  if (c.thresholdMinutes) {
    parts.push(`阈值 ${c.thresholdMinutes.from}→${c.thresholdMinutes.to}分钟`);
  }
  if (c.siteGroups) {
    const g = c.siteGroups;
    if (g.added.length > 0) parts.push(`+${g.added.length}分组`);
    if (g.removed.length > 0) parts.push(`-${g.removed.length}分组`);
    if (g.modified.length > 0) parts.push(`±${g.modified.length}分组`);
  }
  if (c.anomalyTypes) {
    const t = c.anomalyTypes;
    if (t.added.length > 0) parts.push(`+${t.added.length}类型`);
    if (t.removed.length > 0) parts.push(`-${t.removed.length}类型`);
    if (t.modified.length > 0) parts.push(`±${t.modified.length}类型`);
  }
  if (c.other && c.other.length > 0) {
    parts.push(`${c.other.length}项其他变更`);
  }
  return parts.length > 0 ? parts.join(' · ') : '无配置变更';
}
