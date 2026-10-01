import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronRight, File, Folder, Info, LoaderCircle, RefreshCw, Square, Trash2, X } from 'lucide-react';
import type { CleanupPlan, CleanupProgress, HistoryItem, ItemStatus } from '../types';
import { errorText, type Locale } from '../errors';
import { OperationSpace } from './OperationSpace';
import './cleanup-review.css';

type FormatSize = (value: number | null | undefined) => string;
const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

export function isCleanupActive(progress: CleanupProgress | null): boolean {
  return !!progress && ['confirming', 'running', 'cancelling'].includes(progress.state);
}

export function resultCounts(record: HistoryItem) {
  const counts = { trashed: 0, failed: 0, skipped: 0, cancelled: 0, unknown: 0, pending: 0, processing: 0 };
  for (const item of record.items) {
    if (item.status in counts) counts[item.status] += 1;
    else counts.unknown += 1;
  }
  if (record.state !== 'running') {
    counts.unknown += counts.pending + counts.processing;
    counts.pending = 0;
    counts.processing = 0;
  }
  return counts;
}

export function resultSummary(record: HistoryItem, locale: Locale): string {
  const counts = resultCounts(record);
  const zh = locale === 'zh-CN';
  const title = record.state === 'interrupted' ? (zh ? '操作中断，请核查结果。' : 'Operation interrupted. Check the results.')
    : record.state === 'cancelled' ? (zh ? '已停止剩余操作。' : 'Remaining operations stopped.')
      : (zh ? '处理结束。' : 'Processing finished.');
  const parts = [zh ? `已回收 ${counts.trashed} 项` : `${counts.trashed} trashed`];
  if (counts.failed) parts.push(zh ? `失败 ${counts.failed} 项` : `${counts.failed} failed`);
  if (counts.skipped) parts.push(zh ? `跳过 ${counts.skipped} 项` : `${counts.skipped} skipped`);
  if (counts.cancelled) parts.push(zh ? `取消 ${counts.cancelled} 项` : `${counts.cancelled} cancelled`);
  if (counts.unknown) parts.push(zh ? `结果不确定 ${counts.unknown} 项` : `${counts.unknown} uncertain`);
  return `${title} ${parts.join(zh ? '，' : ', ')}${zh ? '。' : '.'}`;
}

function statusLabel(status: ItemStatus, locale: Locale): string {
  const labels: Record<ItemStatus, [string, string]> = {
    pending: ['待处理', 'Pending'], processing: ['处理中', 'Processing'], trashed: ['已回收', 'Trashed'],
    failed: ['失败', 'Failed'], skipped: ['已跳过', 'Skipped'], cancelled: ['已取消', 'Cancelled'], unknown: ['结果不确定', 'Uncertain'],
  };
  return (labels[status] ?? labels.unknown)[locale === 'zh-CN' ? 0 : 1];
}

