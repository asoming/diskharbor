import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, HardDrive, Info } from 'lucide-react';
import type { Summary } from '../types';
import './scan-scope.css';

interface ScanScopeProps {
  summary: Summary;
  locale: 'zh-CN' | 'en';
}

function ScopeField({ label, children, path = false, wide = false }: {
  label: string; children: ReactNode; path?: boolean; wide?: boolean;
}) {
  return <div className={wide ? 'ss-field ss-wide' : 'ss-field'}>
    <dt>{label}</dt><dd className={path ? 'ss-path' : undefined}>{children}</dd>
  </div>;
}

export function ScanScope({ summary, locale }: ScanScopeProps) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const detailsId = useId();
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const expanded = expandedFor === summary.scanId;
  const coverage = summary.coverage;
  const unknown = t('未知', 'Unknown');
  const number = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value) : unknown;
  const bytes = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value) || value < 0) return unknown;
    if (value === 0) return '0 B';
    const unit = Math.min(5, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))));
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit ? 1 : 0 }).format(value / 1024 ** unit)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'][unit]}`;
  };
  const duration = () => {
    if (!Number.isFinite(summary.elapsedMs) || summary.elapsedMs < 0) return unknown;
    const seconds = Math.round(summary.elapsedMs / 100) / 10;
    const value = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
    if (seconds < 60) return t(`${value.format(seconds)} 秒`, `${value.format(seconds)} s`);
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t(`${number(minutes)} 分 ${value.format(seconds % 60)} 秒`, `${number(minutes)} min ${value.format(seconds % 60)} s`);
    return t(`${number(Math.floor(minutes / 60))} 小时 ${number(minutes % 60)} 分`, `${number(Math.floor(minutes / 60))} h ${number(minutes % 60)} min`);
  };
  const started = new Date(summary.startedAt);
  const validStart = summary.startedAt > 0 && Number.isFinite(started.getTime());
  const incomplete = summary.errors > 0 || summary.skipped > 0;
  const caution = summary.state === 'cancelled' || summary.state === 'error' || incomplete;
  const status = summary.state === 'scanning'
    ? summary.cancelRequested ? t('正在等待停止', 'Waiting to stop') : t('正在扫描', 'Scanning')
    : summary.state === 'cancelled' ? t('已停止 · 部分结果', 'Stopped · Partial results')
      : summary.state === 'error' ? t('扫描未完成', 'Scan incomplete')
        : summary.state === 'completed'
          ? incomplete ? t('扫描已结束 · 有未读取项目', 'Scan finished · Some items unread') : t('扫描已结束', 'Scan finished')
          : t('扫描尚未开始', 'Scan not started');

  return <section className="scan-scope" aria-label={t('扫描范围', 'Scan scope')}>
    <button type="button" className="ss-toggle" aria-label={t('扫描范围与覆盖情况', 'Scan scope and coverage')}
      aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpandedFor(expanded ? null : summary.scanId)}>
      {expanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
      <HardDrive size={15} aria-hidden="true" /><span className="ss-title">{t('扫描范围', 'Scan scope')}</span>
      <span className={`ss-state${caution ? ' ss-caution' : ''}`}>{status}</span>
    </button>
    {expanded && <div id={detailsId} className="ss-details" role="region" aria-label={t('扫描范围详情', 'Scan scope details')} tabIndex={0}>
      <dl className="ss-facts">
        <ScopeField label={t('所选根路径', 'Selected root path')} path wide>{summary.rootPath || unknown}</ScopeField>
        <ScopeField label={t('开始时间（本地）', 'Started (local time)')}>{validStart
          ? <time dateTime={started.toISOString()}>{new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(started)}</time>
          : unknown}</ScopeField>
        <ScopeField label={t('已用时间', 'Elapsed time')}>{duration()}</ScopeField>
        <ScopeField label={t('所在卷总容量', 'Volume capacity')}>{bytes(summary.volume?.total)}</ScopeField>
        <ScopeField label={t('所在卷可用空间', 'Volume available space')}>{bytes(summary.volume?.free)}</ScopeField>
      </dl>
      <p className="ss-note">{t('容量为扫描开始时所在卷的快照，不是所选文件夹的容量，也不是当前实时可用空间。', 'Capacity is a snapshot of the containing volume at scan start, not the selected folder’s capacity or live available space.')}</p>
      <dl className="ss-facts ss-volume">
        <ScopeField label={t('本次扫描设备编号', 'Device ID for this scan')} path>{coverage?.deviceId || unknown}</ScopeField>
        <ScopeField label={t('文件系统', 'Filesystem')} path>{coverage?.filesystem || unknown}</ScopeField>
        <ScopeField label={t('挂载位置', 'Mount location')} path wide>{coverage?.mountPath || unknown}</ScopeField>
      </dl>
      <p className="ss-note">{t('设备编号只用于识别本次扫描的边界，不是永久磁盘序列号。', 'The device ID identifies boundaries for this scan; it is not a permanent disk serial number.')}</p>
      <dl className="ss-counts">
        <ScopeField label={t('读取错误', 'Read errors')}>{number(summary.errors)}</ScopeField>
        <ScopeField label={t('跳过项目合计', 'Total skipped items')}>{number(summary.skipped)}</ScopeField>
        <ScopeField label={t('卷或挂载边界', 'Volume or mount boundaries')}>{number(coverage?.skipped.mounts)}</ScopeField>
        <ScopeField label={t('符号链接', 'Symbolic links')}>{number(coverage?.skipped.symbolicLinks)}</ScopeField>
        <ScopeField label={t('虚拟文件系统', 'Virtual filesystems')}>{number(coverage?.skipped.virtualFilesystems)}</ScopeField>
        <ScopeField label={t('特殊文件', 'Special files')}>{number(coverage?.skipped.specialFiles)}</ScopeField>
        <ScopeField label={t('实际占用未知的项目', 'Items with unknown space on disk')}>{number(coverage?.unknownAllocatedEntries)}</ScopeField>
        <ScopeField label={t('路径编码不支持的项目', 'Items with unsupported path encoding')}>{number(coverage?.unsupportedNames)}</ScopeField>
      </dl>
      <p className="ss-note">{t('跳过计数表示已发现的入口数量，不含这些目录内尚未读取的文件；路径编码不受支持的项目可能仍有已记录的元数据。', 'Skipped counts refer to discovered entries, not unread files inside those directories. Metadata may still be recorded for items with unsupported path encoding.')}</p>
      <div className="ss-explanation"><Info size={14} aria-hidden="true" /><div>
        <p>{summary.state === 'scanning'
          ? summary.cancelRequested
            ? t('已请求停止，正在等待当前读取结束；目前只有已发现的结果。', 'Stop requested. Waiting for the current read to finish; only discovered results are shown.')
            : t('扫描仍在进行，数值只包含目前已发现的项目。', 'Scanning is in progress. Counts include only items discovered so far.')
          : summary.state === 'cancelled' || summary.state === 'error'
            ? t('扫描未完整结束，已发现的结果保留，尚未读取的范围可能缺失。', 'The scan did not finish. Discovered results are retained; unread areas may be missing.')
            : summary.state === 'completed'
              ? t('本次扫描已结束；这不表示已覆盖整块磁盘或没有遗漏。', 'This scan has finished; this does not mean the whole disk was covered or nothing was missed.')
              : t('扫描尚未开始，覆盖情况未知。', 'The scan has not started; coverage is unknown.')}</p>
        <p>{t('只扫描所选根路径，不跟随符号链接。发现其他卷或挂载边界时会跳过，请单独选择该范围扫描。', 'Only the selected root is scanned. Symbolic links are not followed. Detected boundaries to other volumes or mounts are skipped; select those locations for a separate scan.')}</p>
        <p>{!coverage ? t('本次扫描的边界检测信息未知，细分计数无法提供。', 'Boundary detection information is unknown for this scan; detailed counts are unavailable.')
          : coverage.boundaryDetection === 'mount-table'
            ? t('使用扫描开始时的 Linux 挂载信息识别边界，包含绑定挂载。', 'Linux mount information recorded at scan start is used to detect boundaries, including bind mounts.')
            : !coverage.deviceId ? t('设备编号暂不可用，无法确认扫描边界。', 'The device ID is unavailable, so scan boundaries cannot be confirmed.')
              : t('目前只能根据设备编号识别部分边界；同设备的绑定挂载等边界可能无法识别。', 'Only device IDs are available to detect some boundaries; bind mounts on the same device and other boundaries may go undetected.')}</p>
        <p>{t('扫描期间文件或设备可能变化；结果是当次读取记录，不代表实时磁盘状态。', 'Files or devices may change during scanning. Results describe recorded reads, not the live state of the disk.')}</p>
        <p>{t('普通隐藏文件仍在扫描范围内；扫描到文件不代表允许清理，清理保护另行判断。实际占用未知不按 0 计算，汇总只包含已知占用。', 'Regular hidden files remain in scope. A scanned item is not automatically eligible for cleanup; cleanup protection is checked separately. Unknown space on disk is not treated as zero; totals include only known allocation.')}</p>
        {summary.errors > 0 && <p className="ss-read-errors">{t('可展开“查看读取问题”，查看失败位置和重新扫描选项。', 'Expand “Review read errors” to inspect failed locations and rescan options.')}</p>}
      </div></div>
    </div>}
  </section>;
}
