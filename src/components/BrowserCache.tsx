import { useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Check, Copy, FolderSearch, Globe2, Info, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import type { BrowserCacheFinding, BrowserCacheReport, BrowserCacheRule, DiskHarborAPI, Entry, Summary } from '../types';
import { rawError, type Locale } from '../errors';
import './browser-cache.css';

interface BrowserCacheProps {
  api: DiskHarborAPI;
  summary: Summary | null;
  locale: Locale;
  onBrowse(entry: Entry, scanId: string): void;
  onRescan(): void;
  disabled: boolean;
  needsRescan: boolean;
}
type ReportState = { scanId: string; rootPath: string; loading: boolean; report: BrowserCacheReport | null; error: string };
type CopyState = { scanId: string; ruleId: string; phase: 'pending' | 'copied' | 'error' };

function formatBytes(value: number | null, locale: Locale) {
  if (value === null || !Number.isFinite(value)) return locale === 'zh-CN' ? '未知' : 'Unknown';
  if (value <= 0) return '0 B';
  const unit = Math.max(0, Math.min(4, Math.floor(Math.log(value) / Math.log(1024))));
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit ? 1 : 0 }).format(value / 1024 ** unit)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}

function reportError(code: string, locale: Locale) {
  const zh = locale === 'zh-CN';
  if (code === 'NO_SCAN') return zh ? '尚无可用扫描，请先扫描文件夹。' : 'Scan a folder before checking cache locations.';
  if (['SCAN_CHANGED', 'SCAN_REPLACED'].includes(code)) return zh ? '扫描结果已更新，请重新识别当前结果。' : 'The scan changed. Check the current results again.';
  if (['SCAN_QUERY_TIMEOUT', 'SCAN_WORKER_FAILED'].includes(code)) return zh ? '暂时无法读取扫描结果，请重试或重新扫描。' : 'The scan results could not be read. Retry or scan again.';
  return zh ? '暂时无法识别缓存位置，请重试。' : 'Cache locations could not be checked. Try again.';
}