export function CleanupReview({ plan, locale, formatSize, busy, reviewError = '', returnFocusTo, onClose, onExecute, onReviewHidden }: {
  plan: CleanupPlan; locale: Locale; formatSize: FormatSize; busy: boolean; reviewError?: string;
  returnFocusTo?: HTMLElement | null;
  onClose(): void; onExecute(): void; onReviewHidden(allowHidden: boolean): void;
}) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const modal = useRef<HTMLElement>(null);
  const hiddenControl = useRef<HTMLInputElement>(null);
  const returnToHidden = useRef(false);
  const [allowHidden, setAllowHidden] = useState(plan.allowHidden === true);
  const eligible = plan.items.filter(item => item.eligible).length;
  const showHiddenControl = plan.hiddenReviewAvailable || plan.allowHidden;

  useEffect(() => { setAllowHidden(plan.allowHidden === true); }, [plan.id, plan.allowHidden]);
  useEffect(() => {
    if (!busy && returnToHidden.current) {
      returnToHidden.current = false;
      (hiddenControl.current ?? modal.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus();
    }
  }, [busy]);

  useEffect(() => {
    // App captures the opener before the pending request disables it and the
    // modal makes the page inert; activeElement can already be body by now.
    const previous = returnFocusTo ?? document.activeElement as HTMLElement | null;
    const dialog = modal.current;
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), [tabindex="0"]') ?? []);
    focusables()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const nodes = focusables();
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      requestAnimationFrame(() => {
        if (previous?.isConnected && !previous.closest('[inert]') && !previous.matches(':disabled')) previous.focus({ preventScroll: true });
      });
    };
  }, [returnFocusTo]);

  return (
    <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="review-modal" ref={modal} role="dialog" aria-modal="true" aria-labelledby="review-title" aria-describedby="review-impact"
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onClose(); } }}>
        <div className="panel-heading">
          <span className="round-icon"><Trash2 size={22} /></span>
          <button className="icon-btn" disabled={busy} onClick={onClose} aria-label={t('关闭', 'Close')}><X size={20} /></button>
        </div>
        <h2 id="review-title">{t('核对文件与文件夹', 'Review files and folders')}</h2>
        <p id="review-impact">{t('符合条件的项目将整体移入系统回收站。文件夹包含其全部内容，请核对完整路径。', 'Eligible items will be moved to the system Trash. A folder includes all of its contents; check the complete paths.')}</p>
        {showHiddenControl && <div className="review-hidden-option">
          <label><input ref={hiddenControl} type="checkbox" checked={allowHidden} disabled={busy}
            aria-describedby="review-hidden-help" onChange={event => {
              const next = event.currentTarget.checked;
              setAllowHidden(next); returnToHidden.current = true; onReviewHidden(next);
            }} /><span>{t('允许本次回收普通隐藏项目', 'Allow ordinary hidden items for this cleanup')}</span></label>
          <p id="review-hidden-help">{t('仅适用于 Windows 普通隐藏属性项目。系统、应用数据和点号路径仍受保护。更改选项会重新核对整个清单，不会跳过逐项检查或最后的系统确认；关闭清单后不保留此选项。', 'Only ordinary items with the Windows hidden attribute can be included. System, application-data and dot-prefixed paths stay protected. Changing this option reviews the whole list again; item checks and final system confirmation still apply. This choice is not saved after closing the review.')}</p>
        </div>}
        {busy && <p className="review-update-status" role="status">{t('正在重新核对清单，请稍候…', 'Reviewing the list again. Please wait…')}</p>}
        {reviewError && <div className="review-rebuild-error" role="alert"><p>{t('清单未能更新，暂不能继续。', 'The list could not be updated. Continuing is unavailable.')} {errorText(reviewError, locale)}</p><button className="text-button" disabled={busy} onClick={() => { returnToHidden.current = true; onReviewHidden(allowHidden); }}><RefreshCw size={14} />{t('重新核对清单', 'Review the list again')}</button></div>}
        {plan.omittedCount > 0 && <div className="review-normalized">
          <Info size={16} />
          <p>{t(`已合并 ${plan.omittedCount} 个被已选父文件夹覆盖的子项，避免重复处理。父文件夹受阻时，也不会改为处理这些子项。`, `${plan.omittedCount} selected descendants are covered by a selected parent folder and will not be processed twice. If that parent is blocked, those descendants will not be processed separately.`)}</p>
        </div>}
        <div className="review-list">
          {plan.items.map(item => (
            <div className={`review-item ${!item.eligible ? 'blocked' : ''}`} key={item.id}>
              {item.kind === 'directory' ? <Folder size={19} aria-hidden="true" /> : <File size={18} aria-hidden="true" />}
              <div>
                <strong>{nameOf(item.path) || t('项目不可用', 'Item unavailable')}</strong>
                <small>{item.path}</small>
                <span className="review-kind">{item.kind === 'directory'
                  ? item.fileCount === undefined ? t('文件夹 · 文件数未知', 'Folder · file count unavailable')
                    : t(`文件夹 · 包含 ${item.fileCount.toLocaleString(locale)} 个文件`, `Folder · contains ${item.fileCount.toLocaleString(locale)} ${item.fileCount === 1 ? 'file' : 'files'}`)
                  : item.kind === 'file' ? t('文件', 'File') : t('不支持的项目类型', 'Unsupported item type')}</span>
                {!item.eligible && <em><AlertCircle size={12} />{errorText(item.reason, locale)}</em>}
                {item.blockedPath && <small className="review-blocked-path">{t('受阻位置：', 'Blocked path: ')}{item.blockedPath}</small>}
              </div>
              <div className="review-item-end"><span>{formatSize(item.size)}</span><b className={item.eligible ? 'eligible' : 'blocked'}>{item.eligible ? t('可处理', 'Eligible') : t('不会处理', 'Blocked')}</b></div>
            </div>
          ))}
        </div>
        <div className="review-estimate"><span>{t('可处理项目占用估计', 'Estimated size of eligible items')}</span><strong>{formatSize(plan.totalBytes)}</strong></div>
        <div className="review-note"><Info size={17} /><span>{t('这个数字不是预计释放量。移入同一磁盘的回收站通常不会立即释放空间；恢复及最终删除由系统回收站管理。', 'This is not an estimate of space freed. Moving items to the same volume’s Trash usually does not immediately free space. Use the system Trash for restoration or final deletion.')}</span></div>
        {!eligible && !busy && !reviewError && <p id="review-blocked-help" className="review-blocked-help" role="status">{showHiddenControl && !allowHidden
          ? t('当前没有可处理项目。若要回收普通隐藏项目，可勾选上方选项重新核对；其他受保护内容仍不会处理。也可返回调整选择。', 'No items are currently eligible. To include ordinary hidden items, use the option above to review them again; other protected content remains blocked. You can also go back and change the selection.')
          : t('当前没有可处理项目。请查看清单中的受阻原因，返回调整选择；开启隐藏选项不能解除其他保护。', 'No items are currently eligible. Check the reasons in the list and go back to change the selection. The hidden-item option does not remove other protections.')}</p>}
        <div className="review-bottom">
          <span>{t(`${eligible} 项可处理 · ${plan.items.length - eligible} 项受阻`, `${eligible} eligible · ${plan.items.length - eligible} blocked`)}</span>
          <button className="button secondary" onClick={onClose} disabled={busy}>{t('返回', 'Back')}</button>
          <button className="button primary" onClick={onExecute} disabled={!eligible || busy || !!reviewError} aria-describedby={!eligible && !busy && !reviewError ? 'review-blocked-help' : undefined}><Trash2 size={16} />{t('继续并由系统确认', 'Continue to confirmation')}</button>
        </div>
      </section>
    </div>
  );
}

