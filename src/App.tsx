import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, Check, CheckCircle2, ChevronRight, CircleHelp, Copy, File, FileArchive, FileText, Files, Folder, FolderOpen, FolderTree, HardDrive, History, Image, Info, LayoutDashboard, LoaderCircle, LockKeyhole, Music2, Search, Settings2, ShieldCheck, Sparkles, Square, Trash2, Video, X } from 'lucide-react';
import type { Category, CleanupPlan, Entry, HistoryItem, Summary } from './types';
import { FileExplorer } from './FileExplorer';

type Page = 'overview' | 'tree' | 'files' | 'cleanup' | 'history' | 'settings';
type Locale = 'zh-CN' | 'en';
const api = window.diskharbor;
const categories: { id: Category; zh: string; en: string; color: string; icon: typeof File }[] = [
  { id: 'apps', zh: '应用与数据', en: 'Applications', color: '#87aadd', icon: Files },
  { id: 'video', zh: '视频', en: 'Videos', color: '#ac9bce', icon: Video },
  { id: 'images', zh: '图片', en: 'Images', color: '#e8b286', icon: Image },
  { id: 'documents', zh: '文档', en: 'Documents', color: '#82b6a3', icon: FileText },
  { id: 'archives', zh: '压缩包与安装包', en: 'Archives & installers', color: '#d3b967', icon: FileArchive },
  { id: 'audio', zh: '音频', en: 'Audio', color: '#b891a5', icon: Music2 },
  { id: 'system', zh: '系统文件', en: 'System files', color: '#7f99a8', icon: HardDrive },
  { id: 'other', zh: '其他', en: 'Other files', color: '#a6afb8', icon: File },
];
export function size(value: number | null | undefined, locale: Locale = 'zh-CN') {
  if (value == null || !Number.isFinite(value)) return locale === 'zh-CN' ? '未知' : 'Unknown';
  const n = Math.max(0, value);
  if (n === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const power = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: power > 0 ? 1 : 0 }).format(n / 1024 ** power)} ${units[power]}`;
}
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;
const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(error);

function BrandMark({ large = false }: { large?: boolean }) {
  return <span className={`brand-mark ${large ? 'large' : ''}`} aria-hidden="true"><span /><span /><span /><i /></span>;
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(() => localStorage.getItem('diskharbor.locale') === 'en' ? 'en' : 'zh-CN');
  const t = useCallback((zh: string, en: string) => locale === 'zh-CN' ? zh : en, [locale]);
  const [page, setPage] = useState<Page>('overview');
  const [info, setInfo] = useState<Awaited<ReturnType<NonNullable<typeof api>['info']>> | null>(null);
  const [path, setPath] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [category, setCategory] = useState<Category>();
  const [focusId, setFocusId] = useState<number>();
  const [selected, setSelected] = useState<number[]>([]);
  const [inspected, setInspected] = useState<Entry | null>(null);
  const [topFiles, setTopFiles] = useState<Entry[]>([]);
  const [topFolders, setTopFolders] = useState<Entry[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [plan, setPlan] = useState<CleanupPlan | null>(null);
  const modalRef = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const scanning = summary?.state === 'scanning';
  const nav = [
    { id: 'overview' as Page, icon: LayoutDashboard, title: t('空间概览', 'Overview'), caption: t('一眼看清占用', 'The bigger picture') },
    { id: 'tree' as Page, icon: FolderTree, title: t('文件树', 'File tree'), caption: t('逐层探索文件', 'Explore every folder') },
    { id: 'files' as Page, icon: Files, title: t('我的文件', 'My files'), caption: t('找到值得整理的内容', 'Find what matters') },
    { id: 'cleanup' as Page, icon: Sparkles, title: t('整理空间', 'Make room'), caption: t('先了解，再决定', 'Review before acting') },
    { id: 'history' as Page, icon: History, title: t('操作记录', 'Activity'), caption: t('每次操作都有记录', 'Keep track of changes') },
  ];
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = locale === 'zh-CN' ? '盘清' : 'DiskHarbor';
    localStorage.setItem('diskharbor.locale', locale);
  }, [locale]);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.info().then(value => { if (alive) setInfo(value); }).catch(e => setError(message(e)));
    api.summary().then(value => { if (alive) { setSummary(value); if (value) setPath(value.rootPath); } }).catch(e => setError(message(e)));
    const unsubscribe = api.onProgress(value => setSummary(value));
    return () => { alive = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!api || !summary) return;
    let alive = true;
    const update = () => Promise.all([
      api.query({ kind: 'file', limit: 4, sortBy: 'allocatedSize', sortDirection: 'desc' }),
      api.query({ parentId: summary.rootId, kind: 'directory', limit: 5, sortBy: 'allocatedSize', sortDirection: 'desc' }),
    ]).then(([files, folders]) => { if (alive) { setTopFiles(files.entries); setTopFolders(folders.entries); } }).catch(() => {});
    void update();
    const timer = scanning ? setInterval(update, 1500) : undefined;
    return () => { alive = false; clearInterval(timer); };
  }, [summary?.scanId, summary?.state]);
  useEffect(() => { if (page === 'history' && api) api.history().then(setHistory).catch(e => setError(message(e))); }, [page]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (!busy) setPlan(null); setInspected(null); setNavOpen(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);

  useEffect(() => {
    if (!plan) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = modalRef.current;
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex="0"]') || []);
    focusables()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const nodes = focusables();
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [plan]);

  const navigate = (value: Page) => { setPage(value); setNavOpen(false); setInspected(null); if (value === 'files') setCategory(undefined); };
  const start = async (target = path) => {
    if (!api || !target.trim() || busy) return;
    setBusy(true); setError(''); setSelected([]); setInspected(null); setFocusId(undefined); setTopFiles([]); setTopFolders([]);
    try { const value = await api.startScan(target.trim()); setSummary(value); setPath(value.rootPath); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };
  const choose = async () => {
    if (!api) return;
    try { const target = await api.chooseDirectory(); if (target) setPath(target); } catch (e) { setError(message(e)); }
  };
  const showFiles = (value?: Category) => { setCategory(value); setPage('files'); setInspected(null); };
  const showFolder = (value: Entry) => { setFocusId(value.id); setCategory(undefined); setPage('tree'); setInspected(value); };
  const review = async () => {
    if (!api || !selected.length) return;
    setBusy(true); setError('');
    try { setPlan(await api.planCleanup(selected)); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const execute = async () => {
    if (!api || !plan) return;
    setBusy(true); setError('');
    try {
      const result = await api.executeCleanup(plan.id);
      setHistory(await api.history()); setPlan(null); setSelected([]); setInspected(null);
      const cancelled = result.items.length > 0 && result.items.every(item => item.status === 'cancelled');
      setNotice(cancelled ? t('已取消，文件未更改。', 'Canceled. Files were not changed.') : t(`已移入回收站 ${result.success} 项；${result.items.length - result.success} 项未处理。`, `${result.success} items moved to Trash; ${result.items.length - result.success} not processed.`));
      if (result.historyError) setError(t('文件处理已完成，但本地操作记录保存失败。', 'File processing finished, but the local activity record could not be saved.'));
      if (summary) { const value = await api.startScan(summary.rootPath); setSummary(value); }
    } catch (e) { setError(message(e)); setPlan(null); }
    finally { setBusy(false); }
  };
  const action = async (fn: () => Promise<void>, success?: string) => { try { await fn(); if (success) setNotice(success); } catch (e) { setError(message(e)); } };
  const selectedCategory = categories.find(c => c.id === category);
  const status = summary ? ({ scanning: t('正在扫描', 'Scanning'), completed: t('扫描完成', 'Scan complete'), cancelled: t('已取消 · 部分结果', 'Canceled · partial results'), error: t('扫描出错', 'Scan error'), idle: t('准备就绪', 'Ready') })[summary.state] : t('等待扫描', 'Ready to explore');
  const catRows = categories.map(c => ({ ...c, ...(summary?.categories.find(row => row.category === c.id) || { bytes: 0, files: 0 }) })).filter(c => c.bytes > 0 || c.files > 0).sort((a, b) => b.bytes - a.bytes);
  const currentNav = nav.find(item => item.id === page);
  const eligible = plan?.items.filter(item => item.eligible).length || 0;
  const blockedReason = (reason?: string) => {
    const reasons: Record<string, [string, string]> = {
      INVALID_PATH: ['路径无效', 'Invalid path'],
      UNSUPPORTED_VOLUME: ['此位置暂不支持安全回收', 'Trash is not supported for this location'],
      SYMLINK_PARENT: ['所在目录包含链接', 'Parent folder contains a link'],
      MISSING_FILE: ['文件已不存在', 'File no longer exists'],
      PERMISSION_DENIED: ['没有处理此文件的权限', 'Permission denied for this file'],
      UNREADABLE_FILE: ['无法读取此文件的信息', 'Unable to read file metadata'],
      NOT_IN_SCAN: ['文件不在当前扫描结果中', 'File is not part of this scan'],
      PLAN_EXPIRED: ['预览已过期，请重新选择', 'Review expired. Select files again.'],
      SCAN_CHANGED: ['扫描已更换，请重新选择', 'Scan changed. Select files again.'],
      SYSTEM_PATH: ['系统或受保护的位置', 'System or protected location'],
      HIDDEN_PATH: ['隐藏的配置或数据文件', 'Hidden configuration or data file'],
      APPLICATION_DATA: ['应用数据目录受到保护', 'Application data is protected'],
      SYMLINK: ['链接不能在此处回收', 'Links cannot be trashed here'],
      UNSUPPORTED_PATH: ['暂不支持此路径编码', 'This path encoding is not supported'],
      NOT_REGULAR_FILE: ['此版本仅支持普通文件', 'This version only supports regular files'],
      IDENTITY_CHANGED: ['文件已变化，请重新扫描', 'File changed. Scan again.'],
      PARENT_CHANGED: ['所在目录已变化，请重新扫描', 'Parent folder changed. Scan again.'],
      SHARED_FILE: ['文件与其他路径共享存储', 'Storage is shared with other paths'],
      SCAN_INCOMPLETE: ['此文件尚未完整扫描', 'This file has not been fully scanned'],
      directory: ['此版本仅支持回收单个文件', 'This version only trashes individual files'],
      not_file: ['只支持普通文件', 'Only regular files are supported'],
      symlink: ['链接不能在此处回收', 'Links cannot be trashed here'],
      protected: ['系统或受保护的位置', 'System or protected location'],
      hidden: ['隐藏的配置或数据文件', 'Hidden configuration or data file'],
      changed: ['文件已变化，请重新扫描', 'File changed. Scan again.'],
      missing: ['文件已不存在', 'File no longer exists'],
      shared: ['文件与其他路径共享存储', 'Storage is shared with other paths'],
    };
    const value = reasons[reason || ''];
    return value ? t(...value) : reason || t('无法处理', 'Cannot process');
  };

  return <div className="app-shell">
    <aside className={`sidebar ${navOpen ? 'mobile-open' : ''}`}>
      <div className="brand"><BrandMark /><div><strong>{t('盘清', 'DiskHarbor')}</strong><span>{t('让空间清清楚楚', 'Clarity for your storage')}</span></div></div>
      <div className="nav-label">{t('工作空间', 'WORKSPACE')}</div>
      <nav aria-label={t('主导航', 'Main navigation')}>{nav.map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)} aria-current={page === item.id ? 'page' : undefined}><item.icon size={20} /><span>{item.title}</span>{item.id === 'cleanup' && selected.length > 0 && <b>{selected.length}</b>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="local-note"><LockKeyhole size={17} /><div><strong>{t('你的文件，只在本机', 'Your files stay here')}</strong><span>{t('无需账号 · 本地扫描', 'No account. Local scans.')}</span></div></div><button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}><Settings2 size={19} /><span>{t('设置', 'Settings')}</span><span className="version">α 0.1</span></button></div>
    </aside>
    <main className="main-shell">
      <header className="page-header"><div className="heading"><button className="icon-btn menu-toggle" onClick={() => setNavOpen(!navOpen)} aria-label={t('切换导航', 'Toggle navigation')}><LayoutDashboard size={21} /></button><div><div className="eyebrow">{t('磁盘空间助手', 'YOUR STORAGE, UNDERSTOOD')}</div><h1>{currentNav?.title || t('设置', 'Settings')}</h1><p>{currentNav?.caption || t('按你的习惯使用盘清', 'Make DiskHarbor feel at home')}</p></div></div><div className="header-actions"><span className="alpha-badge">{info?.platform === 'win32' ? 'WINDOWS' : info?.platform === 'darwin' ? 'MACOS' : 'LINUX'} ALPHA <span>0.1</span></span><button className="language-button" onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')} aria-label={t('切换为英文', 'Switch to Chinese')}>{locale === 'zh-CN' ? 'EN' : '中文'}</button></div></header>
      {!api && <div className="banner warning"><Info size={18} />{t('当前为浏览器预览。请使用桌面应用扫描本机文件。', 'Browser preview. Use the desktop application to scan local files.')}</div>}
      {error && <div className="banner error" role="alert"><Info size={18} /><span>{error}</span><button className="icon-btn" aria-label={t('关闭提示', 'Dismiss')} onClick={() => setError('')}><X size={17} /></button></div>}
      {notice && <div className="toast" role="status"><CheckCircle2 size={18} />{notice}</div>}
      {!['history', 'settings'].includes(page) && <section className="scan-toolbar" aria-label={t('扫描位置', 'Scan location')}><div className="path-field"><HardDrive size={20} /><input aria-label={t('扫描路径', 'Scan path')} value={path} onChange={e => setPath(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !scanning) void start(); }} placeholder={t('选择磁盘或文件夹', 'Choose a disk or folder')} disabled={scanning || busy} /></div><button className="button secondary choose-button" onClick={choose} disabled={!api || scanning || busy}><FolderOpen size={17} /><span>{t('选择文件夹', 'Browse')}</span></button>{scanning ? <button className="button secondary" onClick={() => api && action(() => api.cancelScan())}><Square size={14} />{t('停止扫描', 'Stop scan')}</button> : <button className="button primary" disabled={!api || !path.trim() || busy} onClick={() => start()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Search size={17} />}{summary ? t('重新扫描', 'Scan again') : t('开始扫描', 'Start scan')}</button>}</section>}
      {summary && !['history', 'settings'].includes(page) && <div className="scan-status" role="status"><span className={`status-dot ${scanning ? 'pulse' : ''}`} />{status}<span className="separator">·</span><span>{summary.files.toLocaleString(locale)} {t('个文件', 'files')}</span><span className="separator">·</span><span>{(summary.elapsedMs / 1000).toFixed(1)} s</span>{(summary.errors > 0 || summary.skipped > 0) && <span className="coverage-note"><Info size={13} />{t(`未读取 ${summary.errors + summary.skipped} 项，结果可能不完整`, `${summary.errors + summary.skipped} unread items; results may be incomplete`)}</span>}<span className="scan-location" title={summary.rootPath}>{summary.rootPath}</span></div>}

      {!summary && !['history', 'settings'].includes(page) ? <div className="welcome-wrap"><section className="welcome"><div className="welcome-text"><span className="pill"><span />{t('本地扫描，安心整理', 'LOCAL FILES. CLEAR DECISIONS.')}</span><h2>{t('看看空间', 'Meet your storage.')}<br /><em>{t('都用在哪里。', 'Find your breathing room.')}</em></h2><p>{t('从一个文件夹开始。看懂每一份占用，', 'Start with one folder. Understand what takes up space,')}<br />{t('再决定哪些留下，哪些可以整理。', 'then decide what stays and what can go.')}</p><button className="button primary large-button" onClick={choose} disabled={!api}><FolderOpen size={19} />{t('选择一个文件夹', 'Choose a folder')}<ArrowRight size={18} /></button><small><ShieldCheck size={15} />{t('扫描只读取文件信息，不会更改你的文件', 'Scanning reads metadata without changing your files')}</small></div><div className="storage-illustration" aria-hidden="true"><div className="orbit one" /><div className="orbit two" /><div className="folder-tile tile-video"><Video size={30} /></div><div className="folder-tile tile-image"><Image size={28} /></div><div className="folder-tile tile-document"><FileText size={26} /></div><div className="drive-card"><BrandMark large /><span>DISKHARBOR</span><div className="mini-capacity"><i /><i /><i /><i /></div><div className="drive-caption"><span>{t('每一份空间，都有答案', 'A place for everything')}</span><CheckCircle2 size={15} /></div></div></div></section><section className="quick-start"><h3>{t('从常用位置开始', 'Start somewhere familiar')}</h3><div className="location-grid">{info?.locations.slice(0, 4).map(location => <button className="location-card" key={location.path} onClick={() => { setPath(location.path); void start(location.path); }}><span className="folder-icon"><Folder size={23} /></span><div><strong>{location.label === 'home' ? t('个人文件夹', 'Home folder') : location.label === 'downloads' ? t('下载', 'Downloads') : location.label === 'documents' ? t('文档', 'Documents') : location.label === 'desktop' ? t('桌面', 'Desktop') : location.label}</strong><small title={location.path}>{location.path}</small></div><ChevronRight size={16} /></button>)}</div><p className="help-note"><CircleHelp size={15} />{t('也可以在上方输入完整路径，扫描磁盘或已挂载的设备。', 'You can also enter a full path above to scan a drive or mounted device.')}</p></section></div> : null}

      {summary && page === 'overview' && <div className="overview-grid"><div className="overview-main"><section className="panel usage-panel"><div className="panel-heading"><div className="scope-heading"><span className="drive-icon"><HardDrive size={24} /></span><div><h2>{basename(summary.rootPath)}</h2><span>{t('已扫描内容 · 实际占用', 'Scanned content · allocated space')}</span></div></div><button className="text-button" onClick={() => navigate('tree')}>{t('打开文件树', 'Explore tree')}<ArrowRight size={15} /></button></div><div className="usage-value">{size(summary.scannedBytes, locale)}<span>{t('已识别占用', 'identified')}</span></div><div className="capacity-bar" role="img" aria-label={t('文件分类占用比例', 'Storage usage by file category')}>{catRows.map(c => <button key={c.id} title={`${t(c.zh, c.en)} · ${size(c.bytes, locale)}`} aria-label={`${t(c.zh, c.en)} ${size(c.bytes, locale)}`} style={{ flexGrow: c.bytes || 1, backgroundColor: c.color }} onClick={() => showFiles(c.id)} />)}</div><div className="capacity-legend">{catRows.map(c => <span key={c.id}><i style={{ background: c.color }} />{t(c.zh, c.en)}<b>{summary.scannedBytes ? Math.round(c.bytes / summary.scannedBytes * 100) : 0}%</b></span>)}</div><div className="volume-foot"><HardDrive size={14} />{summary.volume ? t(`所在磁盘可用 ${size(summary.volume.free, locale)} / 总容量 ${size(summary.volume.total, locale)}`, `Volume free ${size(summary.volume.free, locale)} / total ${size(summary.volume.total, locale)}`) : t('卷容量暂不可用', 'Volume capacity unavailable')}<span>{t('文件内容大小', 'Logical size')} {size(summary.logicalBytes, locale)}</span></div><div className="section-rule" /><div className="panel-heading compact"><h3>{t('按类型查看', 'Explore by type')}</h3><span className="small-muted">{t('点击分类查看文件', 'Select a category to explore')}</span></div><div className="category-list">{catRows.length ? catRows.map(c => <button className="category-row" key={c.id} onClick={() => showFiles(c.id)}><span className="category-icon" style={{ backgroundColor: `${c.color}24`, color: c.color }}><c.icon size={21} /></span><div><strong>{t(c.zh, c.en)}</strong><small>{c.files.toLocaleString(locale)} {t('个文件', 'files')}</small></div><div className="row-bar"><i style={{ width: `${summary.scannedBytes ? c.bytes / summary.scannedBytes * 100 : 0}%`, backgroundColor: c.color }} /></div><b>{size(c.bytes, locale)}</b><ChevronRight size={16} /></button>) : <div className="empty-inline">{scanning ? t('正在读取文件信息…', 'Reading file information…') : t('这个位置没有可统计的文件', 'No files to measure in this location')}</div>}</div></section><section className="panel folders-panel"><div className="panel-heading"><h3>{t('占用较多的文件夹', 'Largest folders')}</h3><FolderTree size={17} /></div>{topFolders.length ? topFolders.map(folder => <button className="folder-row" key={folder.id} onClick={() => showFolder(folder)}><Folder size={19} /><span>{folder.name}</span><b>{size(folder.allocatedSize, locale)}</b><ChevronRight size={16} /></button>) : <p className="empty-inline">{t('当前目录没有子文件夹', 'No subfolders in this directory')}</p>}</section></div><aside className="overview-aside"><section className="panel review-panel"><div className="panel-heading"><span className="round-icon"><Sparkles size={21} /></span><span className="tag">{t('由你决定', 'YOUR CHOICE')}</span></div><h2>{t('这些文件，', 'A little closer look')}<br />{t('值得看一看', 'can make room.')}</h2><p>{t('从大文件开始，先查看内容，再决定是否整理。', 'Start with the larger files. Take a look before deciding what to do.')}</p><div className="large-files">{topFiles.map(file => { const c = categories.find(c => c.id === file.category)!; return <button key={file.id} className="large-file" onClick={() => { setPage('files'); setCategory(undefined); setInspected(file); }}><span className="file-chip" style={{ background: `${c.color}25`, color: c.color }}><c.icon size={21} /></span><div><strong title={file.name}>{file.name}</strong><span>{size(file.allocatedSize, locale)}</span></div><ChevronRight size={14} /></button>; })}</div><button className="button primary full" onClick={() => showFiles()}>{t('查看所有文件', 'Browse all files')}<ArrowRight size={17} /></button><small><Info size={14} />{t('大文件不一定需要删除', 'Large does not mean unnecessary')}</small></section><section className="quiet-panel"><ShieldCheck size={24} /><h3>{t('整理之前，先看清楚', 'Clarity before cleanup')}</h3><p>{t('盘清不会自动删除文件。每次回收前，你都会看到具体清单。', 'Nothing is deleted automatically. Review the exact list before moving files to Trash.')}</p></section></aside></div>}

      {summary && (page === 'tree' || page === 'files') && api && <div className="explorer-layout"><section className="panel explorer-panel"><div className="explorer-heading"><div><h2>{page === 'tree' ? t('文件与文件夹', 'Files & folders') : selectedCategory ? t(selectedCategory.zh, selectedCategory.en) : t('全部文件', 'All files')}</h2><span>{t('按实际磁盘占用排序 · 仅搜索已扫描内容', 'Sorted by allocated space · search covers scanned content')}</span></div><div className="explorer-actions">{category && <button className="button small secondary" onClick={() => setCategory(undefined)}><X size={13} />{t('清除分类', 'Clear category')}</button>}{selected.length > 0 && <><button className="text-button" onClick={() => setSelected([])}>{t('取消选择', 'Clear selection')}</button><button className="button primary small" disabled={busy || scanning} onClick={review}><Trash2 size={15} />{t(`查看 ${selected.length} 项`, `Review ${selected.length}`)}</button></>}</div></div><FileExplorer api={api} summary={summary} locale={locale} mode={page === 'tree' ? 'tree' : 'files'} category={category} selectedIds={selected} onSelectionChange={setSelected} onInspect={setInspected} inspectedId={inspected?.id} focusId={focusId} /></section>{inspected && <aside className="panel details-panel"><div className="panel-heading"><h3>{t('详细信息', 'Details')}</h3><button className="icon-btn" onClick={() => setInspected(null)} aria-label={t('关闭详情', 'Close details')}><X size={18} /></button></div><div className="detail-icon">{inspected.kind === 'directory' ? <Folder size={34} /> : <File size={34} />}</div><h3 className="detail-name">{inspected.name}</h3><span className="tag">{inspected.kind === 'directory' ? t('文件夹', 'Folder') : inspected.kind === 'symlink' ? t('符号链接', 'Symbolic link') : t('文件', 'File')}</span><dl><dt>{t('磁盘占用', 'Allocated space')}</dt><dd>{size(inspected.allocatedSize, locale)}</dd><dt>{t('文件内容大小', 'Logical size')}</dt><dd>{size(inspected.logicalSize, locale)}</dd><dt>{t('修改时间', 'Modified')}</dt><dd>{new Date(inspected.modifiedAt).toLocaleString(locale)}</dd><dt>{t('完整路径', 'Full path')}</dt><dd className="detail-path">{inspected.path}</dd></dl>{inspected.shared && <p className="detail-note">{t('此文件通过硬链接共享存储，占用已去重计算。', 'This file shares storage through hard links. Allocated space is counted once.')}</p>}{inspected.error && <p className="detail-note">{inspected.error}</p>}<button className="button secondary full" onClick={() => action(() => api.reveal(inspected.id))}><FolderOpen size={16} />{t('在文件管理器中显示', 'Show in file manager')}</button><button className="text-button copy-action" onClick={() => action(() => api.copyPath(inspected.id), t('路径已复制', 'Path copied'))}><Copy size={15} />{t('复制路径', 'Copy path')}</button></aside>}</div>}

      {summary && page === 'cleanup' && <div className="cleanup-layout"><section className="panel cleanup-intro"><div className="round-icon"><Sparkles size={25} /></div><div><h2>{t('先找到，再决定', 'Find it. Review it. Decide.')}</h2><p>{t('这里帮你找到值得检查的内容。是否需要保留，始终由你决定。', 'These views help you find things worth reviewing. You decide what to keep.')}</p></div></section><div className="review-options">{[{ icon: FileArchive, title: t('安装包与压缩文件', 'Archives & installers'), desc: t('检查下载后不再需要的副本，先确认内容。', 'Review downloaded copies and check their contents first.'), cat: 'archives' as Category }, { icon: Video, title: t('视频与录屏', 'Videos & recordings'), desc: t('大体积内容可以优先检查，也可以选择迁移。', 'Review larger recordings, or move them somewhere else.'), cat: 'video' as Category }, { icon: Files, title: t('所有大文件', 'All large files'), desc: t('按大小浏览，勾选后查看清单和处理影响。', 'Browse by size, select files, and review the impact.'), cat: undefined }].map(item => <button key={item.title} className="panel review-option" onClick={() => showFiles(item.cat)}><item.icon size={26} /><h3>{item.title}</h3><p>{item.desc}</p><span>{t('查看文件', 'Review files')}<ArrowRight size={17} /></span></button>)}</div><section className="panel selected-panel"><div><h3>{t('你选中的文件', 'Your selected files')}</h3><p>{selected.length ? t(`已选择 ${selected.length} 项。下一步查看完整清单。`, `${selected.length} selected. Review the full list next.`) : t('在文件树或“我的文件”中勾选需要整理的文件。', 'Select files in File tree or My files to start a review.')}</p></div><button className="button primary" disabled={!selected.length || busy || scanning} onClick={review}><Trash2 size={16} />{t('查看处理清单', 'Review selected files')}</button></section><div className="inline-explainer"><Info size={18} /><p>{t('当前版本支持普通文件移入系统回收站。应用缓存自动识别与目录批量回收尚未开放。移入同一磁盘的回收站通常不会立即释放空间。', 'This version moves regular files to the system Trash. Application cache detection and folder cleanup are not available yet. Moving files to the same volume’s Trash usually does not immediately free space.')}</p></div></div>}

      {page === 'history' && <section className="panel history-panel"><div className="panel-heading"><div><h2>{t('本地操作记录', 'Local activity')}</h2><p className="small-muted">{t('记录保存在本机，不是文件备份。', 'Stored on this device. This is not a file backup.')}</p></div>{history.length > 0 && <button className="text-button" onClick={() => { if (api && window.confirm(t('只清除操作记录，不影响文件。继续？', 'Clear activity records only, without changing files?'))) void action(async () => { await api.clearHistory(); setHistory([]); }); }}>{t('清除记录', 'Clear activity')}</button>}</div>{history.length ? history.map(item => <article className="history-item" key={item.id}><span className="history-icon"><Trash2 size={20} /></span><div><h3>{t(`已回收 ${item.success} 个文件`, `${item.success} files moved to Trash`)}</h3><p>{new Date(item.time).toLocaleString(locale)} {item.failed > 0 && <span> · {t(`${item.failed} 项失败`, `${item.failed} failed`)}</span>}</p><details><summary>{t('查看具体文件', 'View file details')}</summary>{item.items.map((file, i) => <div className="history-file" key={i}><span>{file.path}</span><b>{file.status === 'trashed' ? t('已回收', 'Trashed') : file.status === 'cancelled' ? t('已取消', 'Canceled') : file.status === 'failed' ? t('失败', 'Failed') : file.status === 'skipped' ? t('已跳过', 'Skipped') : file.status}</b>{file.error && <small>{blockedReason(file.error)}</small>}</div>)}</details></div><div className="history-delta"><small>{t('卷可用空间变化', 'Volume free-space change')}</small><strong>{item.freeSpaceDelta == null ? '—' : `${item.freeSpaceDelta < 0 ? '−' : '+'}${size(Math.abs(item.freeSpaceDelta), locale)}`}</strong></div></article>) : <div className="empty-state"><History size={42} /><h3>{t('还没有操作记录', 'A fresh start')}</h3><p>{t('完成一次文件回收后，结果会显示在这里。', 'After you move files to Trash, the results will appear here.')}</p></div>}</section>}

      {page === 'settings' && <div className="settings-layout"><section className="panel"><div className="panel-heading"><h2>{t('使用偏好', 'Preferences')}</h2><Settings2 size={20} /></div><div className="setting-row"><div><h3>{t('界面语言', 'Interface language')}</h3><p>{t('切换语言不会中断当前扫描。', 'Switch languages without interrupting your scan.')}</p></div><select value={locale} onChange={e => setLocale(e.target.value as Locale)} aria-label={t('界面语言', 'Interface language')}><option value="zh-CN">简体中文</option><option value="en">English</option></select></div><div className="setting-row"><div><h3>{t('外观', 'Appearance')}</h3><p>{t('浅色界面 · 深青强调色', 'Light surfaces with deep teal accents')}</p></div><span className="tag">{t('浅色', 'Light')}</span></div><div className="setting-row"><div><h3>{t('数据与隐私', 'Data & privacy')}</h3><p>{t('扫描与操作记录仅保存在本机。没有账号或遥测。', 'Scans and activity stay on this device. No account or telemetry.')}</p></div><LockKeyhole size={20} /></div></section><section className="panel about-panel"><BrandMark /><h2>{t('盘清', 'DiskHarbor')}</h2><p>DiskHarbor · {info?.version || '0.1.0-alpha.1'}</p><span className="tag">{info?.platform || 'desktop'} · {t('早期测试版', 'Early alpha')}</span><p className="about-note">{t('Linux 首发验证。Windows 与 macOS 的原生运行、打包及完整适配仍需测试。', 'Validated on Linux first. Native Windows and macOS operation, packaging, and full compatibility still need testing.')}</p></section></div>}
      <footer className="app-footer"><span><LockKeyhole size={12} />{t('本地处理', 'Processed locally')}</span><span>{t('占用单位采用 1024 进制', 'Storage units use powers of 1024')}<span className="footer-dot">·</span>DiskHarbor 0.1 alpha</span></footer>
    </main>
    {plan && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) setPlan(null); }}><section className="review-modal" ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="review-title"><div className="panel-heading"><span className="round-icon"><Trash2 size={22} /></span><button className="icon-btn" disabled={busy} onClick={() => setPlan(null)} aria-label={t('关闭', 'Close')}><X size={20} /></button></div><h2 id="review-title">{t('确认要整理的文件', 'Review your selected files')}</h2><p>{t('支持的文件将移入系统回收站。请确认下面的路径和内容。', 'Eligible files will be moved to the system Trash. Check the paths and contents below.')}</p><div className="review-list">{plan.items.map(item => <div className={`review-item ${!item.eligible ? 'blocked' : ''}`} key={item.id}>{item.eligible ? <Check size={16} /> : <Info size={16} />}<div><strong>{basename(item.path)}</strong><small>{item.path}</small>{!item.eligible && <em>{blockedReason(item.reason)}</em>}</div><span>{size(item.size, locale)}</span></div>)}</div><div className="review-note"><Info size={17} /><span>{t('移入回收站不等于立即释放空间。文件的最终删除和恢复由系统回收站管理。', 'Moving to Trash does not immediately free space. Use the system Trash for final deletion or restoration.')}</span></div><div className="review-bottom"><span>{t(`${eligible} 项可处理`, `${eligible} eligible items`)}</span><button className="button secondary" onClick={() => setPlan(null)} disabled={busy}>{t('取消', 'Cancel')}</button><button className="button primary" onClick={execute} disabled={!eligible || busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}{t('继续并由系统确认', 'Continue to confirmation')}</button></div></section></div>}
  </div>;
}
