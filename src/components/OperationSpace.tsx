import type { HistoryItem, OperationSpaceMeasurement, SpaceSample } from '../types';
import type { Locale } from '../errors';

function bytes(value: number | null | undefined, locale: Locale) {
  if (value == null || !Number.isFinite(value) || value < 0) return locale === 'zh-CN' ? '未测得' : 'Not measured';
  if (value === 0) return '0 B';
  const unit = Math.min(5, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))));
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit ? 1 : 0 }).format(value / 1024 ** unit)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'][unit]}`;
}

function validSample(sample: SpaceSample | null | undefined): sample is SpaceSample {
  return !!sample && Number.isSafeInteger(sample.measuredAt) && sample.measuredAt >= 0
    && Number.isFinite(new Date(sample.measuredAt).getTime())
    && Number.isSafeInteger(sample.total) && sample.total > 0
    && Number.isSafeInteger(sample.free) && sample.free >= 0 && sample.free <= sample.total;
}

function Sample({ title, sample, locale }: { title: string; sample: SpaceSample | null; locale: Locale }) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const value = validSample(sample) ? sample : null;
  const date = value ? new Date(value.measuredAt) : null;
  return <article className="ops-sample" aria-label={title}>
    <h4>{title}</h4><dl>
      <div><dt>{t('可用空间', 'Available space')}</dt><dd>{bytes(value?.free, locale)}</dd></div>
      <div><dt>{t('卷总容量', 'Volume capacity')}</dt><dd>{bytes(value?.total, locale)}</dd></div>
      <div className="ops-sample-time"><dt>{t('测量时间（本地）', 'Measured (local time)')}</dt><dd>{date
        ? <time dateTime={date.toISOString()}>{new Intl.DateTimeFormat(locale, {
          year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
        }).format(date)}</time> : t('未测得', 'Not measured')}</dd></div>
    </dl>
  </article>;
}

const reasons: Record<OperationSpaceMeasurement['status'], readonly [string, string]> = {
  pending: ['等待操作结束后的测量。', 'Waiting for the measurement after the operation.'],
  comparable: ['两个测量时点可比较。', 'The two measurements are comparable.'],
  unavailable: ['未能取得完整的空间测量。', 'Complete space measurements were unavailable.'],
  'root-changed': ['扫描位置已变化或无法核对，不能比较。', 'The scan location changed or could not be verified; comparison is unavailable.'],
  'volume-changed': ['卷容量或文件系统信息变化，不能比较。', 'Volume capacity or filesystem information changed; comparison is unavailable.'],
  'not-run': ['操作未开始，未进行测量。', 'The operation did not start; no measurements were taken.'],
  interrupted: ['操作中断，没有完整的前后测量。', 'The operation was interrupted; before-and-after measurements are incomplete.'],
};

export function OperationSpace({ record, locale, compact = false }: { record: HistoryItem; locale: Locale; compact?: boolean }) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const measurement = record.spaceMeasurement;
  const legacy = measurement === undefined;
  const status = measurement?.version === 1 ? measurement.status : 'unavailable';
  const before = measurement?.version === 1 ? measurement.before : null;
  const after = measurement?.version === 1 ? measurement.after : null;
  const comparable = status === 'comparable' && validSample(before) && validSample(after)
    && before.total === after.total && Number.isSafeInteger(record.freeSpaceDelta)
    && record.freeSpaceDelta === after.free - before.free;
  const delta = (legacy || comparable) && record.freeSpaceDelta !== null && Number.isFinite(record.freeSpaceDelta) ? record.freeSpaceDelta : null;
  const value = delta === null ? legacy ? t('未测得', 'Not measured') : t('无法比较', 'Cannot compare')
    : `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${bytes(Math.abs(delta), locale)}`;
  const reason = legacy ? t('旧记录，未经卷身份核验', 'Legacy record; volume identity not verified')
    : status === 'comparable' && !comparable ? t('测量信息不完整，无法比较。', 'Measurement information is incomplete; comparison is unavailable.')
      : (reasons[status] || reasons.unavailable)[locale === 'zh-CN' ? 0 : 1];

  return <section className={`operation-space${compact ? ' ops-compact' : ''}${legacy || !comparable ? ' ops-unverified' : ''}`}
    aria-label={t('操作空间测量', 'Operation space measurement')} data-operation-id={record.id}>
    <dl className="ops-change"><dt>{t('操作前后可用空间变化', 'Available-space change before and after the operation')}</dt><dd>{value}</dd></dl>
    <p className={`ops-reason${legacy ? ' ops-legacy' : ''}`}>{reason}</p>
    <details className="ops-details"><summary>{t('查看测量详情', 'View measurement details')}</summary>
      <div className="ops-details-body" tabIndex={0} role="region" aria-label={t('操作空间测量详情', 'Operation space measurement details')}>
        <dl className="ops-root"><dt>{t('扫描根路径', 'Scan root path')}</dt><dd>{record.rootPath || t('未记录', 'Not recorded')}</dd></dl>
        <div className="ops-samples"><Sample title={t('操作前', 'Before the operation')} sample={before} locale={locale} />
          <Sample title={t('操作后', 'After the operation')} sample={after} locale={locale} /></div>
        <p className="ops-note">{t('这是所选根所在整个卷的可用空间观测，不是盘清保证释放的空间。移入同卷回收站通常不会立即释放；其他应用写入、快照和系统异步处理也会影响数值。', 'These are available-space observations for the entire volume containing the root, not space DiskHarbor guarantees it freed. Same-volume Trash moves usually do not free space immediately; other applications, snapshots and delayed system operations also affect the values.')}</p>
        <p className="ops-note">{t('此处比较这次操作前后两个时点；整理空间页的手动核验从扫描开始时算起，两者时段不同。', 'This compares times before and after this operation. The manual check on the cleanup page starts at scan time, so it covers a different interval.')}</p>
        {legacy && <p className="ops-note ops-legacy">{t('旧差值仅按原记录展示，缺少可核对的两端采样与卷身份信息，不代表通过本版核验。', 'The old difference is shown as originally recorded. Its paired samples and volume identity cannot be verified; it has not passed this version’s checks.')}</p>}
      </div>
    </details>
  </section>;
}