export function CleanupProgressPanel({ progress, result, pending, statusError, locale, cancelPending, onCancel, onRetry, onDismiss, onViewHistory }: {
  progress: CleanupProgress | null; result?: HistoryItem; pending: boolean; statusError: string; locale: Locale;
  cancelPending: boolean; onCancel(): void; onRetry(): void; onDismiss(): void; onViewHistory(): void;
}) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const active = isCleanupActive(progress) || pending;
  if (!progress && !pending && !statusError) return null;
  const state = progress?.state;
  const titles = {
    confirming: t('等待系统确认', 'Waiting for system confirmation'), running: t('正在移入回收站', 'Moving items to Trash'),
    cancelling: t('正在停止剩余操作', 'Stopping remaining operations'), completed: t('处理结束', 'Processing finished'),
    cancelled: t('已停止剩余操作', 'Remaining operations stopped'), failed: t('操作未能完成', 'Operation could not finish'),
  };
  const title = result?.state === 'interrupted' ? t('操作中断，请核查结果', 'Operation interrupted. Check the results.')
    : state ? titles[state] : pending ? t('正在请求系统确认', 'Requesting system confirmation') : t('操作状态暂不可用', 'Operation status unavailable');
  const uncertain = result ? resultCounts(result).unknown : 0;
  return (
    <section className={`cleanup-progress ${active ? 'active' : 'finished'}`} aria-label={t('整理进度', 'Cleanup progress')}>
      <div className="cleanup-progress-heading">
        <span className="cleanup-progress-icon">{active ? <LoaderCircle size={19} className="spin" /> : state === 'failed' || uncertain ? <AlertCircle size={19} /> : <CheckCircle2 size={19} />}</span>
        <div><h3 role="status">{title}</h3><p>{active ? t('可以切换页面查看；新的扫描和整理暂时锁定。', 'You can browse other pages. New scans and cleanup are temporarily locked.') : t('取消不会撤销已完成的操作。', 'Cancellation does not undo completed operations.')}</p></div>
        <div className="cleanup-progress-actions">
          {isCleanupActive(progress) && <button className="button secondary small" onClick={onCancel} disabled={cancelPending || state === 'cancelling'}><Square size={12} />{cancelPending || state === 'cancelling' ? t('正在请求停止…', 'Stopping…') : t('取消剩余操作', 'Cancel remaining')}</button>}
          {!active && progress && <button className="text-button" onClick={onViewHistory}>{t('查看记录', 'View activity')}<ChevronRight size={14} /></button>}
          {!active && !statusError && <button className="icon-btn" onClick={onDismiss} aria-label={t('收起结果', 'Dismiss result')}><X size={16} /></button>}
        </div>
      </div>
      {progress && <>
        <div className="cleanup-progress-meter"><progress max={Math.max(1, progress.total)} value={Math.min(progress.total, progress.processed)} aria-label={t('已处理项目', 'Processed items')} /><span>{progress.processed} / {progress.total} {t('项', 'items')}</span></div>
        <div className="cleanup-counts" aria-live="off">
          <span>{t('已回收', 'Trashed')} <b>{progress.success}</b></span><span>{t('失败', 'Failed')} <b>{progress.failed}</b></span>
          <span>{t('跳过', 'Skipped')} <b>{progress.skipped}</b></span><span>{t('取消', 'Cancelled')} <b>{progress.cancelled}</b></span>
          {uncertain > 0 && <span className="uncertain">{t('不确定', 'Uncertain')} <b>{uncertain}</b></span>}
        </div>
        {progress.currentPath && active && <p className="cleanup-current-path" title={progress.currentPath}>{progress.currentPath}</p>}
      </>}
      {active && <p className="cleanup-cancel-note">{t('取消会等待当前系统操作返回，再停止后续项目；不会恢复已回收内容。一个文件夹及其内容按一项处理。', 'Cancellation waits for the current system operation to return, then stops later items. It does not restore items already trashed. A folder and its contents count as one item.')}</p>}
      {uncertain > 0 && <p className="cleanup-uncertain-note">{errorText('RESULT_UNCERTAIN', locale)}</p>}
      {statusError && <div className="cleanup-status-error" role="alert"><span>{errorText(statusError, locale)}</span><button className="text-button" onClick={onRetry}><RefreshCw size={13} />{t('重新读取状态', 'Reload status')}</button></div>}
      {result && <OperationSpace record={result} locale={locale} />}
    </section>
  );
}

