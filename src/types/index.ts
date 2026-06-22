export interface SiteGroup {
  id: string;
  name: string;
  siteIds: string[];
}

export interface AnomalyType {
  code: string;
  name: string;
  color: string;
  defaultReason?: string;
}

export interface ConfigVersion {
  id: string;
  name: string;
  createdAt: number;
  isActive: boolean;
  thresholdMinutes: number;
  dedupeFields: string[];
  timeField: string;
  timeFormat: string;
  siteGroups: SiteGroup[];
  anomalyTypes: AnomalyType[];
}

export interface TelemetryLog {
  id: string;
  siteId: string;
  timestamp: number;
  rawTimestamp: string;
  [key: string]: any;
  sourceFile: string;
  importBatchId: string;
}

export type ErrorType = 'TIME_INVERSION' | 'MISSING_FIELD' | 'PARSE_ERROR';

export interface ErrorRow {
  id: string;
  sourceFile: string;
  lineNumber: number;
  errorType: ErrorType;
  errorMessage: string;
  rowData: string;
  importBatchId: string;
  createdAt: number;
}

export interface OutageInterval {
  id: string;
  configVersion: string;
  siteId: string;
  siteGroupId: string;
  anomalyTypeCode: string;
  startTime: number;
  endTime: number;
  durationMinutes: number;
  firstLogId?: string;
  lastLogId?: string;
}

export type AnnotationStatus = 'POWER_OUTAGE' | 'MAINTENANCE' | 'COMM_FAULT' | 'SENSOR_FAULT' | 'NETWORK_OTHER';

export const REASON_OPTIONS: Array<{ code: AnnotationStatus | 'OTHER'; label: string }> = [
  { code: 'POWER_OUTAGE', label: '站点断电' },
  { code: 'MAINTENANCE', label: '计划维护' },
  { code: 'COMM_FAULT', label: '通信故障' },
  { code: 'SENSOR_FAULT', label: '传感器故障' },
  { code: 'NETWORK_OTHER', label: '网络异常' },
  { code: 'OTHER', label: '其他原因' },
];

export interface Annotation {
  id: string;
  outageIntervalId: string;
  configVersion: string;
  reasonCode: string;
  reasonText: string;
  remark: string;
  annotatedAt: number;
  annotatedBy: string;
  isCurrent: boolean;
  siteId?: string;
  startTime?: number;
}

export type AnnotationFilter = 'ALL' | 'ANNOTATED' | 'UNANNOTATED';

export interface FilterState {
  configVersion: string;
  timeRange: [number, number] | null;
  siteGroupIds: string[];
  anomalyTypeCodes: string[];
  annotationStatus: AnnotationFilter;
}

export interface ExportSummary {
  totalIntervals: number;
  annotatedCount: number;
  dateRange: [number, number] | null;
}

export interface PublishRecord {
  id: string;
  configVersion: string;
  configName: string;
  previousConfigVersion: string | null;
  changes: {
    thresholdMinutes?: { from: number; to: number };
    siteGroups?: { added: string[]; removed: string[]; modified: string[] };
    anomalyTypes?: { added: string[]; removed: string[]; modified: string[] };
    other?: string[];
  };
  affectedIntervals: {
    previousCount: number;
    newCount: number;
    migratedAnnotations: number;
  };
  createdAt: number;
  publishedBy: string;
}

export interface ExportRecord {
  id: string;
  fileName: string;
  fileType: 'CSV' | 'HTML';
  configVersion: string;
  filterSnapshot: FilterState;
  summary: ExportSummary;
  fileContent: Blob;
  createdAt: number;
}

export interface ImportStats {
  batchId: string;
  totalRows: number;
  insertedRows: number;
  duplicateRows: number;
  errorRows: number;
  sourceFiles: string[];
  createdAt: number;
}

export interface DashboardStats {
  totalFiles: number;
  totalLogs: number;
  totalOutages: number;
  totalErrors: number;
  annotationRate: number;
}

export interface IntervalWithAnnotation extends OutageInterval {
  annotation?: Annotation;
}
