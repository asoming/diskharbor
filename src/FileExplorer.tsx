import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpLeft, ChevronDown, ChevronRight, File, Folder, Link2, LoaderCircle, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import type { Category, DiskHarborAPI, Entry, Query, Summary } from './types';
import './file-explorer.css';

export interface FileExplorerProps {
  api: DiskHarborAPI;
  summary: Summary;
  locale: 'zh-CN' | 'en';
  mode: 'tree' | 'files';
  category?: Category;
  selectedIds: number[];
  onSelectionChange(ids: number[]): void;
  onInspect(entry: Entry): void;
  inspectedId?: number;
  focusId?: number;
}

type SortKey = NonNullable<Query['sortBy']>;
interface Group { entries: Entry[]; total: number; loading: boolean; error?: string; failedAppend?: boolean }
type Row = { key: string; depth: number; parentId: number | null; entry: Entry; position: number; total: number }
  | { key: string; depth: number; parentId: number | null; action: 'loading' | 'more' | 'retry'; remaining: number };

const PAGE_SIZE = 100;
const ROW_HEIGHT = 50;
const OVERSCAN = 8;
const FLAT_KEY = 'flat';
const groupKey = (id: number | null) => id === null ? FLAT_KEY : String(id);
const messages = {
  'zh-CN': {
    search: '搜索已扫描内容', searchHint: '按名称或路径搜索…', clear: '清除搜索', minimum: '最小文件大小（逻辑大小）', allSizes: '不限大小',
    name: '名称', disk: '磁盘占用', share: '占父目录比例', count: '文件数', logical: '逻辑大小', modified: '修改时间', state: '扫描状态',
    select: '选择文件', expand: '展开', collapse: '折叠', parent: '上级目录', refresh: '刷新当前结果', columns: '显示列',
    loading: '正在读取扫描结果…', more: '加载更多', retry: '重试', empty: '此位置暂未发现内容', noMatches: '没有符合条件的已扫描内容',
    searchScope: '筛选结果 · 显示完整路径', allFiles: '所有已扫描文件 · 显示完整路径', partial: '扫描尚未完成，结果会继续更新',
    cancelled: '扫描已取消，当前为部分结果', scanError: '扫描未完成，请查看扫描状态', ready: '已扫描', pending: '扫描中',
    skipped: '已跳过', error: '读取失败', partialEntry: '部分已扫描', unknown: '未知', unknownSize: '无法确定实际磁盘占用',
    selected: '个文件已选择', shown: '项已载入', items: '项', tree: '文件树', files: '文件列表', location: '当前位置',
    filterCategory: '分类', filesOnly: '仅文件可加入清理清单', scanEmpty: '扫描进行中，新发现的项目会显示在这里。',
    emptyHint: '可更换位置，或在扫描完成后刷新。', filterHint: '尝试清除搜索或降低最小大小；筛选仅覆盖已扫描内容。',
    scopeFailure: '无法读取当前位置', loadFailure: '无法读取文件列表', next: '接下来的', of: '共',
  },
  en: {
    search: 'Search scanned items', searchHint: 'Search names or paths…', clear: 'Clear search', minimum: 'Minimum file size (logical size)', allSizes: 'Any size',
    name: 'Name', disk: 'Size on disk', share: 'Share of parent', count: 'File count', logical: 'Logical size', modified: 'Modified', state: 'Scan status',
    select: 'Select file', expand: 'Expand', collapse: 'Collapse', parent: 'Parent folder', refresh: 'Refresh current results', columns: 'Columns',
    loading: 'Reading scan results…', more: 'Load more', retry: 'Retry', empty: 'No items found in this location yet', noMatches: 'No scanned items match these filters',
    searchScope: 'Filtered results · full paths shown', allFiles: 'All scanned files · full paths shown', partial: 'Scan in progress. Results will continue to update.',
    cancelled: 'Scan cancelled. These results are incomplete.', scanError: 'Scan incomplete. Check the scan status.', ready: 'Scanned', pending: 'Scanning',
    skipped: 'Skipped', error: 'Read failed', partialEntry: 'Partially scanned', unknown: 'Unknown', unknownSize: 'Actual disk usage is unavailable',
    selected: 'files selected', shown: 'items loaded', items: 'items', tree: 'File tree', files: 'File list', location: 'Current location',
    filterCategory: 'Category', filesOnly: 'Only files can be added to the cleanup list', scanEmpty: 'New items will appear here as the scan progresses.',
    emptyHint: 'Choose another location or refresh after the scan finishes.', filterHint: 'Clear the search or lower the minimum size. Filters only cover scanned items.',
    scopeFailure: 'Unable to read this location', loadFailure: 'Unable to read the file list', next: 'Next', of: 'of',
  },
} as const;