export function TrashGuide({ locale, onOpen, disabled = false }: { locale: Locale; onOpen(): void; disabled?: boolean }) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  return (
    <section className="trash-guide">
      <div className="trash-guide-heading"><span className="round-icon"><Trash2 size={19} /></span><div><h3>{t('需要找回文件？', 'Need an item back?')}</h3><p>{t('通过系统回收站检查和还原。', 'Inspect and restore items in the system Trash.')}</p></div><button className="button secondary small" disabled={disabled} onClick={onOpen}><Folder size={14} />{t('打开系统回收站', 'Open system Trash')}</button></div>
      <details className="trash-guide-details"><summary>{t('查看恢复指引', 'How to restore items')}</summary>
        <div className="trash-guide-body" tabIndex={0} role="region" aria-label={t('恢复步骤与注意事项', 'Restoration steps and precautions')}>
          <p className="trash-guide-uncertain">{t('结果标为“不确定”时，先同时检查原位置和回收站；原路径消失不代表回收成功。', 'For an uncertain result, first check both the original location and Trash. A missing original path does not prove a successful move.')}</p>
          <ol>
            <li><strong>{t('确认项目。', 'Identify the item.')} </strong>{t('在系统回收站核对名称、原路径和删除时间，确认是需要找回的内容。', 'In the system Trash, check its name, original path and removal time to confirm it is the item you need.')}</li>
            <li><strong>{t('使用系统还原。', 'Use the system restore action.')} </strong>{t('选中项目，使用系统提供的“还原”或“放回原处”（Restore / Put Back）操作。', 'Select the item and use the system’s Restore or Put Back action where available.')}</li>
            <li><strong>{t('遇到同名冲突。', 'If a name conflicts.')} </strong>{t('先取消并核对两份内容；优先选择系统提供的“保留两份”或其他位置，不要未经核对直接覆盖。', 'Cancel first and compare both copies. Prefer keeping both or choosing another location if the system offers those options; do not overwrite without checking.')}</li>
            <li><strong>{t('原目录已不存在。', 'If the original folder is missing.')} </strong>{t('按系统可用选项选择你确认的恢复位置，不要假定系统一定会重建原目录。', 'Use the system’s available options to choose a location you have checked. Do not assume it will recreate the original folder.')}</li>
            <li><strong>{t('检查后重新扫描。', 'Check, then scan again.')} </strong>{t('恢复后，在文件管理器核对名称、位置和内容，再回到盘清主动重新扫描。', 'After restoring, check the name, location and contents in the file manager, then return to DiskHarbor and explicitly scan again.')}</li>
          </ol>
          <p>{t('操作记录保留当时的回收结果；盘清不会监测你在系统中的还原。', 'Activity records retain the result of the original Trash operation. DiskHarbor does not monitor restoration performed in the system.')}</p>
          <p>{t('操作记录不是备份。已清空或永久删除的内容不能通过盘清恢复；本界面不会自动恢复，也不会清空系统回收站。', 'Activity records are not backups. DiskHarbor cannot recover permanently deleted items or an emptied Trash. This interface does not restore items automatically or empty the system Trash.')}</p>
        </div>
      </details>
    </section>
  );
}

