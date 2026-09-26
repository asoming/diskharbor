import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Info, LoaderCircle, RotateCcw } from 'lucide-react';
import type { DiskHarborAPI, Entry, Summary } from '../types';
import { errorText, rawError } from '../errors';
import './scan-issues.css';

interface Props {
  api: DiskHarborAPI;
  summary: Summary;
  locale: 'zh-CN' | 'en';
  locked: boolean;
  onRetry(id: number): void;
}

export function ScanIssues({ api, summary, locale, locked, onRetry }: Props) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Map<number, Entry>>(new Map());
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);
  const issueIds = (summary.errorDetails || []).map(item => item.id).join(',');

  useEffect(() => { setOpen(false); setEntries(new Map()); setFailure(''); }, [summary.scanId]);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    const ids = issueIds ? issueIds.split(',').map(Number) : [];
    setLoading(true);
    setFailure('');
    void (async () => {
      const next = new Map<number, Entry>();
      for (let offset = 0; offset < ids.length; offset += 8) {
        const page = await Promise.all(ids.slice(offset, offset + 8).map(id => api.entry(id)));
        if (stale) return;
        for (const entry of page) if (entry) next.set(entry.id, entry);
      }
      setEntries(next);
    })().catch(error => { if (!stale) setFailure(rawError(error)); })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [api, summary.scanId, issueIds, open, attempt]);

  if (!summary.errors) return null;
  return <section className="scan-issues" aria-label={t('读取问题', 'Read errors')}>
    <button className="scan-issues-toggle" aria-expanded={open} aria-controls="scan-issues-details" onClick={() => setOpen(value => !value)}>
      {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<Info size={15} />
      <span>{t('查看读取问题', 'Review read errors')}</span><span className="scan-issues-count">{summary.errors.toLocaleString(locale)}</span>
    </button>
    {open && <div id="scan-issues-details" className="scan-issues-details">
      <p>{t('重新扫描会替换当前结果，文件读取失败时将扫描其所在文件夹。', 'Rescanning replaces the current results. For a file read failure, its containing folder will be scanned.')}</p>
      {summary.state === 'scanning' && <p>{t('扫描结束后可重试。不会自动提权或更改文件权限。', 'Retry after the scan ends. Permissions will not be changed automatically.')}</p>}
      {loading ? <div role="status" className="scan-issues-loading"><LoaderCircle size={15} className="spin" />{t('正在读取问题列表…', 'Loading read errors…')}</div>
        : failure ? <div role="alert">{errorText(failure, locale)} <button className="text-button" onClick={() => setAttempt(value => value + 1)}>{t('重试加载', 'Retry loading')}</button></div>
          : <ul>{(summary.errorDetails || []).map(issue => {
            const entry = entries.get(issue.id);
            return <li key={issue.id}><div><strong>{entry?.path || t('无法定位的项目', 'Item no longer available')}</strong><span>{errorText(issue.code, locale)}</span></div>
              <button className="button secondary small" disabled={locked || summary.state === 'scanning' || !entry || issue.code === 'UNSUPPORTED_PATH'} onClick={() => onRetry(issue.id)}><RotateCcw size={14} />{t('重新扫描此范围', 'Scan this scope again')}</button></li>;
          })}</ul>}
      {summary.errors > (summary.errorDetails?.length || 0) && <p>{t(`显示前 ${summary.errorDetails?.length || 0} 项问题。可重新扫描原范围，检查其余项目。`, `Showing the first ${summary.errorDetails?.length || 0} read errors. Scan the original scope again to check the remaining items.`)}</p>}
    </div>}
  </section>;
}