export function BrowserCache({ api, summary, locale, onBrowse, onRescan, disabled, needsRescan }: BrowserCacheProps) {
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en;
  const headingId = useId();
  const [state, setState] = useState<ReportState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [copyState, setCopyState] = useState<CopyState | null>(null);
  const generation = useRef(0);
  const copyGeneration = useRef(0);
  const latest = useRef(summary);
  latest.current = summary;
  const scanId = summary?.scanId;
  const rootPath = summary?.rootPath;
  const scanState = summary?.state;

  useEffect(() => {
    const request = ++generation.current;
    ++copyGeneration.current;
    setCopyState(null);
    if (!scanId || !rootPath) { setState(null); return; }
    setState(previous => ({ scanId, rootPath, loading: true, error: '',
      report: previous?.scanId === scanId && previous.rootPath === rootPath ? previous.report : null }));
    const current = () => generation.current === request && latest.current?.scanId === scanId
      && latest.current.rootPath === rootPath && latest.current.state === scanState;
    void api.cacheReport(scanId).then(report => {
      if (!current()) return;
      if (report.scanId !== scanId || report.rootPath !== rootPath) throw new Error('SCAN_CHANGED');
      setState({ scanId, rootPath, loading: false, report, error: '' });
    }).catch(error => {
      if (current()) setState(previous => ({ scanId, rootPath, loading: false,
        report: previous?.scanId === scanId && previous.rootPath === rootPath ? previous.report : null, error: rawError(error) }));
    });
    return () => { if (generation.current === request) generation.current++; };
  }, [api, scanId, rootPath, scanState, attempt]);

  useEffect(() => () => { copyGeneration.current++; }, []);

  // Gate by the current props during render, before an effect can clear old
  // state. A reused numeric entry ID must never make an old card actionable.
  const currentState = summary && state?.scanId === summary.scanId && state.rootPath === summary.rootPath ? state : null;
  const report = currentState?.report ?? null;
  const loading = !!summary && (!currentState || currentState.loading);
  const scanning = summary?.state === 'scanning';
  const canRescan = !!summary && !scanning && !disabled;
  const currentCopy = copyState?.scanId === scanId ? copyState : null;
  const rules = new Map(report?.rules.map(rule => [rule.id, rule]) ?? []);

  async function copySettings(rule: BrowserCacheRule) {
    if (!report || disabled || needsRescan || latest.current?.scanId !== report.scanId) return;
    const request = ++copyGeneration.current;
    const origin = report.scanId;
    setCopyState({ scanId: origin, ruleId: rule.id, phase: 'pending' });
    try {
      await api.copyCacheSettings(rule.id);
      if (copyGeneration.current === request && latest.current?.scanId === origin) setCopyState({ scanId: origin, ruleId: rule.id, phase: 'copied' });
    } catch {
      if (copyGeneration.current === request && latest.current?.scanId === origin) setCopyState({ scanId: origin, ruleId: rule.id, phase: 'error' });
    }
  }

  function browse(finding: BrowserCacheFinding) {
    if (!report || disabled || needsRescan || latest.current?.scanId !== report.scanId) return;
    onBrowse(finding.entry, report.scanId);
  }

  return <section className="bc-panel" aria-labelledby={headingId} aria-label={t('浏览器缓存', 'Browser cache')}>
    <header className="bc-header">
      <span className="bc-heading-icon" aria-hidden="true"><Globe2 size={23} /></span>
      <div className="bc-heading-copy"><h2 id={headingId}>{t('浏览器缓存', 'Browser cache')}</h2>
        <p>{t('先了解占用，再到浏览器中清理。', 'Understand the space used, then clean up in your browser.')}</p></div>
      <div className="bc-header-actions">
        {summary && <button className="bc-button bc-subtle" disabled={disabled || loading} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />{t('刷新识别', 'Refresh matches')}</button>}
        <button className="bc-button" disabled={!canRescan} onClick={onRescan}><RotateCcw size={14} aria-hidden="true" />{t('重新扫描', 'Scan again')}</button>
      </div>
    </header>
    <p className="bc-intro">{t('只列出本次扫描中符合标准布局的缓存位置。请使用浏览器自己的清理设置，盘清不会直接清理这些缓存。', 'These locations match standard cache layouts in this scan. Use the browser’s own cleanup settings; DiskHarbor does not clear these caches directly.')}</p>

    {summary && <div className="bc-scope"><FolderSearch size={14} aria-hidden="true" /><span>{t('扫描范围', 'Scanned scope')}</span><b title={summary.rootPath}>{summary.rootPath}</b></div>}
    {needsRescan && <div className="bc-notice" role="status"><Info size={16} aria-hidden="true" /><p>{t('文件已处理，当前记录可能过期。请重新扫描后查看最新占用。', 'Files were processed, so these records may be out of date. Scan again to see current usage.')}</p></div>}
    {summary && summary.state !== 'completed' && <div className="bc-notice" role="status"><Info size={16} aria-hidden="true" /><p>{scanning
      ? t('扫描仍在进行，当前只显示已发现的内容。可手动刷新识别，扫描结束后会自动更新。', 'Scanning is in progress. Only discovered locations are shown. Refresh matches now, or wait for the automatic update when scanning ends.')
      : t('本次扫描未完整结束，已发现的内容会保留。未显示的位置仍可能有缓存。', 'This scan did not finish completely. Discovered locations are retained; unlisted locations may still contain cache.')}</p></div>}

    <div className="bc-results" aria-busy={loading}>
      {loading && <p className="bc-loading" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />{t('正在识别已扫描的缓存位置…', 'Checking scanned cache locations…')}</p>}
      {currentState?.error && <div className="bc-error" role="alert"><AlertCircle size={18} aria-hidden="true" /><div><p>{reportError(currentState.error, locale)}</p><button className="bc-button" disabled={disabled || loading} onClick={() => setAttempt(value => value + 1)}>{t('重试识别', 'Retry matching')}</button></div></div>}
      {!summary ? <div className="bc-empty"><FolderSearch size={28} aria-hidden="true" /><h3>{t('先扫描一个文件夹', 'Start with a folder scan')}</h3><p>{t('选择浏览器数据所在的文件夹或个人文件夹并开始扫描，之后可在这里查看识别结果。', 'Choose the folder containing your browser data, or your home folder, and start a scan to see matching locations here.')}</p></div>
        : !loading && !currentState?.error && report?.findings.length === 0 ? <div className="bc-empty"><FolderSearch size={28} aria-hidden="true" /><h3>{scanning ? t('尚未发现匹配位置', 'No matching locations found yet') : t('未识别到标准缓存位置', 'No standard cache locations identified')}</h3><p>{scanning
          ? t('扫描还在继续。可稍后刷新识别，或等待扫描完成。', 'The scan is still running. Refresh matches later or wait for it to finish.')
          : t('这不代表没有缓存。自定义配置、未扫描的位置或尚未支持的浏览器布局可能不会显示。', 'This does not mean there is no cache. Custom profiles, unscanned locations and unsupported browser layouts may not appear.')}</p></div> : null}

      {report?.findings.map(finding => {
        const rule = rules.get(finding.ruleId);
        const browserName = rule?.browserName || t('浏览器', 'Browser');
        const copy = currentCopy?.ruleId === finding.ruleId ? currentCopy : null;
        return <article className="bc-card" key={`${report.scanId}:${finding.ruleId}:${finding.entry.id}`} aria-label={`${browserName} · ${finding.profile}`}>
          <div className="bc-card-top"><div className="bc-card-title"><h3>{browserName}</h3><p>{t('配置', 'Profile')} <span>{finding.profile}</span></p></div>
            <span className={`bc-state${finding.complete ? '' : ' bc-state-partial'}`}>{finding.complete ? t('此范围已扫描', 'Scope scanned') : t('部分扫描结果', 'Partial scan')}</span></div>
          <p className="bc-path" title={finding.entry.path}>{finding.entry.path}</p>
          <dl className="bc-measures"><div><dt>{t('已记录的磁盘占用', 'Recorded space on disk')}</dt><dd><strong>{formatBytes(finding.entry.allocatedSize, locale)}</strong></dd></div>
            <div className="bc-logical"><dt>{t('文件内容大小', 'Logical size')}</dt><dd>{formatBytes(finding.entry.logicalSize, locale)}</dd></div>
            <div className="bc-file-count"><dt>{t('已记录文件', 'Recorded files')}</dt><dd>{finding.entry.fileCount.toLocaleString(locale)}</dd></div></dl>
          <p className="bc-basis">{t('依据：路径与已扫描的目录结构符合该浏览器的标准缓存布局。占用来自本次扫描记录，不是可释放空间承诺。', 'Basis: the path and scanned directory structure match this browser’s standard cache layout. This is recorded usage, not a promise of space that can be freed.')}</p>
          {finding.entry.allocatedSize === null && <p className="bc-small-note">{t('此位置的实际占用未知，文件内容大小不能代替实际占用。', 'Space on disk is unknown here. Logical size is not a substitute for allocated space.')}</p>}
          {!finding.complete && <p className="bc-small-note">{t('扫描未覆盖此位置的全部内容，当前大小可能不完整。', 'This location was not fully covered by the scan. Its recorded size may be incomplete.')}</p>}
          <div className="bc-card-actions"><button className="bc-button" disabled={disabled || needsRescan} onClick={() => browse(finding)}>{t('在文件树查看', 'View in file tree')}<ArrowRight size={14} aria-hidden="true" /></button></div>
          {rule && <details className="bc-guide"><summary>{t('在浏览器中清理', 'Clean up in the browser')}</summary>
            <div className="bc-guide-body"><p className="bc-impact">{t('缓存清理后，浏览器会按需重新下载内容，首次访问一些页面可能变慢。', 'After clearing cache, your browser downloads content again when needed. Some pages may load more slowly on the first visit.')}</p>
              <ol><li><strong>{t('打开对应的浏览器与配置', 'Open the matching browser and profile')}</strong><p>{t(`在 ${browserName} 中确认使用的是上面显示的配置，将以下地址粘贴到地址栏并打开。`, `In ${browserName}, check that you are using the profile shown above, then paste this address into the address bar and open it.`)}</p><div className="bc-address"><code>{rule.settingsAddress}</code><button className="bc-button" disabled={disabled || needsRescan || currentCopy?.phase === 'pending'} onClick={() => void copySettings(rule)}>{copy?.phase === 'pending' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{t('复制设置地址', 'Copy settings address')}</button></div>
                {copy?.phase === 'copied' && <p className="bc-copy-status" role="status"><Check size={14} aria-hidden="true" />{t('设置地址已复制', 'Settings address copied')}</p>}
                {copy?.phase === 'error' && <p className="bc-copy-error" role="alert">{t('设置地址未能复制，请重试。', 'The settings address could not be copied. Try again.')}</p>}</li>
                <li><strong>{t('只选择缓存', 'Select cache only')}</strong><p>{t('找到浏览数据清理选项，只选择缓存文件、页面或图片。取消所有其他勾选，包括 Cookie、浏览与下载记录、密码、表单和站点数据；如果无法单独选择缓存，请先取消。', 'Find the browsing-data cleanup options and select only cached files, pages or images. Deselect every other option, including cookies, browsing and download history, passwords, forms and site data. If cache cannot be selected separately, cancel for now.')}</p></li>
                <li><strong>{t('在浏览器中确认，再回来扫描', 'Confirm in the browser, then scan again')}</strong><p>{t('核对时间范围与选项，在浏览器中确认清理。完成后回到盘清重新扫描，查看新的占用记录。', 'Review the time range and selected options, then confirm cleanup in the browser. Return to DiskHarbor and scan again to see updated usage.')}</p><button className="bc-button" disabled={!canRescan} onClick={onRescan}><RotateCcw size={14} aria-hidden="true" />{t('重新扫描', 'Scan again')}</button></li></ol>
            </div>
          </details>}
        </article>;
      })}
      {report?.truncated && <p className="bc-notice" role="status">{t('匹配位置较多，仅显示前 50 项。可缩小扫描范围后继续查看。', 'There are more matching locations. Only the first 50 are shown; scan a smaller scope to inspect the rest.')}</p>}
    </div>

    <details className="bc-support"><summary>{t('支持范围与识别依据', 'Supported layouts and matching details')}</summary><div className="bc-support-body">
      <p>{t('目前识别 Chrome、Chromium 和 Firefox 的部分标准缓存布局，仅限已扫描到的位置。自定义目录、沙箱安装和未来版本的布局可能不同。', 'Matching covers selected standard cache layouts for Chrome, Chromium and Firefox, within the scanned scope. Custom locations, sandboxed installations and future versions may use different layouts.')}</p>
      <p>{t('本机安装的浏览器版本未知。下方“已验证版本”是此前测试过的版本，不代表本机已安装或已验证相同版本。', 'The browser versions installed on this computer are unknown. “Validated versions” below lists versions tested previously; it does not identify or validate the installed browser.')}</p>
      <p>{t('这些结果不会改变受保护目录的处理限制。浏览器运行时缓存可能继续变化；清理效果以重新扫描为准。', 'These results do not change the restrictions on protected folders. Cache can change while a browser is running; scan again to check the outcome.')}</p>
      {report && <><p className="bc-rules-version">{t('规则集版本', 'Rule set version')} <code>{report.ruleSetVersion}</code></p><ul className="bc-rule-list">{report.rules.map(rule => <li key={rule.id}><strong>{rule.browserName} · {rule.platform === 'darwin' ? 'macOS' : rule.platform === 'win32' ? 'Windows' : 'Linux'}</strong><dl><dt>{t('规则', 'Rule')}</dt><dd><code>{rule.id}</code> · v{rule.version}</dd><dt>{t('验证方式', 'Validation')}</dt><dd>{rule.validation === 'native-browser' ? t('曾使用真实浏览器验证', 'Previously checked with a real browser') : t('合成目录元数据测试', 'Synthetic directory metadata tests')}</dd><dt>{t('已验证版本', 'Validated versions')}</dt><dd>{rule.validatedAppVersions.length ? rule.validatedAppVersions.join(', ') : t('尚无真实浏览器版本记录', 'No real-browser version recorded')}</dd><dt>{t('资料来源', 'Sources')}</dt><dd><ul>{rule.sources.map(source => <li key={source}><span>{source}</span></li>)}</ul></dd></dl></li>)}</ul></>}
    </div></details>
  </section>;
}