function ActivityRecord({ record, locale, formatSize }: { record: HistoryItem; locale: Locale; formatSize: FormatSize }) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const [limit, setLimit] = useState(100);
  const counts = resultCounts(record);
  const title = record.state === 'running' ? t('处理中', 'In progress') : record.state === 'interrupted' ? t('操作中断', 'Interrupted')
    : record.state === 'cancelled' ? t('已停止剩余操作', 'Remaining operations stopped') : t('处理结束', 'Processing finished');
  return (
    <article className={`history-item ${record.state === 'interrupted' ? 'interrupted' : ''}`} data-record-id={record.id}>
      <span className="history-icon">{record.state === 'interrupted' || counts.unknown ? <AlertCircle size={20} /> : <Trash2 size={20} />}</span>
      <div className="history-record-main">
        <h3>{title}<span className="history-record-count">{record.total ?? record.items.length} {t('项', 'items')}</span></h3>
        <p>{new Date(record.time).toLocaleString(locale)}{record.finishedAt && <> · {t('结束于', 'Finished')} {new Date(record.finishedAt).toLocaleTimeString(locale)}</>}</p>
        <div className="history-counts"><span>{t(`已回收 ${counts.trashed}`, `${counts.trashed} trashed`)}</span>{counts.failed > 0 && <span>{t(`失败 ${counts.failed}`, `${counts.failed} failed`)}</span>}{counts.skipped > 0 && <span>{t(`跳过 ${counts.skipped}`, `${counts.skipped} skipped`)}</span>}{counts.cancelled > 0 && <span>{t(`取消 ${counts.cancelled}`, `${counts.cancelled} cancelled`)}</span>}{counts.unknown > 0 && <strong>{t(`不确定 ${counts.unknown}`, `${counts.unknown} uncertain`)}</strong>}</div>
        {(record.state === 'interrupted' || counts.unknown > 0) && <p className="history-uncertain">{counts.unknown ? errorText('RESULT_UNCERTAIN', locale) : t('操作未完整结束；请按下方逐项记录核查。', 'The operation did not finish fully. Check the individual records below.')}</p>}
        {record.historyError && <p className="history-uncertain">{errorText(record.historyError, locale)}</p>}
        <details><summary>{t('查看逐项结果', 'View individual results')}</summary>
          {record.items.slice(0, limit).map((item, index) => {
            const status = record.state !== 'running' && (item.status === 'processing' || item.status === 'pending') ? 'unknown' : item.status;
            return <div className={`history-file history-file-${status}`} key={`${item.path}-${index}`}>
              {item.kind === 'directory' ? <Folder size={14} /> : <File size={14} />}<span>{item.path}</span>
              {item.size !== undefined && <small className="history-item-size">{formatSize(item.size)}</small>}
              <b>{statusLabel(status, locale)}</b>
              {item.error && <small className="history-item-error">{errorText(item.error, locale)}</small>}
              {status === 'unknown' && !item.error && <small className="history-item-error">{errorText('RESULT_UNCERTAIN', locale)}</small>}
            </div>;
          })}
          {record.items.length > limit && <button className="text-button history-load-more" onClick={() => setLimit(value => value + 100)}>{t('再显示 100 项', 'Show 100 more')}</button>}
        </details>
      </div>
      <div className="history-space-summary"><OperationSpace record={record} locale={locale} compact />{record.totalBytes !== undefined && <p className="history-space-estimate">{t('处理占用估计', 'Estimated item size')}<br />{formatSize(record.totalBytes)}</p>}</div>
    </article>
  );
}

