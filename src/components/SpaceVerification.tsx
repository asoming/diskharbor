import { useId } from 'react';
import { ArrowLeftRight, FolderSearch, Info, LoaderCircle, RotateCcw } from 'lucide-react';
import type { SpaceCheck, Summary } from '../types';
import { errorText, type Locale } from '../errors';
import './space-verification.css';

interface SpaceVerificationProps {
  summary: Summary | null;
  locale: Locale;
  check: SpaceCheck | null;
  busy: boolean;
  error: string;
  canMeasure: boolean;
  onMeasure(): void;
  onRescan(): void;
  rescanDisabled: boolean;
}

function bytes(value: number | null | undefined, locale: Locale) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return locale === 'zh-CN' ? '未知' : 'Unknown';
  if (value === 0) return '0 B';
  const unit = Math.min(5, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))));
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit ? 1 : 0 }).format(value / 1024 ** unit)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'][unit]}`;
}

function MeasuredTime({ value, locale }: { value: number | undefined; locale: Locale }) {
  const date = value === undefined ? null : new Date(value);
  if (!date || !Number.isFinite(date.getTime())) return <>{locale === 'zh-CN' ? '未知' : 'Unknown'}</>;
  return <time dateTime={date.toISOString()}>{new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(date)}</time>;
}

function Snapshot({ title, value, locale }: { title: string; value: SpaceCheck['baseline']; locale: Locale }) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  return <article className="sv-snapshot" aria-label={title}>
    <h3>{title}</h3>
    <dl><div className="sv-free"><dt>{t('可用空间', 'Available space')}</dt><dd>{bytes(value?.free, locale)}</dd></div>
      <div><dt>{t('卷总容量', 'Volume capacity')}</dt><dd>{bytes(value?.total, locale)}</dd></div>
      <div className="sv-time"><dt>{t('测量时间（本地）', 'Measured (local time)')}</dt><dd><MeasuredTime value={value?.measuredAt} locale={locale} /></dd></div></dl>
  </article>;
}

