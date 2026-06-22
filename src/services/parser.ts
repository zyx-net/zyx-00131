import Papa from 'papaparse';
import type { ConfigVersion, ErrorRow, ImportStats, TelemetryLog } from '@/types';
import { db } from '@/db';
import { hashFields, parseTimestamp, uid } from '@/utils';

export interface ParserProgress {
  fileName: string;
  current: number;
  total: number;
  errors: number;
  duplicates: number;
}

export type ProgressCallback = (p: ParserProgress) => void;

interface ParseBatchResult {
  logs: TelemetryLog[];
  errors: ErrorRow[];
  duplicateCount: number;
  totalRows: number;
}

function objectToCsvLine(obj: Record<string, any>): string {
  const vals = Object.entries(obj).map(([, v]) => {
    const s = String(v ?? '');
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  });
  return vals.join(',');
}

async function parseSingleFile(
  file: File,
  config: ConfigVersion,
  batchId: string,
  onProgress?: ProgressCallback,
): Promise<ParseBatchResult> {
  return new Promise((resolve) => {
    const logs: TelemetryLog[] = [];
    const errors: ErrorRow[] = [];
    const seenHashes = new Set<string>();
    const siteLastTs = new Map<string, number>();
    let duplicateCount = 0;
    let totalRows = 0;
    let current = 0;
    const timeField = config.timeField;
    const dedupeFields = config.dedupeFields;

    Papa.parse<Record<string, any>>(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
      step: (result, parser) => {
        current++;
        totalRows++;
        const lineNumber = (result.meta as any).lines ?? (result.meta as any).cursor ?? current;
        const raw = result.data;
        const rawTimestamp = raw[timeField];
        const siteId = String(raw.siteId ?? '').trim();

        if (!siteId || !rawTimestamp) {
          errors.push({
            id: uid('err'),
            sourceFile: file.name,
            lineNumber,
            errorType: 'MISSING_FIELD',
            errorMessage: !siteId ? '缺少必填字段 siteId' : '缺少时间字段',
            rowData: objectToCsvLine(raw),
            importBatchId: batchId,
            createdAt: Date.now(),
          });
          return;
        }

        const fields = (result.meta as any).fields as string[] | undefined;
        const missingFields: string[] = [];
        if (fields && fields.length > 0) {
          for (const f of fields) {
            if (f === timeField || f === 'siteId') continue;
            const v = raw[f];
            if (v === undefined || v === null || String(v).trim() === '') {
              missingFields.push(f);
            }
          }
        }
        if (missingFields.length > 0) {
          errors.push({
            id: uid('err'),
            sourceFile: file.name,
            lineNumber,
            errorType: 'MISSING_FIELD',
            errorMessage: `字段值缺失: ${missingFields.join(', ')}`,
            rowData: objectToCsvLine(raw),
            importBatchId: batchId,
            createdAt: Date.now(),
          });
          return;
        }

        const ts = parseTimestamp(String(rawTimestamp), config.timeFormat);
        if (ts === null) {
          errors.push({
            id: uid('err'),
            sourceFile: file.name,
            lineNumber,
            errorType: 'PARSE_ERROR',
            errorMessage: `时间字段无法解析: ${rawTimestamp}`,
            rowData: objectToCsvLine(raw),
            importBatchId: batchId,
            createdAt: Date.now(),
          });
          return;
        }

        const lastTs = siteLastTs.get(siteId);
        if (lastTs !== undefined && ts < lastTs) {
          errors.push({
            id: uid('err'),
            sourceFile: file.name,
            lineNumber,
            errorType: 'TIME_INVERSION',
            errorMessage: `时间倒置: ${new Date(ts).toISOString()} < ${new Date(lastTs).toISOString()}`,
            rowData: objectToCsvLine(raw),
            importBatchId: batchId,
            createdAt: Date.now(),
          });
          return;
        }

        const hashKey = hashFields({ ...raw, timestamp: ts }, dedupeFields);
        if (seenHashes.has(hashKey)) {
          duplicateCount++;
          return;
        }
        seenHashes.add(hashKey);

        const log: TelemetryLog = {
          ...raw,
          id: `log_${hashKey}`,
          siteId,
          timestamp: ts,
          rawTimestamp: String(rawTimestamp),
          sourceFile: file.name,
          importBatchId: batchId,
        };
        logs.push(log);
        siteLastTs.set(siteId, Math.max(lastTs ?? 0, ts));

        if (current % 500 === 0) {
          onProgress?.({
            fileName: file.name,
            current,
            total: totalRows,
            errors: errors.length,
            duplicates: duplicateCount,
          });
        }
        // Keep parser going
        void parser;
      },
      complete: () => {
        onProgress?.({
          fileName: file.name,
          current,
          total: totalRows,
          errors: errors.length,
          duplicates: duplicateCount,
        });
        resolve({ logs, errors, duplicateCount, totalRows });
      },
      error: (err) => {
        errors.push({
          id: uid('err'),
          sourceFile: file.name,
          lineNumber: 0,
          errorType: 'PARSE_ERROR',
          errorMessage: `CSV解析错误: ${err.message}`,
          rowData: '',
          importBatchId: batchId,
          createdAt: Date.now(),
        });
        resolve({ logs, errors, duplicateCount, totalRows });
      },
    });
  });
}

export async function importFiles(
  files: File[],
  config: ConfigVersion,
  onProgress?: ProgressCallback,
): Promise<ImportStats> {
  const batchId = uid('batch');
  const sourceFiles: string[] = [];
  let totalRows = 0;
  let insertedRows = 0;
  let duplicateRows = 0;
  let errorRows = 0;

  for (const file of files) {
    sourceFiles.push(file.name);
    const result = await parseSingleFile(file, config, batchId, onProgress);

    const existingIds = await db.telemetryLogs
      .where('id')
      .anyOf(result.logs.map((l) => l.id))
      .primaryKeys();
    const existingSet = new Set(existingIds);
    const newLogs = result.logs.filter((l) => !existingSet.has(l.id));
    const crossDuplicates = result.logs.length - newLogs.length;

    if (newLogs.length > 0) {
      try {
        await db.telemetryLogs.bulkAdd(newLogs);
      } catch (e) {
        // Some duplicates may slip in due to concurrency; ignore
      }
    }
    if (result.errors.length > 0) {
      await db.errorRows.bulkAdd(result.errors);
    }

    totalRows += result.totalRows;
    insertedRows += newLogs.length;
    duplicateRows += result.duplicateCount + crossDuplicates;
    errorRows += result.errors.length;
  }

  return {
    batchId,
    totalRows,
    insertedRows,
    duplicateRows,
    errorRows,
    sourceFiles,
    createdAt: Date.now(),
  };
}

export async function clearAllData(): Promise<void> {
  await db.transaction('rw', db.telemetryLogs, db.errorRows, db.outageIntervals, db.annotations, async () => {
    await db.telemetryLogs.clear();
    await db.errorRows.clear();
    await db.outageIntervals.clear();
    await db.annotations.clear();
  });
}