export function ActivityPanel({ records, locale, formatSize, error, loading, locked, trashDisabled, onClear, onRefresh, onOpenTrash }: {
  records: HistoryItem[]; locale: Locale; formatSize: FormatSize; error: string; loading: boolean; locked: boolean;
  trashDisabled: boolean; onClear(): void; onRefresh(): void; onOpenTrash(): void;
}) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  return (
    <section className="panel history-panel">
      <div className="panel-heading"><div><h2>{t('本地操作记录', 'Local activity')}</h2><p className="small-muted">{t('逐项结果保存在本机，操作记录不是文件备份。', 'Individual results are stored locally. Activity records are not file backups.')}</p></div><div className="history-toolbar">
        <button className="icon-btn" disabled={loading} aria-label={t('刷新记录', 'Refresh activity')} onClick={onRefresh}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button>
        {(records.length > 0 || error) && <button className="text-button" disabled={locked} onClick={onClear}>{error ? t('重置操作记录', 'Reset activity log') : t('清除记录', 'Clear activity')}</button>}
      </div></div>
      <TrashGuide locale={locale} disabled={trashDisabled} onOpen={onOpenTrash} />
      {error && <div className="banner error" role="alert"><AlertCircle size={17} /><span>{errorText(error, locale)}</span></div>}
      {records.map(record => <ActivityRecord key={record.id} record={record} locale={locale} formatSize={formatSize} />)}
      {!records.length && !error && <div className="empty-state"><Trash2 size={38} /><h3>{loading ? t('正在读取记录…', 'Loading activity…') : t('还没有操作记录', 'No activity yet')}</h3><p>{t('整理文件或文件夹后，逐项结果会显示在这里。', 'After a cleanup, individual file and folder results will appear here.')}</p></div>}
    </section>
  );
}
