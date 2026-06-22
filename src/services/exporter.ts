import type {
  ConfigVersion,
  ExportRecord,
  ExportSummary,
  FilterState,
  IntervalWithAnnotation,
} from '@/types';
import { db } from '@/db';
import { formatDateTime, formatDuration, getErrorTypeLabel, uid } from '@/utils';

function filterToText(filter: FilterState, config: ConfigVersion): string {
  const lines: string[] = [];
  lines.push(`配置版本: ${config.name} (${config.id})`);
  lines.push(`断报阈值: ${config.thresholdMinutes} 分钟`);
  if (filter.timeRange) {
    lines.push(`时间范围: ${formatDateTime(filter.timeRange[0])} ~ ${formatDateTime(filter.timeRange[1])}`);
  }
  if (filter.siteGroupIds.length > 0) {
    const names = filter.siteGroupIds
      .map((id) => config.siteGroups.find((g) => g.id === id)?.name || id)
      .join(', ');
    lines.push(`站点分组: ${names}`);
  }
  if (filter.anomalyTypeCodes.length > 0) {
    const names = filter.anomalyTypeCodes
      .map((c) => config.anomalyTypes.find((t) => t.code === c)?.name || c)
      .join(', ');
    lines.push(`异常类型: ${names}`);
  }
  lines.push(`标注筛选: ${filter.annotationStatus === 'ALL' ? '全部' : filter.annotationStatus === 'ANNOTATED' ? '已标注' : '未标注'}`);
  return lines.join('\n');
}