const categories: Record<'zh-CN' | 'en', Record<Category, string>> = {
  'zh-CN': { apps: '应用与数据', video: '视频', images: '图片', documents: '文档', archives: '压缩包与安装包', audio: '音频', other: '其他', system: '系统文件' },
  en: { apps: 'Applications', video: 'Videos', images: 'Images', documents: 'Documents', archives: 'Archives & installers', audio: 'Audio', other: 'Other files', system: 'System files' },
};

function formatSize(bytes: number | null, locale: 'zh-CN' | 'en'): string {
  if (bytes === null || !Number.isFinite(bytes)) return messages[locale].unknown;
  if (bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const exponent = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))));
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: exponent ? 1 : 0 }).format(bytes / 1024 ** exponent)} ${units[exponent]}`;
}

export function FileExplorer({ api, summary, locale, mode, category, selectedIds, onSelectionChange, onInspect, inspectedId, focusId }: FileExplorerProps) {
  const t = messages[locale];
  const [scope, setScope] = useState({ scanId: summary.scanId, id: summary.rootId });
  const scopeId = scope.scanId === summary.scanId && mode === 'tree' ? scope.id : summary.rootId;
  const [search, setSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [minSize, setMinSize] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'allocatedSize', direction: 'desc' });
  const [groups, setGroups] = useState<Map<string, Group>>(new Map());
  const [entries, setEntries] = useState<Map<number, Entry>>(new Map());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [ancestors, setAncestors] = useState<Entry[]>([]);
  const [scopeError, setScopeError] = useState('');
  const [activeKey, setActiveKey] = useState<string>();
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(420);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [optionalColumns, setOptionalColumns] = useState({ logical: false, modified: false, state: false });
  const gridRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const groupsRef = useRef(groups);
  const expandedRef = useRef(expanded);
  const generation = useRef(0);
  const requestVersions = useRef(new Map<string, number>());
  const deferredRefresh = useRef(new Set<string>());
  groupsRef.current = groups;
  expandedRef.current = expanded;
  const flat = mode === 'files' || !!activeSearch || minSize > 0 || !!category;
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const mainKey = flat ? FLAT_KEY : groupKey(scopeId);

  useEffect(() => {
    const timer = window.setTimeout(() => setActiveSearch(search.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [search]);

  const fetchGroup = useCallback(async function loadGroup(parentId: number | null, append = false, refresh = false): Promise<void> {
    const key = groupKey(parentId);
    const previous = groupsRef.current.get(key);
    if (previous?.loading) { if (refresh) deferredRefresh.current.add(key); return; }
    const scanGeneration = generation.current;
    const version = (requestVersions.current.get(key) ?? 0) + 1;
    requestVersions.current.set(key, version);
    const current = () => generation.current === scanGeneration && requestVersions.current.get(key) === version;
    const loadingGroup: Group = { entries: previous?.entries ?? [], total: previous?.total ?? 0, loading: true };
    groupsRef.current = new Map(groupsRef.current).set(key, loadingGroup);
    setGroups(groupsRef.current);
    const offset = append ? previous?.entries.length ?? 0 : 0;
    const wanted = refresh ? Math.max(PAGE_SIZE, previous?.entries.length ?? 0) : PAGE_SIZE;
    try {
      // Refresh each loaded page independently: the backend may cap a query's limit.
      const collected: Entry[] = [];
      let total = 0;
      for (let pageOffset = offset; pageOffset < offset + wanted; pageOffset += PAGE_SIZE) {
        const result = await api.query({
          ...(parentId !== null ? { parentId } : { search: activeSearch || undefined, minSize: minSize || undefined, category,
            kind: mode === 'files' || category ? 'file' : undefined }),
          offset: pageOffset, limit: PAGE_SIZE, sortBy: sort.key, sortDirection: sort.direction,
        });
        if (!current()) return;
        total = result.total;
        collected.push(...result.entries);
        if (result.entries.length < PAGE_SIZE || pageOffset + result.entries.length >= result.total) break;
      }
      const combined = append ? [...(previous?.entries ?? []), ...collected] : collected;
      const unique = [...new Map(combined.map(entry => [entry.id, entry])).values()];
      groupsRef.current = new Map(groupsRef.current).set(key, { entries: unique, total, loading: false });
      setGroups(groupsRef.current);
      if (append) {
        const previousIds = new Set(previous?.entries.map(entry => entry.id));
        const firstNew = collected.find(entry => !previousIds.has(entry.id));
        if (firstNew) setActiveKey(active => active === `action-${key}` ? `entry-${firstNew.id}` : active);
      }
      setEntries(existing => { if (!current()) return existing; const next = new Map(existing); for (const entry of collected) next.set(entry.id, entry); return next; });
      const parentIds = [...new Set(collected.map(entry => entry.parentId).filter((id): id is number => id !== null))];
      // Parent metadata supplies actual parent proportions for flat search results.
      for (let index = 0; index < parentIds.length; index += 8) {
        const parents = await Promise.all(parentIds.slice(index, index + 8).map(id => api.entry(id).catch(() => null)));
        if (!current()) return;
        setEntries(existing => { if (!current()) return existing; const next = new Map(existing); for (const entry of parents) if (entry) next.set(entry.id, entry); return next; });
      }
    } catch (error) {
      if (!current()) return;
      groupsRef.current = new Map(groupsRef.current).set(key, { entries: previous?.entries ?? [], total: previous?.total ?? 0, loading: false, error: error instanceof Error ? error.message : String(error), failedAppend: append });
      setGroups(groupsRef.current);
    } finally {
      if (current() && deferredRefresh.current.delete(key)) void loadGroup(parentId, false, true);
    }
  }, [api, activeSearch, minSize, category, mode, sort.key, sort.direction]);

  useEffect(() => {
    const scanGeneration = ++generation.current;
    requestVersions.current.clear();
    deferredRefresh.current.clear();
    groupsRef.current = new Map();
    setGroups(new Map());
    setEntries(new Map());
    setExpanded(new Set());
    expandedRef.current = new Set();
    setAncestors([]);
    setScopeError('');
    setActiveKey(undefined);
    setScrollTop(0);
    if (viewportRef.current) { viewportRef.current.scrollTop = 0; viewportRef.current.scrollLeft = 0; }
    if (headerRef.current) headerRef.current.style.transform = '';
    void fetchGroup(flat ? null : scopeId);
    void Promise.all([api.entry(scopeId), api.ancestors(scopeId)]).then(([entry, path]) => {
      if (generation.current !== scanGeneration) return;
      const uniquePath = [...new Map([...path, ...(entry ? [entry] : [])].map(item => [item.id, item])).values()];
      // Resolve by parent links instead of assuming an API ordering convention.
      const byId = new Map(uniquePath.map(item => [item.id, item]));
      const ordered: Entry[] = [];
      const visited = new Set<number>();
      let current = entry;
      while (current && !visited.has(current.id)) {
        visited.add(current.id);
        ordered.unshift(current);
        current = current.parentId === null ? null : byId.get(current.parentId) ?? null;
      }
      setAncestors(ordered);
      setEntries(existing => { if (generation.current !== scanGeneration) return existing; const next = new Map(existing); for (const item of uniquePath) next.set(item.id, item); return next; });
    }).catch(error => { if (generation.current === scanGeneration) setScopeError(error instanceof Error ? error.message : String(error)); });
    return () => { generation.current += 1; };
  }, [api, summary.scanId, scopeId, flat, fetchGroup]);

  const navigate = useCallback((id: number) => {
    setSearch(''); setActiveSearch(''); setMinSize(0);
    setScope({ scanId: summary.scanId, id });
  }, [summary.scanId]);

  useEffect(() => {
    if (focusId === undefined || mode !== 'tree') return;
    let cancelled = false;
    void api.entry(focusId).then(entry => {
      if (!entry || cancelled) return;
      navigate(entry.kind === 'directory' ? entry.id : entry.parentId ?? summary.rootId);
    }).catch(() => { /* A stale overview item must not change the current location. */ });
    return () => { cancelled = true; };
  }, [api, focusId, mode, summary.scanId, summary.rootId, navigate]);

  const refresh = useCallback(() => {
    if (flat) { void fetchGroup(null, false, true); return; }
    const pending = [scopeId];
    const visited = new Set<number>();
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const entry of groupsRef.current.get(groupKey(id))?.entries ?? []) if (expandedRef.current.has(entry.id)) pending.push(entry.id);
      void fetchGroup(id, false, true);
    }
  }, [flat, fetchGroup, scopeId]);

  useEffect(() => {
    if (summary.state !== 'scanning') { refresh(); return; }
    const timer = window.setInterval(refresh, 1500);
    return () => window.clearInterval(timer);
  }, [summary.state, refresh]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setViewportHeight(element.clientHeight);
      if (headerRef.current) headerRef.current.style.width = `${Math.max(element.clientWidth, element.scrollWidth)}px`;
    });
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const toggleExpanded = (entry: Entry) => {
    if (entry.kind !== 'directory' || flat) return;
    const next = new Set(expandedRef.current);
    if (next.has(entry.id)) next.delete(entry.id);
    else { next.add(entry.id); if (!groupsRef.current.has(groupKey(entry.id))) void fetchGroup(entry.id); }
    expandedRef.current = next;
    setExpanded(next);
  };

  const rows = useMemo(() => {
    const output: Row[] = [];
    const stack: ({ type: 'group'; parentId: number | null; depth: number } | { type: 'row'; row: Row })[] = [
      { type: 'group', parentId: flat ? null : scopeId, depth: 0 },
    ];
    while (stack.length) {
      const task = stack.pop()!;
      if (task.type === 'row') { output.push(task.row); continue; }
      const group = groups.get(groupKey(task.parentId));
      if (!group) continue;
      const action = group.error ? 'retry' : group.entries.length < group.total ? group.loading ? 'loading' : 'more' : group.loading && !group.entries.length ? 'loading' : null;
      if (action) stack.push({ type: 'row', row: { key: `action-${groupKey(task.parentId)}`, depth: task.depth, parentId: task.parentId, action, remaining: Math.max(0, group.total - group.entries.length) } });
      for (let index = group.entries.length - 1; index >= 0; index--) {
        const entry = entries.get(group.entries[index].id) ?? group.entries[index];
        if (!flat && expanded.has(entry.id)) stack.push({ type: 'group', parentId: entry.id, depth: task.depth + 1 });
        stack.push({ type: 'row', row: { key: `entry-${entry.id}`, entry, parentId: entry.parentId, depth: task.depth, position: index + 1, total: group.total } });
      }
    }
    return output;
  }, [flat, scopeId, groups, entries, expanded]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const visibleRows = rows.slice(start, end);
  const activeIndex = rows.findIndex(row => row.key === activeKey);
  const activeRendered = activeIndex >= start && activeIndex < end;
  const mainGroup = groups.get(mainKey);
  const loadedCount = rows.reduce((count, row) => count + ('entry' in row ? 1 : 0), 0);
  const tableStyle = {
    '--fx-columns': `34px minmax(240px, 1fr) 130px 140px 85px${optionalColumns.logical ? ' 130px' : ''}${optionalColumns.modified ? ' 150px' : ''}${optionalColumns.state ? ' 130px' : ''}`,
    '--fx-min-width': `${629 + (optionalColumns.logical ? 130 : 0) + (optionalColumns.modified ? 150 : 0) + (optionalColumns.state ? 130 : 0)}px`,
  } as CSSProperties;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && headerRef.current) headerRef.current.style.width = `${Math.max(viewport.clientWidth, viewport.scrollWidth)}px`;
  }, [optionalColumns]);

  useEffect(() => {
    if (activeKey && !rows.some(row => row.key === activeKey)) setActiveKey(undefined);
  }, [rows, activeKey]);

  const activate = (index: number) => {
    const row = rows[index];
    if (!row) return;
    setActiveKey(row.key);
    if ('entry' in row) onInspect(row.entry);
    const viewport = viewportRef.current;
    if (viewport) {
      const top = index * ROW_HEIGHT;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + ROW_HEIGHT - viewport.clientHeight;
    }
  };

  const toggleSelected = (entry: Entry) => {
    if (entry.kind !== 'file') return;
    const next = new Set(selectedIds);
    if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id);
    onSelectionChange([...next]);
  };

  const performAction = (row: Row) => {
    if ('entry' in row || row.action === 'loading') return;
    setActiveKey(row.key);
    gridRef.current?.focus({ preventScroll: true });
    const append = row.action === 'more' || !!groups.get(groupKey(row.parentId))?.failedAppend;
    void fetchGroup(row.parentId, append, row.action === 'retry' && !append);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest('button, input, select')) return;
    if (!rows.length) return;
    const index = activeIndex < 0 ? 0 : activeIndex;
    const row = rows[index];
    if (activeIndex < 0 && ['ArrowRight', 'ArrowLeft', 'Enter', ' '].includes(event.key)) activate(index);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft', 'Enter', ' '].includes(event.key)) event.preventDefault();
    if (event.key === 'ArrowDown') activate(activeIndex < 0 ? 0 : Math.min(rows.length - 1, index + 1));
    else if (event.key === 'ArrowUp') activate(Math.max(0, index - 1));
    else if (event.key === 'Home') activate(0);
    else if (event.key === 'End') activate(rows.length - 1);
    else if ('entry' in row) {
      if (event.key === 'ArrowRight' && !flat && row.entry.kind === 'directory') {
        if (!expanded.has(row.entry.id)) toggleExpanded(row.entry);
        else if (rows[index + 1]?.depth > row.depth) activate(index + 1);
      } else if (event.key === 'ArrowLeft' && !flat) {
        if (expanded.has(row.entry.id)) toggleExpanded(row.entry);
        else { const parent = rows.findIndex(item => 'entry' in item && item.entry.id === row.parentId); if (parent >= 0) activate(parent); }
      } else if (event.key === 'Enter') {
        if (row.entry.kind === 'directory' && mode === 'tree' && !category) navigate(row.entry.id);
        else onInspect(row.entry);
      } else if (event.key === ' ') toggleSelected(row.entry);
    } else if (event.key === 'Enter') performAction(row);
  };

  const changeSort = (key: SortKey) => setSort(previous => ({ key, direction: previous.key === key ? previous.direction === 'asc' ? 'desc' : 'asc' : key === 'name' ? 'asc' : 'desc' }));
  const sortHeader = (label: string, key: SortKey) => (
    <div role="columnheader" aria-sort={sort.key === key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
      <button className="fx-sort" onClick={() => changeSort(key)}>{label}{sort.key === key && (sort.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button>
    </div>
  );
  const stateLabel = (entry: Entry) => entry.state === 'partial' ? t.partialEntry : t[entry.state];
  const rootName = entries.get(summary.rootId)?.name || summary.rootPath;

  return <section className="fx-explorer" aria-label={mode === 'tree' ? t.tree : t.files}>
    <div className="fx-toolbar">
      <div className="fx-search"><Search size={16} aria-hidden="true" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={t.searchHint} aria-label={t.search} />{search && <button className="fx-icon-button" aria-label={t.clear} onClick={() => { setSearch(''); setActiveSearch(''); }}><X size={14} /></button>}</div>
      <label className="fx-size-filter"><span className="fx-sr-only">{t.minimum}</span><select value={minSize} title={t.minimum} onChange={event => setMinSize(Number(event.target.value))}><option value={0}>{t.allSizes}</option>{[10 * 1024 ** 2, 100 * 1024 ** 2, 1024 ** 3].map(value => <option key={value} value={value}>{t.logical} ≥ {formatSize(value, locale)}</option>)}</select></label>
      {category && <span className={`fx-category fx-category-${category}`}>{t.filterCategory}: {categories[locale][category]}</span>}
      <div className="fx-toolbar-spacer" />
      <div className="fx-column-control"><button className="fx-tool-button" onClick={() => setColumnsOpen(!columnsOpen)} aria-expanded={columnsOpen}><SlidersHorizontal size={15} />{t.columns}</button>{columnsOpen && <div className="fx-column-menu" onKeyDown={event => { if (event.key === 'Escape') setColumnsOpen(false); }}>{(['logical', 'modified', 'state'] as const).map(key => <label key={key}><input type="checkbox" checked={optionalColumns[key]} onChange={() => setOptionalColumns(previous => ({ ...previous, [key]: !previous[key] }))} />{t[key]}</label>)}</div>}</div>
      <button className="fx-icon-button fx-refresh" aria-label={t.refresh} title={t.refresh} onClick={refresh}><RefreshCw size={16} /></button>
    </div>

    <div className="fx-context">
      {!flat ? <nav className="fx-breadcrumbs" aria-label={t.location}>
        <button className="fx-icon-button" title={t.parent} aria-label={t.parent} disabled={scopeId === summary.rootId || entries.get(scopeId)?.parentId == null} onClick={() => { const parent = entries.get(scopeId)?.parentId; if (parent !== null && parent !== undefined) navigate(parent); }}><ArrowUpLeft size={16} /></button>
        {(ancestors.length ? ancestors : [{ id: summary.rootId, name: rootName, path: summary.rootPath }]).map((entry, index, all) => <span className="fx-breadcrumb" key={entry.id}>{index > 0 && <ChevronRight size={12} />}<button title={entry.path} aria-current={index === all.length - 1 ? 'location' : undefined} onClick={() => navigate(entry.id)}>{entry.name || entry.path}</button></span>)}
      </nav> : <div className="fx-flat-context"><span>{mode === 'files' && !activeSearch && !minSize && !category ? t.allFiles : t.searchScope}</span><span className="fx-scope-path" title={summary.rootPath}>{summary.rootPath}</span></div>}
      <span className="fx-result-count">{number.format(mainGroup?.total ?? 0)} {t.items}</span>
    </div>
    {scopeError && <div className="fx-notice fx-error" role="alert">{t.scopeFailure}: {scopeError}</div>}
    {mainGroup?.error && <div className="fx-notice fx-error" role="alert">{t.loadFailure}: {mainGroup.error}</div>}

    <div className="fx-table" style={tableStyle} role={flat ? 'grid' : 'treegrid'} aria-label={flat ? t.files : t.tree} aria-rowcount={-1} aria-colcount={5 + Object.values(optionalColumns).filter(Boolean).length} aria-multiselectable="true" aria-activedescendant={activeRendered ? `fx-${activeKey}` : undefined} tabIndex={0} ref={gridRef} onKeyDown={onKeyDown}>
      <div className="fx-header-clip"><div className="fx-header" ref={headerRef} role="row"><div role="columnheader"><span className="fx-sr-only">{t.select}</span></div>{sortHeader(t.name, 'name')}{sortHeader(t.disk, 'allocatedSize')}<div role="columnheader">{t.share}</div><div role="columnheader">{t.count}</div>{optionalColumns.logical && sortHeader(t.logical, 'logicalSize')}{optionalColumns.modified && sortHeader(t.modified, 'modifiedAt')}{optionalColumns.state && <div role="columnheader">{t.state}</div>}</div></div>
      <div className="fx-viewport" ref={viewportRef} onScroll={event => { setScrollTop(event.currentTarget.scrollTop); if (headerRef.current) headerRef.current.style.transform = `translateX(${-event.currentTarget.scrollLeft}px)`; }} role="rowgroup">
        {rows.length === 0 ? <div className="fx-empty"><Folder size={32} strokeWidth={1.4} /><strong>{mainGroup?.loading ? t.loading : flat ? t.noMatches : t.empty}</strong><p>{flat ? t.filterHint : summary.state === 'scanning' ? t.scanEmpty : t.emptyHint}</p></div> : <div className="fx-virtual-space" style={{ height: rows.length * ROW_HEIGHT }}>
          {visibleRows.map((row, localIndex) => {
            const rowIndex = start + localIndex;
            const style = { transform: `translateY(${rowIndex * ROW_HEIGHT}px)`, height: ROW_HEIGHT };
            if (!('entry' in row)) return <div key={row.key} id={`fx-${row.key}`} className={`fx-load-row ${activeKey === row.key ? 'fx-active' : ''}`} style={style} role="row" aria-rowindex={rowIndex + 2}><div role="gridcell" aria-colspan={5 + Object.values(optionalColumns).filter(Boolean).length} style={{ paddingLeft: 48 + row.depth * 20 }}>{row.action === 'loading' ? <span className="fx-loading"><LoaderCircle size={15} className="fx-spinner" />{t.loading}</span> : <><button onClick={() => performAction(row)}>{row.action === 'retry' ? t.retry : `${t.more} · ${Math.min(PAGE_SIZE, row.remaining)} / ${number.format(row.remaining)}`}</button>{row.action === 'retry' && <span className="fx-inline-error" title={groups.get(groupKey(row.parentId))?.error}>{groups.get(groupKey(row.parentId))?.error}</span>}</>}</div></div>;
            const entry = row.entry;
            const parent = entry.parentId === null ? undefined : entries.get(entry.parentId);
            const ratio = entry.allocatedSize !== null && parent?.allocatedSize !== null && parent?.allocatedSize !== undefined && parent.allocatedSize > 0 ? entry.allocatedSize / parent.allocatedSize : null;
            const Icon = entry.kind === 'directory' ? Folder : entry.kind === 'symlink' ? Link2 : File;
            const current = inspectedId === entry.id;
            return <div key={row.key} id={`fx-${row.key}`} className={`fx-row ${current ? 'fx-inspected' : ''} ${selected.has(entry.id) ? 'fx-selected' : ''} ${activeKey === row.key ? 'fx-active' : ''}`} style={style} role="row" aria-rowindex={rowIndex + 2} aria-level={flat ? undefined : row.depth + 1} aria-posinset={flat ? undefined : row.position} aria-setsize={flat ? undefined : row.total} aria-expanded={!flat && entry.kind === 'directory' ? expanded.has(entry.id) : undefined} aria-selected={selected.has(entry.id)} onClick={() => { activate(rowIndex); gridRef.current?.focus({ preventScroll: true }); }} onDoubleClick={() => { if (entry.kind === 'directory' && mode === 'tree' && !category) navigate(entry.id); }}>
              <div className="fx-check-cell" role="gridcell">{entry.kind === 'file' ? <input type="checkbox" checked={selected.has(entry.id)} aria-label={`${t.select}: ${entry.name}`} onClick={event => event.stopPropagation()} onChange={() => toggleSelected(entry)} /> : <span title={t.filesOnly} />}</div>
              <div className="fx-name-cell" role="gridcell" style={{ paddingLeft: 8 + (flat ? 0 : row.depth * 20) }}>
                {!flat && entry.kind === 'directory' ? <button className="fx-expand" aria-label={`${expanded.has(entry.id) ? t.collapse : t.expand}: ${entry.name}`} tabIndex={-1} onClick={event => { event.stopPropagation(); toggleExpanded(entry); }}>{expanded.has(entry.id) ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button> : <span className="fx-expand-space" />}
                <Icon size={18} className={entry.kind === 'directory' ? 'fx-folder-icon' : `fx-file-icon fx-category-${entry.category}`} aria-hidden="true" />
                <div className="fx-file-label"><span className="fx-filename" title={entry.path}>{entry.name || entry.path}</span>{flat && <span className="fx-path" title={entry.path}>{entry.path}</span>}</div>
                {entry.state !== 'ready' && <span className={`fx-state-dot fx-state-${entry.state}`} title={entry.error || stateLabel(entry)} aria-label={stateLabel(entry)} />}
              </div>
              <div className={`fx-number ${entry.allocatedSize === null ? 'fx-unknown' : ''}`} role="gridcell" title={entry.allocatedSize === null ? t.unknownSize : `${number.format(entry.allocatedSize)} B`}>{formatSize(entry.allocatedSize, locale)}</div>
              <div className="fx-proportion" role="gridcell"><span className="fx-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, (ratio ?? 0) * 100))}%` }} /></span><span>{ratio === null ? '—' : `${number.format(Math.round(ratio * 1000) / 10)}%`}</span></div>
              <div className="fx-number fx-count" role="gridcell">{number.format(entry.fileCount)}</div>
              {optionalColumns.logical && <div className="fx-number" role="gridcell">{formatSize(entry.logicalSize, locale)}</div>}
              {optionalColumns.modified && <div className="fx-date" role="gridcell">{entry.modifiedAt > 0 ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(entry.modifiedAt) : '—'}</div>}
              {optionalColumns.state && <div className="fx-state-text" role="gridcell" title={entry.error}>{stateLabel(entry)}</div>}
            </div>;
          })}
        </div>}
      </div>
    </div>
    <footer className="fx-footer"><span>{number.format(loadedCount)} {t.shown}{selectedIds.length > 0 && <span className="fx-selection-count"> · {number.format(selectedIds.length)} {t.selected}</span>}</span><span role="status">{summary.state === 'scanning' ? t.partial : summary.state === 'cancelled' ? t.cancelled : summary.state === 'error' ? t.scanError : ''}</span></footer>
  </section>;
}