export function SpaceVerification({ summary, locale, check, busy, error, canMeasure, onMeasure, onRescan, rescanDisabled }: SpaceVerificationProps) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const headingId = useId();
  const current = !busy && !error && check?.scanId === summary?.scanId && check?.rootPath === summary?.rootPath ? check : null;
  const delta = current?.comparison === 'comparable' && current.delta !== null && Number.isFinite(current.delta) ? current.delta : null;
  const deltaLabel = delta === null ? t('未知', 'Unknown') : `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${bytes(Math.abs(delta), locale)}`;
  const state = summary?.state;

  return <section className="sv-panel" aria-label={t('空间核验', 'Space verification')} aria-labelledby={headingId}>
    <header className="sv-header"><span className="sv-heading-icon" aria-hidden="true"><ArrowLeftRight size={21} /></span>
      <div className="sv-heading-copy"><h2 id={headingId}>{t('空间核验', 'Space verification')}</h2>
        <p>{t('手动比较所在卷两个时点的可用空间。', 'Manually compare available space on the volume at two points in time.')}</p></div>
      <button type="button" className="sv-button sv-measure" disabled={!canMeasure || busy} onClick={onMeasure}>
        {busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <ArrowLeftRight size={14} aria-hidden="true" />}
        {t('核验可用空间', 'Check available space')}
      </button>
    </header>
    {summary && <p className="sv-root"><FolderSearch size={14} aria-hidden="true" /><span>{t('所选根路径', 'Selected root path')}</span><b title={summary.rootPath}>{summary.rootPath}</b></p>}
    <div className="sv-content" aria-busy={busy}>
      {busy && <p className="sv-loading" role="status"><LoaderCircle size={15} className="spin" aria-hidden="true" />{t('正在读取所在卷的可用空间…', 'Reading available space on this volume…')}</p>}
      {error && !busy && <p className="sv-error" role="alert">{errorText(error, locale)}</p>}
      {!current && !busy && !error && <p className="sv-empty">{!summary
        ? t('先扫描一个文件夹，再手动核验它所在卷的可用空间。', 'Scan a folder first, then manually check available space on its volume.')
        : state === 'scanning' ? t('请等待扫描结束，再手动核验可用空间。', 'Wait for the scan to end, then check available space manually.')
          : state !== 'completed' && state !== 'cancelled' ? t('尚无可核验的扫描，请重新扫描此位置。', 'This scan is not ready for a space check. Scan this location again.')
            : !canMeasure ? t('请等待当前操作结束，再核验可用空间。', 'Wait for the current operation to finish before checking available space.')
              : t('尚未核验。点击“核验可用空间”，与本次扫描开始时的记录比较。不会自动测量或修改文件。', 'No check yet. Choose “Check available space” to compare with the record from this scan’s start. This does not run automatically or modify files.')}</p>}
      {current && <div className="sv-result" role="region" aria-label={t('空间核验结果', 'Space verification results')}>
        <div className="sv-snapshots"><Snapshot title={t('扫描开始时', 'At scan start')} value={current.baseline} locale={locale} />
          <Snapshot title={t('本次核验', 'This check')} value={current.current} locale={locale} /></div>
        <div className={`sv-difference${delta === null ? ' sv-unknown' : delta < 0 ? ' sv-decreased' : ''}`}>
          <dl><dt>{t('卷可用空间变化', 'Change in volume available space')}</dt><dd>{deltaLabel}</dd></dl>
          <p>{current.comparison === 'baseline-unavailable'
            ? t('扫描开始时没有可用的容量记录，无法计算变化。请重新扫描建立新的比较起点。', 'No capacity record was available at scan start, so the change is unknown. Scan again to establish a new starting point.')
            : current.comparison === 'volume-changed'
              ? t('卷容量或文件系统信息发生变化，两次记录不能直接比较。请重新扫描后再次核验。', 'Volume capacity or filesystem information changed, so these records cannot be compared directly. Scan again before checking again.')
              : t('本次核验减去扫描开始时的可用空间；这不是盘清保证释放的空间。', 'Available space at this check minus available space at scan start; this is not space DiskHarbor guarantees it freed.')}</p>
        </div>
        <div className="sv-result-footer"><p>{t('核验不会更新文件列表；如需查看文件变化，请明确重新扫描。', 'A space check does not update the file list. Scan again to inspect file changes.')}</p>
          <button type="button" className="sv-button" disabled={rescanDisabled || busy} onClick={onRescan}><RotateCcw size={14} aria-hidden="true" />{t('重新扫描', 'Scan again')}</button></div>
      </div>}
    </div>
    <details className="sv-explainer"><summary>{t('如何理解这个结果', 'How to read this result')}</summary>
      <div className="sv-explainer-body"><Info size={15} aria-hidden="true" /><div>
        <p>{t('测量针对所选根路径所在的整个卷，不是该文件夹的大小。它只记录两个时点的观测，不表示可用空间实时不变。', 'This measures the entire volume containing the selected root, not the folder’s size. It records observations at two times, not a live guarantee of available space.')}</p>
        <p>{t('移入同一卷的回收站通常不会立即释放空间。其他应用写入、快照及系统异步处理也可能改变数值，变化不能直接归因于本次清理。', 'Moving items to Trash on the same volume usually does not free space immediately. Other applications, snapshots and delayed system operations can also change the values; the difference cannot be attributed directly to this cleanup.')}</p>
        <p>{t('盘清不观察或确认浏览器原生清理结果。请在浏览器中自行确认操作，再按需核验可用空间或重新扫描文件列表。', 'DiskHarbor does not observe or confirm the browser’s native cleanup result. Confirm the operation in your browser, then check available space or rescan the file list when needed.')}</p>
        <p>{t('这里从扫描开始时算起；操作记录中的空间差值只针对那一次文件回收前后，两者的比较时段不同。', 'This comparison starts at scan time. A space difference in Activity covers only that individual Trash operation, so it uses a different interval.')}</p>
        <p>{t('核验结果只在当前应用会话、同一次扫描中保留，不写入操作记录。重新核验会替换旧结果，更换扫描会清空；不会自动核验、清理或重新扫描。', 'The result is kept only for this scan in the current application session, without an activity-log entry. A new check replaces it and a different scan clears it. Checking, cleanup and rescanning never start automatically here.')}</p>
      </div></div>
    </details>
  </section>;
}