function escapeCsv(s: any): string {
  if (s === null || s === undefined) return '';
  const str = String(s);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function buildCsvExport(
  intervals: IntervalWithAnnotation[],
  config: ConfigVersion,
  filter: FilterState,
): string {
  const header = [
    '断报ID',
    '站点ID',
    '站点分组',
    '异常类型',
    '开始时间',
    '结束时间',
    '持续时长(分钟)',
    '标注状态',
    '原因代码',
    '原因描述',
    '备注',
    '标注时间',
  ].join(',');
  const rows = intervals.map((iv) => {
    const group = config.siteGroups.find((g) => g.id === iv.siteGroupId)?.name || iv.siteGroupId;
    const atype = config.anomalyTypes.find((t) => t.code === iv.anomalyTypeCode)?.name || iv.anomalyTypeCode;
    return [
      iv.id,
      iv.siteId,
      group,
      atype,
      formatDateTime(iv.startTime),
      formatDateTime(iv.endTime),
      iv.durationMinutes,
      iv.annotation ? '已标注' : '未标注',
      iv.annotation?.reasonCode || '',
      iv.annotation?.reasonText || '',
      iv.annotation?.remark || '',
      iv.annotation ? formatDateTime(iv.annotation.annotatedAt) : '',
    ]
      .map(escapeCsv)
      .join(',');
  });
  const meta = [
    `# 站点传感器断报分析导出`,
    `# 导出时间: ${formatDateTime(Date.now())}`,
    `# ====== 筛选条件 ======`,
    filterToText(filter, config)
      .split('\n')
      .map((l) => `# ${l}`)
      .join('\n'),
    `# ===================`,
    '',
  ].join('\n');
  return `${meta}\n${header}\n${rows.join('\n')}\n`;
}

export function buildHtmlReport(
  intervals: IntervalWithAnnotation[],
  config: ConfigVersion,
  filter: FilterState,
): string {
  const summary: ExportSummary = {
    totalIntervals: intervals.length,
    annotatedCount: intervals.filter((i) => i.annotation).length,
    dateRange:
      intervals.length > 0
        ? [intervals[0].startTime, intervals[intervals.length - 1].endTime]
        : null,
  };
  const rowsHtml = intervals
    .map((iv, idx) => {
      const group = config.siteGroups.find((g) => g.id === iv.siteGroupId)?.name || iv.siteGroupId;
      const atObj = config.anomalyTypes.find((t) => t.code === iv.anomalyTypeCode);
      const atName = atObj?.name || iv.anomalyTypeCode;
      const atColor = atObj?.color || '#FF8A3D';
      const annotated = !!iv.annotation;
      return `
      <tr class="${idx % 2 ? 'bg-slate-800/40' : ''}">
        <td class="p-2 border-b border-slate-700 text-xs">${iv.siteId}</td>
        <td class="p-2 border-b border-slate-700 text-xs">${group}</td>
        <td class="p-2 border-b border-slate-700 text-xs">
          <span style="display:inline-block;padding:2px 6px;background:${atColor}22;color:${atColor};border:1px solid ${atColor}55;border-radius:2px;">
            ${atName}
          </span>
        </td>
        <td class="p-2 border-b border-slate-700 text-xs font-mono">${formatDateTime(iv.startTime)}</td>
        <td class="p-2 border-b border-slate-700 text-xs font-mono">${formatDateTime(iv.endTime)}</td>
        <td class="p-2 border-b border-slate-700 text-xs text-right">${formatDuration(iv.durationMinutes)}</td>
        <td class="p-2 border-b border-slate-700 text-xs">
          ${annotated ? `<span style="color:#36D399">● 已标注</span><br><span class="text-xs opacity-80">${iv.annotation?.reasonText || ''}</span>` : '<span style="color:#FF8A3D">○ 未标注</span>'}
        </td>
        <td class="p-2 border-b border-slate-700 text-xs opacity-80">${iv.annotation?.remark || '-'}</td>
      </tr>`;
    })
    .join('');

  const filterHtml = filterToText(filter, config).replace(/\n/g, '<br>');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>站点传感器断报分析报告 - ${formatDateTime(Date.now())}</title>
<style>
  body { font-family: 'JetBrains Mono', ui-monospace, monospace; background: #060E1F; color: #E2E8F0; margin: 0; padding: 32px; }
  h1 { font-family: Orbitron, sans-serif; color: #00D4FF; margin: 0 0 8px; letter-spacing: 2px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin: 20px 0; }
  .card { border: 1px solid rgba(0,212,255,0.2); padding: 16px; background: rgba(16,42,78,0.35); }
  .card .label { font-size: 11px; text-transform: uppercase; opacity: 0.6; letter-spacing: 1px; }
  .card .value { font-size: 28px; font-weight: 600; margin-top: 6px; color: #00D4FF; }
  .meta-box { border: 1px solid rgba(0,212,255,0.15); padding: 14px 18px; margin: 16px 0; background: rgba(11,31,58,0.5); font-size: 12px; line-height: 1.8; }
  table { width: 100%; border-collapse: collapse; margin-top: 18px; }
  th { background: rgba(0,212,255,0.08); text-align: left; padding: 10px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #00D4FF; border-bottom: 1px solid rgba(0,212,255,0.3); }
  footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid rgba(0,212,255,0.2); font-size: 11px; opacity: 0.5; }
</style>
</head>
<body>
  <h1>站点传感器断报分析报告</h1>
  <div style="opacity:0.6;font-size:12px">导出时间: ${formatDateTime(Date.now())} · 配置: ${config.name} (阈值 ${config.thresholdMinutes}分钟)</div>
  <div class="grid">
    <div class="card"><div class="label">总断报区间</div><div class="value">${summary.totalIntervals}</div></div>
    <div class="card"><div class="label">已标注</div><div class="value">${summary.annotatedCount}</div></div>
    <div class="card"><div class="label">未标注</div><div class="value">${summary.totalIntervals - summary.annotatedCount}</div></div>
    <div class="card"><div class="label">数据范围</div><div class="value" style="font-size:14px">${summary.dateRange ? `${formatDateTime(summary.dateRange[0]).slice(5)}<br>${formatDateTime(summary.dateRange[1]).slice(5)}` : '-'}</div></div>
  </div>
  <div class="meta-box"><strong style="color:#00D4FF">筛选条件快照</strong><br>${filterHtml}</div>
  <table>
    <thead>
      <tr>
        <th>站点ID</th><th>分组</th><th>异常类型</th><th>开始时间</th><th>结束时间</th><th>持续时长</th><th>标注状态</th><th>备注</th>
      </tr>
    </thead>
    <tbody>${rowsHtml || `<tr><td colspan="8" style="padding:40px;text-align:center;opacity:0.5">没有符合条件的断报记录</td></tr>`}</tbody>
  </table>
  <footer>报告由 站点传感器断报分析工具 自动生成 · 可复核导出</footer>
</body>
</html>`;
}

export async function saveExportRecord(
  type: 'CSV' | 'HTML',
  fileName: string,
  content: string,
  config: ConfigVersion,
  filter: FilterState,
  intervals: IntervalWithAnnotation[],
): Promise<ExportRecord> {
  const summary: ExportSummary = {
    totalIntervals: intervals.length,
    annotatedCount: intervals.filter((i) => i.annotation).length,
    dateRange:
      intervals.length > 0
        ? [intervals[0].startTime, intervals[intervals.length - 1].endTime]
        : null,
  };
  const mime = type === 'HTML' ? 'text/html;charset=utf-8' : 'text/csv;charset=utf-8';
  const BOM = type === 'CSV' ? '\uFEFF' : '';
  const blob = new Blob([BOM + content], { type: mime });
  const record: ExportRecord = {
    id: uid('exp'),
    fileName,
    fileType: type,
    configVersion: config.id,
    filterSnapshot: JSON.parse(JSON.stringify(filter)),
    summary,
    fileContent: blob,
    createdAt: Date.now(),
  };
  await db.exportRecords.add(record);
  return record;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function buildAndExportErrorsCsv(configId: string): Promise<string> {
  const errors = await db.errorRows.orderBy('createdAt').reverse().toArray();
  const header = ['错误ID', '来源文件', '行号', '错误类型', '错误描述', '原始行数据', '导入批次', '时间'].join(',');
  const rows = errors.map((e) => [
    e.id,
    e.sourceFile,
    e.lineNumber,
    getErrorTypeLabel(e.errorType),
    e.errorMessage,
    e.rowData,
    e.importBatchId,
    formatDateTime(e.createdAt),
  ]
    .map(escapeCsv)
    .join(','));
  const meta = `# 错误行报告\n# 配置版本: ${configId}\n# 导出时间: ${formatDateTime(Date.now())}\n# 错误总数: ${errors.length}\n\n`;
  return meta + header + '\n' + rows.join('\n') + '\n';
}
