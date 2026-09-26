import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpLeft, ChevronDown, ChevronRight, File, Folder, Link2, LoaderCircle, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import type { Category, DiskHarborAPI, Entry, Query, Summary } from './types';
import { errorText } from './errors';
import { createExplorerMemory, defaultExplorerPreferences, DEFAULT_EXPLORER_VISIBILITY, explorerMemoryKey, explorerViewKey, focusScrollTop, isExplorerEntryVisible, locationCandidates, nearestResolvedDirectory, prepareExplorerRoot, rememberExplorerView, restoredActiveId, restorePageBudget } from './file-explorer-memory';
import type { ExplorerMemory, ExplorerPreferences, ExplorerViewMemory, ExplorerVisibility } from './file-explorer-memory';
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
  selectionDisabled?: boolean;
  memory?: ExplorerMemory;
  visibility?: ExplorerVisibility;
}

type SortKey = NonNullable<Query['sortBy']>;
interface Group { entries: Entry[]; total: number; filteredCount?: number; loading: boolean; error?: string; failedAppend?: boolean }
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
    select: '选择项目', expand: '展开', collapse: '折叠', parent: '上级目录', refresh: '刷新当前结果', columns: '显示列',
    loading: '正在读取扫描结果…', more: '加载更多', retry: '重试', empty: '此位置暂未发现内容', noMatches: '没有符合条件的已扫描内容',
    searchScope: '筛选结果 · 显示完整路径', allFiles: '所有已扫描文件 · 显示完整路径', partial: '扫描尚未完成，结果会继续更新',
    cancelled: '扫描已取消，当前为部分结果', scanError: '扫描未完成，请查看扫描状态', ready: '已扫描', pending: '扫描中',
    skipped: '已跳过', error: '读取失败', partialEntry: '部分已扫描', unknown: '未知', unknownSize: '无法确定实际磁盘占用',
    selected: '项已选择', shown: '项已载入', items: '项', tree: '文件树', files: '文件列表', location: '当前位置',
    filterCategory: '分类', filesOnly: '只有普通文件和文件夹可加入清理清单', folderSelection: '审阅整个文件夹及其内容', scanEmpty: '扫描进行中，新发现的项目会显示在这里。',
    emptyHint: '可更换位置，或在扫描完成后刷新。', filterHint: '尝试清除搜索或降低最小大小；筛选仅覆盖已扫描内容。',
    restoreWait: '扫描完成后将恢复上次浏览位置；未完成的扫描不会清除记忆。', restoreBusy: '正在恢复浏览位置…', keepLocation: '留在当前目录', restoredParent: '上次的目录未出现在本次扫描中，已回到可用的上级目录。', restoreLimited: '已恢复部分浏览记录；其余内容可继续展开或加载。',
    scopeFailure: '无法读取当前位置', loadFailure: '无法读取文件列表', next: '接下来的', of: '共',
    keyboard: '方向键浏览或展开折叠；Home、End 移至已载入行的首尾，Page Up、Page Down 翻页；空格切换清理选择，Enter 打开目录或加载更多。',
    hiddenParent: '显示设置已隐藏原位置，已返回可见上级目录。',
    hiddenDirect: '个当前目录的直接子项被显示设置隐藏', hiddenMatches: '个匹配项被显示设置隐藏', hiddenScope: '非全盘计数；目录大小与占比仍按完整扫描计算。',
  },
  en: {
    search: 'Search scanned items', searchHint: 'Search names or paths…', clear: 'Clear search', minimum: 'Minimum file size (logical size)', allSizes: 'Any size',
    name: 'Name', disk: 'Size on disk', share: 'Share of parent', count: 'File count', logical: 'Logical size', modified: 'Modified', state: 'Scan status',
    select: 'Select item', expand: 'Expand', collapse: 'Collapse', parent: 'Parent folder', refresh: 'Refresh current results', columns: 'Columns',
    loading: 'Reading scan results…', more: 'Load more', retry: 'Retry', empty: 'No items found in this location yet', noMatches: 'No scanned items match these filters',
    searchScope: 'Filtered results · full paths shown', allFiles: 'All scanned files · full paths shown', partial: 'Scan in progress. Results will continue to update.',
    cancelled: 'Scan cancelled. These results are incomplete.', scanError: 'Scan incomplete. Check the scan status.', ready: 'Scanned', pending: 'Scanning',
    skipped: 'Skipped', error: 'Read failed', partialEntry: 'Partially scanned', unknown: 'Unknown', unknownSize: 'Actual disk usage is unavailable',
    selected: 'items selected', shown: 'items loaded', items: 'items', tree: 'File tree', files: 'File list', location: 'Current location',
    filterCategory: 'Category', filesOnly: 'Only regular files and folders can be added to cleanup', folderSelection: 'Review the entire folder and its contents', scanEmpty: 'New items will appear here as the scan progresses.',
    emptyHint: 'Choose another location or refresh after the scan finishes.', filterHint: 'Clear the search or lower the minimum size. Filters only cover scanned items.',
    restoreWait: 'Your previous location will return when scanning finishes. Incomplete scans keep that memory.', restoreBusy: 'Restoring your location…', keepLocation: 'Stay in this folder', restoredParent: 'The previous folder was not found in this scan. Showing an available parent.', restoreLimited: 'Part of your browsing history was restored. Expand folders or load more to continue.',
    scopeFailure: 'Unable to read this location', loadFailure: 'Unable to read the file list', next: 'Next', of: 'of',
    keyboard: 'Use arrow keys to browse or expand and collapse. Home and End reach the first and last loaded rows; Page Up and Page Down move by a page. Space toggles cleanup selection. Enter opens a folder or loads more.',
    hiddenParent: 'Display settings hid the previous location. Showing a visible parent.',
    hiddenDirect: 'direct children of this folder hidden by display settings', hiddenMatches: 'matching items hidden by display settings', hiddenScope: 'Not a disk-wide count. Folder sizes and proportions still use the full scan.',
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

export function FileExplorer({ api, summary, locale, mode, category, selectedIds, onSelectionChange, onInspect, inspectedId, focusId, selectionDisabled = false, memory, visibility = DEFAULT_EXPLORER_VISIBILITY }: FileExplorerProps) {
  const t = messages[locale];
  const instructionsId = useId();
  const columnsId = useId();
  const columnButtonRef = useRef<HTMLButtonElement>(null);
  const localMemory = useRef(createExplorerMemory());
  const session = memory ?? localMemory.current;
  const initialPreferences = session.rootPath === summary.rootPath ? session.preferences[mode] : defaultExplorerPreferences();
  const [scope, setScope] = useState({ scanId: summary.scanId, id: summary.rootId, path: summary.rootPath });
  const scopeId = scope.scanId === summary.scanId && mode === 'tree' ? scope.id : summary.rootId;
  const [search, setSearch] = useState(initialPreferences.search);
  const [activeSearch, setActiveSearch] = useState(initialPreferences.search.trim());
  const [minSize, setMinSize] = useState(initialPreferences.minSize);
  const [sort, setSort] = useState(initialPreferences.sort);
  const [groups, setGroups] = useState<Map<string, Group>>(new Map());
  const [entries, setEntries] = useState<Map<number, Entry>>(new Map());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [ancestors, setAncestors] = useState<Entry[]>([]);
  const [scopeError, setScopeError] = useState('');
  const [activeKey, setActiveKey] = useState<string>();
  const [scrollTop, setScrollTop] = useState(0);
  const [restorePosition, setRestorePosition] = useState<{ top: number; left: number; saved: ExplorerViewMemory } | null>(null);
  const [keyboardPosition, setKeyboardPosition] = useState<{ key: string; top: number } | null>(null);
  const [viewportHeight, setViewportHeight] = useState(420);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [optionalColumns, setOptionalColumns] = useState(initialPreferences.columns);
  const [viewReady, setViewReady] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [waitingForScan, setWaitingForScan] = useState(false);
  const [restoreNotice, setRestoreNotice] = useState<'parent' | 'hidden' | 'limited' | ''>('');
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const { includeHidden, includeSystem } = visibility;
  const memoryKey = explorerMemoryKey(mode, visibility);
  const contextKey = JSON.stringify([summary.scanId, summary.rootPath, mode, category ?? '', includeHidden, includeSystem]);
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  const previousMemory = useRef({ rootPath: summary.rootPath, mode, key: memoryKey });
  const bootstrapVersion = useRef(0);
  const waitingRef = useRef(false);
  const restoringRef = useRef(false);
  const summaryRef = useRef(summary);
  const pendingScroll = useRef<ExplorerViewMemory | null>(null);
  const activeView = useRef<{ key: string; scanId: string; contextKey: string } | null>(null);
  const saveCurrent = useRef<(top?: number, left?: number) => void>(() => {});
  const focusOrigin = useRef({ id: focusId, scanId: summary.scanId });
  const appliedFocus = useRef<string | undefined>(undefined);
  summaryRef.current = summary;
  if (focusOrigin.current.id !== focusId) {
    focusOrigin.current = { id: focusId, scanId: summary.scanId };
    appliedFocus.current = undefined;
  }
  const gridRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const groupsRef = useRef(groups);
  const expandedRef = useRef(expanded);
  const generation = useRef(0);
  const requestVersions = useRef(new Map<string, number>());
  const deferredRefresh = useRef(new Set<string>());
  const previousScanState = useRef({ scanId: summary.scanId, state: summary.state });
  const terminalRefreshPending = useRef<string | null>(null);
  const flat = mode === 'files' || !!activeSearch || minSize > 0 || !!category;
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const mainKey = flat ? FLAT_KEY : groupKey(scopeId);
  const preferences: ExplorerPreferences = { search: activeSearch, minSize, sort, columns: optionalColumns };
  const viewKey = explorerViewKey(mode, scope.path, preferences, category, visibility);

  // Resolve locations from paths on every mount/scan, never from an old entry ID.
  // A cancelled or incomplete replacement scan cannot prove a path disappeared.
  useEffect(() => {
    const version = ++bootstrapVersion.current;
    generation.current += 1;
    setViewReady('');
    restoringRef.current = true;
    setRestoring(true);
    setScopeError('');
    setRestoreNotice('');
    prepareExplorerRoot(session, summary.rootPath, summary.scanId);
    const savedPreferences = session.preferences[mode];
    setSearch(savedPreferences.search);
    setActiveSearch(savedPreferences.search.trim());
    setMinSize(savedPreferences.minSize);
    setSort(savedPreferences.sort);
    setOptionalColumns(savedPreferences.columns);
    const sameLocationContext = previousMemory.current.rootPath === summary.rootPath && previousMemory.current.mode === mode;
    const previousKey = sameLocationContext ? previousMemory.current.key : mode;
    const changedVisibility = sameLocationContext && previousKey !== memoryKey;
    previousMemory.current = { rootPath: summary.rootPath, mode, key: memoryKey };
    // A live display change first checks the folder currently being viewed.
    // Otherwise an older location for the destination mode could conceal the
    // fact that the current folder became hidden instead of explaining it.
    const locationKey = changedVisibility && session.locations[previousKey] ? previousKey
      : session.locations[memoryKey] ? memoryKey : session.locations[previousKey] ? previousKey : mode;
    const rememberedLocation = session.locations[locationKey];
    const wait = session.scanIds[locationKey] !== summary.scanId && rememberedLocation !== undefined && summaryRef.current.state !== 'completed';
    waitingRef.current = wait;
    setWaitingForScan(wait);
    const location = wait || mode === 'files' ? undefined : rememberedLocation;
    const candidates = locationCandidates(location, summary.rootPath);
    void api.resolvePaths(candidates, summary.scanId).then(resolved => {
      if (bootstrapVersion.current !== version || summaryRef.current.scanId !== summary.scanId || contextRef.current !== contextKey) return;
      const entry = nearestResolvedDirectory(candidates, resolved, visibility, summary.rootPath);
      if (!entry) throw new Error('ENTRY_UNAVAILABLE');
      setScope({ scanId: summary.scanId, id: entry.id, path: entry.path });
      if (!wait) {
        session.scanIds[memoryKey] = summary.scanId;
        if (location && entry.path !== location.path) {
          const original = resolved.find(item => item?.path === location.path);
          setRestoreNotice(original && !isExplorerEntryVisible(original, visibility, summary.rootPath) ? 'hidden' : 'parent');
        }
      }
      setViewReady(contextKey);
    }).catch(error => {
      if (bootstrapVersion.current === version && summaryRef.current.scanId === summary.scanId && contextRef.current === contextKey) {
        setScopeError(error instanceof Error ? error.message : String(error));
        restoringRef.current = false;
        setRestoring(false);
      }
    });
    return () => { bootstrapVersion.current += 1; };
  }, [api, session, contextKey, restoreAttempt]);

  useEffect(() => {
    if (waitingForScan && summary.state === 'completed') setRestoreAttempt(value => value + 1);
  }, [waitingForScan, summary.state]);

  useEffect(() => {
    if (viewReady === contextKey && !waitingRef.current) {
      session.preferences[mode] = { search, minSize, sort, columns: optionalColumns };
    }
  }, [session, mode, search, minSize, sort, optionalColumns, viewReady, contextKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => setActiveSearch(search.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [search]);

  const fetchGroup = useCallback(async function loadGroup(parentId: number | null, append = false, refresh = false, restoreCount = PAGE_SIZE): Promise<void> {
    if (contextRef.current !== contextKey || summaryRef.current.scanId !== summary.scanId) return;
    const key = groupKey(parentId);
    const previous = groupsRef.current.get(key);
    if (previous?.loading) { if (refresh) deferredRefresh.current.add(key); return; }
    const scanGeneration = generation.current;
    const scanId = summary.scanId;
    const version = (requestVersions.current.get(key) ?? 0) + 1;
    requestVersions.current.set(key, version);
    const current = () => summaryRef.current.scanId === scanId && contextRef.current === contextKey && generation.current === scanGeneration && requestVersions.current.get(key) === version;
    const loadingGroup: Group = { entries: previous?.entries ?? [], total: previous?.total ?? 0, filteredCount: previous?.filteredCount, loading: true };
    groupsRef.current = new Map(groupsRef.current).set(key, loadingGroup);
    setGroups(groupsRef.current);
    const offset = append ? previous?.entries.length ?? 0 : 0;
    const wanted = refresh ? Math.max(PAGE_SIZE, previous?.entries.length ?? 0) : restoreCount;
    try {
      // Refresh each loaded page independently: the backend may cap a query's limit.
      const collected: Entry[] = [];
      let total = 0;
      let filteredCount: number | undefined;
      for (let pageOffset = offset; pageOffset < offset + wanted; pageOffset += PAGE_SIZE) {
        const result = await api.query({
          ...(parentId !== null ? { parentId } : { search: activeSearch || undefined, minSize: minSize || undefined, category,
            kind: mode === 'files' || category ? 'file' : undefined }),
          offset: pageOffset, limit: PAGE_SIZE, sortBy: sort.key, sortDirection: sort.direction,
          includeHidden, includeSystem,
        });
        if (!current()) return;
        total = result.total;
        filteredCount = result.filteredCount;
        collected.push(...result.entries);
        if (result.entries.length < PAGE_SIZE || pageOffset + result.entries.length >= result.total) break;
      }
      const combined = append ? [...(previous?.entries ?? []), ...collected] : collected;
      const unique = [...new Map(combined.map(entry => [entry.id, entry])).values()];
      groupsRef.current = new Map(groupsRef.current).set(key, { entries: unique, total, filteredCount, loading: false });
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
      groupsRef.current = new Map(groupsRef.current).set(key, { entries: previous?.entries ?? [], total: previous?.total ?? 0, filteredCount: previous?.filteredCount, loading: false, error: error instanceof Error ? error.message : String(error), failedAppend: append });
      setGroups(groupsRef.current);
    } finally {
      if (current() && deferredRefresh.current.delete(key)) void loadGroup(parentId, false, true);
    }
  }, [api, activeSearch, minSize, category, mode, sort.key, sort.direction, includeHidden, includeSystem, contextKey, summary.scanId]);

  useEffect(() => {
    const scanGeneration = ++generation.current;
    const scanId = summary.scanId;
    const current = () => generation.current === scanGeneration && summaryRef.current.scanId === scanId && contextRef.current === contextKey;
    requestVersions.current.clear();
    deferredRefresh.current.clear();
    groupsRef.current = new Map();
    setGroups(new Map());
    setEntries(new Map());
    setExpanded(new Set());
    expandedRef.current = new Set();
    setAncestors([]);
    setActiveKey(undefined);
    setScrollTop(0);
    setRestorePosition(null);
    setKeyboardPosition(null);
    pendingScroll.current = null;
    activeView.current = null;
    if (viewportRef.current) { viewportRef.current.scrollTop = 0; viewportRef.current.scrollLeft = 0; }
    if (headerRef.current) headerRef.current.style.transform = '';
    if (viewReady !== contextKey || scope.scanId !== scanId) return () => { generation.current += 1; };
    setScopeError('');
    restoringRef.current = true;
    setRestoring(true);
    const saved = waitingRef.current ? undefined : session.views.get(viewKey);
    activeView.current = { key: viewKey, scanId, contextKey };
    if (saved?.limited) setRestoreNotice(notice => notice || 'limited');
    void (async () => {
      const [entry, path, resolved] = await Promise.all([
        api.entry(scopeId), api.ancestors(scopeId),
        saved && !flat ? api.resolvePaths(saved.expandedPaths, scanId) : Promise.resolve([]),
      ]);
      if (!current()) return;
      const uniquePath = [...new Map([...path, ...(entry ? [entry] : [])].map(item => [item.id, item])).values()];
      const byId = new Map(uniquePath.map(item => [item.id, item]));
      const ordered: Entry[] = [];
      const visited = new Set<number>();
      let ancestor = entry;
      while (ancestor && !visited.has(ancestor.id)) {
        visited.add(ancestor.id);
        ordered.unshift(ancestor);
        ancestor = ancestor.parentId === null ? null : byId.get(ancestor.parentId) ?? null;
      }
      const directories = resolved.filter((value, index): value is Entry => value?.kind === 'directory' && value.path === saved?.expandedPaths[index] && isExplorerEntryVisible(value, visibility, summary.rootPath));
      const allMetadata = [...uniquePath, ...directories];
      setAncestors(ordered);
      setEntries(existing => {
        if (!current()) return existing;
        const next = new Map(existing);
        for (const item of allMetadata) next.set(item.id, item);
        return next;
      });
      const expandedIds = new Set(directories.map(item => item.id));
      expandedRef.current = expandedIds;
      setExpanded(expandedIds);
      const pages = restorePageBudget(scope.path, directories.map(item => item.path), saved?.pages ?? []);
      const counts = new Map(pages.map(page => [page.path, page.count]));
      await Promise.all([
        fetchGroup(flat ? null : scopeId, false, false, counts.get(scope.path)),
        ...directories.map(item => fetchGroup(item.id, false, false, counts.get(item.path))),
      ]);
      if (!current()) return;
      pendingScroll.current = saved ?? null;
    })().catch(error => {
      if (current()) setScopeError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (current()) { restoringRef.current = false; setRestoring(false); } });
    return () => { generation.current += 1; };
  }, [api, summary.scanId, scopeId, scope.path, flat, fetchGroup, viewReady, contextKey, session]);

  const keepCurrentLocation = useCallback(() => {
    if (viewReady !== contextKey) return;
    waitingRef.current = false;
    setWaitingForScan(false);
    session.scanIds[memoryKey] = summary.scanId;
    session.locations[memoryKey] = { path: scope.path, ancestors: ancestors.map(entry => entry.path) };
  }, [session, summary.scanId, memoryKey, scope.path, ancestors, viewReady, contextKey]);

  const navigate = useCallback((id: number) => {
    if (viewReady !== contextKey) return;
    const entry = entries.get(id);
    if (!entry || entry.kind !== 'directory' || !isExplorerEntryVisible(entry, visibility, summary.rootPath)) return;
    saveCurrent.current();
    keepCurrentLocation();
    setSearch(''); setActiveSearch(''); setMinSize(0);
    setScope({ scanId: summary.scanId, id, path: entry.path });
  }, [summary.scanId, summary.rootPath, entries, viewReady, contextKey, keepCurrentLocation, includeHidden, includeSystem]);

  useEffect(() => {
    if (focusId === undefined || mode !== 'tree' || viewReady !== contextKey || focusOrigin.current.scanId !== summary.scanId) return;
    const token = `${summary.scanId}:${focusId}`;
    if (appliedFocus.current === token) return;
    let cancelled = false;
    const scanId = summary.scanId;
    void api.entry(focusId).then(async entry => {
      if (!entry || cancelled || summaryRef.current.scanId !== scanId || contextRef.current !== contextKey) return;
      const directory = entry.kind === 'directory' ? entry : await api.entry(entry.parentId ?? summary.rootId);
      if (!directory || cancelled || summaryRef.current.scanId !== scanId || contextRef.current !== contextKey || !isExplorerEntryVisible(directory, visibility, summary.rootPath)) return;
      appliedFocus.current = token;
      saveCurrent.current();
      keepCurrentLocation();
      setSearch(''); setActiveSearch(''); setMinSize(0);
      setScope({ scanId, id: directory.id, path: directory.path });
    }).catch(() => { /* A stale overview item must not change the current location. */ });
    return () => { cancelled = true; };
  }, [api, focusId, mode, summary.scanId, summary.rootId, viewReady, contextKey, keepCurrentLocation]);

  const refresh = useCallback(() => {
    if (viewReady !== contextKey || restoringRef.current || pendingScroll.current || restorePosition) return false;
    if (flat) { void fetchGroup(null, false, true); return true; }
    const pending = [scopeId];
    const visited = new Set<number>();
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      for (const entry of groupsRef.current.get(groupKey(id))?.entries ?? []) if (expandedRef.current.has(entry.id)) pending.push(entry.id);
      void fetchGroup(id, false, true);
    }
    return true;
  }, [flat, fetchGroup, scopeId, viewReady, contextKey, restorePosition]);

  useEffect(() => {
    const previous = previousScanState.current;
    previousScanState.current = { scanId: summary.scanId, state: summary.state };
    if (previous.scanId !== summary.scanId) terminalRefreshPending.current = null;
    else if (previous.state === 'scanning' && ['completed', 'cancelled', 'error'].includes(summary.state)) {
      terminalRefreshPending.current = summary.scanId;
    }
    if (summary.state === 'scanning') {
      const timer = window.setInterval(refresh, 1500);
      return () => window.clearInterval(timer);
    }
    // Scope/query restoration already loads its own groups. Only a scan ending
    // needs another snapshot; defer it until any position restoration finishes.
    if (terminalRefreshPending.current === summary.scanId && refresh()) terminalRefreshPending.current = null;
  }, [summary.scanId, summary.state, refresh, restoring]);

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
    if (entry.kind !== 'directory' || flat || restoring || viewReady !== contextKey || !isExplorerEntryVisible(entry, visibility, summary.rootPath)) return;
    if (waitingRef.current) keepCurrentLocation();
    const next = new Set(expandedRef.current);
    if (next.has(entry.id)) next.delete(entry.id);
    else { next.add(entry.id); if (!groupsRef.current.has(groupKey(entry.id))) void fetchGroup(entry.id); }
    expandedRef.current = next;
    setExpanded(next);
  };

  const rows = useMemo(() => {
    const output: Row[] = [];
    if (viewReady !== contextKey || scope.scanId !== summary.scanId) return output;
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
  }, [flat, scopeId, groups, entries, expanded, viewReady, contextKey, scope.scanId, summary.scanId]);

  useLayoutEffect(() => {
    const saved = pendingScroll.current;
    const viewport = viewportRef.current;
    const view = activeView.current;
    if (restoring || !saved || !viewport || !view || view.key !== viewKey || view.contextKey !== contextKey || view.scanId !== summary.scanId) return;
    if (restorePosition?.saved !== saved) {
      const anchorIndex = saved.anchorPath ? rows.findIndex(row => 'entry' in row && row.entry.path === saved.anchorPath) : -1;
      const desired = anchorIndex >= 0 ? anchorIndex * ROW_HEIGHT + (saved.anchorOffset ?? 0) : saved.scrollTop;
      // Commit the destination's virtual rows before moving the DOM viewport.
      // Chromium may otherwise clamp to the previous rendered rows' extent,
      // even though the spacer already has the full list height.
      setRestorePosition({ top: Math.min(desired, Math.max(0, rows.length * ROW_HEIGHT - viewport.clientHeight)), left: saved.scrollLeft, saved });
      const activeId = restoredActiveId(saved.activePath, rows.flatMap(row => 'entry' in row ? [row.entry] : []));
      setActiveKey(activeId === undefined ? undefined : `entry-${activeId}`);
      return;
    }
    viewport.scrollTop = restorePosition.top;
    viewport.scrollLeft = restorePosition.left;
    setScrollTop(viewport.scrollTop);
    pendingScroll.current = null;
    setRestorePosition(null);
    if (headerRef.current) headerRef.current.style.transform = `translateX(${-viewport.scrollLeft}px)`;
  }, [restoring, rows, restorePosition, viewKey, contextKey, summary.scanId]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!keyboardPosition || !viewport) return;
    const index = rows.findIndex(row => row.key === keyboardPosition.key);
    if (index >= 0) {
      // Render the destination virtual range first. Setting scrollTop before
      // that commit can clamp Home/End to the previous rendered row extent.
      viewport.scrollTop = focusScrollTop(index, rows.length, ROW_HEIGHT, viewport.clientHeight, viewport.scrollTop);
      gridRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      setScrollTop(viewport.scrollTop);
    }
    setKeyboardPosition(null);
  }, [keyboardPosition, rows]);

  saveCurrent.current = (top = viewportRef.current?.scrollTop ?? scrollTop, left = viewportRef.current?.scrollLeft ?? 0) => {
    const view = activeView.current;
    if (!view || restoring || restoringRef.current || pendingScroll.current || restorePosition || keyboardPosition || waitingRef.current || scopeError || view.key !== viewKey || view.contextKey !== contextKey || view.scanId !== summary.scanId || session.rootPath !== summary.rootPath) return;
    const expandedPaths = [...expanded].map(id => entries.get(id)?.path).filter((path): path is string => !!path);
    const pages = [{ path: scope.path, count: groups.get(mainKey)?.entries.length ?? PAGE_SIZE },
      ...[...expanded].flatMap(id => { const entry = entries.get(id); return entry ? [{ path: entry.path, count: groups.get(groupKey(id))?.entries.length ?? PAGE_SIZE }] : []; })];
    const anchor = rows[Math.floor(top / ROW_HEIGHT)];
    const activeRow = rows.find(row => row.key === activeKey);
    const ancestorPaths = ancestors.map(entry => entry.path);
    rememberExplorerView(session, viewKey, { path: scope.path, ancestors: ancestorPaths, expandedPaths, pages, scrollTop: top, scrollLeft: left,
      ...((anchor && 'entry' in anchor) ? { anchorPath: anchor.entry.path, anchorOffset: top % ROW_HEIGHT } : {}),
      ...((activeRow && 'entry' in activeRow) ? { activePath: activeRow.entry.path } : {}) });
    session.locations[memoryKey] = { path: scope.path, ancestors: ancestorPaths };
  };
  useLayoutEffect(() => { saveCurrent.current(); });

  const virtualScrollTop = keyboardPosition?.top ?? restorePosition?.top ?? scrollTop;
  const start = Math.max(0, Math.floor(virtualScrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((virtualScrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const visibleRows = rows.slice(start, end);
  const activeIndex = rows.findIndex(row => row.key === activeKey);
  const activeRendered = activeIndex >= start && activeIndex < end;
  const currentView = viewReady === contextKey && scope.scanId === summary.scanId;
  const mainGroup = currentView ? groups.get(mainKey) : undefined;
  const filteredNotice = mainGroup?.filteredCount ? `${number.format(mainGroup.filteredCount)} ${flat ? t.hiddenMatches : t.hiddenDirect} · ${t.hiddenScope}` : '';
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
    else if (!activeKey && rows.length && document.activeElement === gridRef.current) setActiveKey(rows[0].key);
  }, [rows, activeKey]);

  const activate = (index: number, inspect = false) => {
    const row = rows[index];
    if (!row) return;
    setActiveKey(row.key);
    // Keyboard focus and file inspection are distinct actions. Opening the
    // details sidebar on every arrow key changes the viewport while moving.
    if (inspect && 'entry' in row) onInspect(row.entry);
    const viewport = viewportRef.current;
    if (viewport) setKeyboardPosition({ key: row.key,
      top: focusScrollTop(index, rows.length, ROW_HEIGHT, viewport.clientHeight, viewport.scrollTop) });
  };

  const toggleSelected = (entry: Entry) => {
    if (selectionDisabled || (entry.kind !== 'file' && entry.kind !== 'directory') || entry.id === summary.rootId) return;
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
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowRight', 'ArrowLeft', 'Enter', ' '].includes(event.key)) event.preventDefault();
    if (event.key === 'ArrowDown') activate(activeIndex < 0 ? 0 : Math.min(rows.length - 1, index + 1));
    else if (event.key === 'ArrowUp') activate(Math.max(0, index - 1));
    else if (event.key === 'PageDown') activate(Math.min(rows.length - 1, index + Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT))));
    else if (event.key === 'PageUp') activate(Math.max(0, index - Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT))));
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

  const changeSort = (key: SortKey) => { saveCurrent.current(); if (waitingRef.current) keepCurrentLocation(); setSort(previous => ({ key, direction: previous.key === key ? previous.direction === 'asc' ? 'desc' : 'asc' : key === 'name' ? 'asc' : 'desc' })); };
  const sortHeader = (label: string, key: SortKey) => (
    <div role="columnheader" aria-sort={sort.key === key ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
      <button className="fx-sort" disabled={restoring} onClick={() => changeSort(key)}>{label}{sort.key === key && (sort.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button>
    </div>
  );
  const stateLabel = (entry: Entry) => entry.state === 'partial' ? t.partialEntry : t[entry.state];
  const rootName = entries.get(summary.rootId)?.name || summary.rootPath;

  return <section className="fx-explorer" aria-label={mode === 'tree' ? t.tree : t.files}>
    <div className="fx-toolbar">
      <div className="fx-search"><Search size={16} aria-hidden="true" /><input value={search} onChange={event => { if (waitingRef.current) keepCurrentLocation(); setSearch(event.target.value); }} disabled={restoring} placeholder={t.searchHint} aria-label={t.search} />{search && <button className="fx-icon-button" aria-label={t.clear} onClick={() => { setSearch(''); setActiveSearch(''); }}><X size={14} /></button>}</div>
      <label className="fx-size-filter"><span className="fx-sr-only">{t.minimum}</span><select value={minSize} title={t.minimum} disabled={restoring} onChange={event => { saveCurrent.current(); if (waitingRef.current) keepCurrentLocation(); setMinSize(Number(event.target.value)); }}><option value={0}>{t.allSizes}</option>{[10 * 1024 ** 2, 100 * 1024 ** 2, 1024 ** 3].map(value => <option key={value} value={value}>{t.logical} ≥ {formatSize(value, locale)}</option>)}</select></label>
      {category && <span className={`fx-category fx-category-${category}`}>{t.filterCategory}: {categories[locale][category]}</span>}
      <div className="fx-toolbar-spacer" />
      <div className="fx-column-control"><button ref={columnButtonRef} className="fx-tool-button" onClick={() => setColumnsOpen(!columnsOpen)} aria-expanded={columnsOpen} aria-controls={columnsId}><SlidersHorizontal size={15} />{t.columns}</button>{columnsOpen && <div id={columnsId} className="fx-column-menu" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setColumnsOpen(false); columnButtonRef.current?.focus(); } }}>{(['logical', 'modified', 'state'] as const).map(key => <label key={key}><input type="checkbox" checked={optionalColumns[key]} onChange={() => setOptionalColumns(previous => ({ ...previous, [key]: !previous[key] }))} />{t[key]}</label>)}</div>}</div>
      <button className="fx-icon-button fx-refresh" aria-label={t.refresh} title={t.refresh} onClick={() => { if (scopeError || viewReady !== contextKey) setRestoreAttempt(value => value + 1); else refresh(); }}><RefreshCw size={16} /></button>
    </div>

    <div className="fx-context">
      {!flat ? <nav className="fx-breadcrumbs" aria-label={t.location}>
        <button className="fx-icon-button" title={t.parent} aria-label={t.parent} disabled={!currentView || scopeId === summary.rootId || entries.get(scopeId)?.parentId == null} onClick={() => { const parent = entries.get(scopeId)?.parentId; if (parent !== null && parent !== undefined) navigate(parent); }}><ArrowUpLeft size={16} /></button>
        {(currentView && ancestors.length ? ancestors : [{ id: summary.rootId, name: rootName, path: summary.rootPath }]).map((entry, index, all) => <span className="fx-breadcrumb" key={entry.id}>{index > 0 && <ChevronRight size={12} />}<button title={entry.path} aria-current={index === all.length - 1 ? 'location' : undefined} onClick={() => navigate(entry.id)}>{entry.name || entry.path}</button></span>)}
      </nav> : <div className="fx-flat-context"><span>{mode === 'files' && !activeSearch && !minSize && !category ? t.allFiles : t.searchScope}</span><span className="fx-scope-path" title={summary.rootPath}>{summary.rootPath}</span></div>}
      <span className="fx-result-count">{number.format(mainGroup?.total ?? 0)} {t.items}</span>
    </div>
    {(waitingForScan || restoring || restoreNotice) && <div className="fx-notice fx-restore-notice" role="status">
      <span>{waitingForScan ? t.restoreWait : restoring ? t.restoreBusy : restoreNotice === 'parent' ? t.restoredParent : restoreNotice === 'hidden' ? t.hiddenParent : t.restoreLimited}</span>
      {waitingForScan && !restoring && <button className="fx-tool-button" onClick={keepCurrentLocation}>{t.keepLocation}</button>}
    </div>}
    {scopeError && <div className="fx-notice fx-error" role="alert">{t.scopeFailure}: {errorText(scopeError, locale)}</div>}
    {mainGroup?.error && <div className="fx-notice fx-error" role="alert">{t.loadFailure}: {errorText(mainGroup.error, locale)}</div>}

    <p id={instructionsId} className="fx-sr-only">{t.keyboard}</p>
    <div className="fx-table" style={tableStyle} role={flat ? 'grid' : 'treegrid'} aria-label={flat ? t.files : t.tree} aria-rowcount={-1} aria-colcount={5 + Object.values(optionalColumns).filter(Boolean).length} aria-multiselectable="true" aria-describedby={instructionsId} aria-busy={restoring || !!mainGroup?.loading} aria-activedescendant={activeRendered ? `fx-${activeKey}` : undefined} tabIndex={0} ref={gridRef} onFocus={event => { if (event.target === event.currentTarget && !activeKey && rows.length) activate(0); }} onKeyDown={onKeyDown}>
      <div className="fx-header-clip"><div className="fx-header" ref={headerRef} role="row" aria-rowindex={1}><div role="columnheader"><span className="fx-sr-only">{t.select}</span></div>{sortHeader(t.name, 'name')}{sortHeader(t.disk, 'allocatedSize')}<div role="columnheader">{t.share}</div><div role="columnheader">{t.count}</div>{optionalColumns.logical && sortHeader(t.logical, 'logicalSize')}{optionalColumns.modified && sortHeader(t.modified, 'modifiedAt')}{optionalColumns.state && <div role="columnheader">{t.state}</div>}</div></div>
      <div className="fx-viewport" ref={viewportRef} onScroll={event => { if (pendingScroll.current || restorePosition || keyboardPosition) return; saveCurrent.current(event.currentTarget.scrollTop, event.currentTarget.scrollLeft); setScrollTop(event.currentTarget.scrollTop); if (headerRef.current) headerRef.current.style.transform = `translateX(${-event.currentTarget.scrollLeft}px)`; }} role="rowgroup">
        {rows.length === 0 ? <div className="fx-empty"><Folder size={32} strokeWidth={1.4} /><strong>{!currentView || mainGroup?.loading ? t.loading : flat ? t.noMatches : t.empty}</strong><p>{filteredNotice || (flat ? t.filterHint : summary.state === 'scanning' ? t.scanEmpty : t.emptyHint)}</p></div> : <div className="fx-virtual-space" style={{ height: rows.length * ROW_HEIGHT }}>
          {visibleRows.map((row, localIndex) => {
            const rowIndex = start + localIndex;
            const style = { transform: `translateY(${rowIndex * ROW_HEIGHT}px)`, height: ROW_HEIGHT };
            if (!('entry' in row)) return <div key={row.key} id={`fx-${row.key}`} className={`fx-load-row ${activeKey === row.key ? 'fx-active' : ''}`} style={style} role="row" aria-rowindex={rowIndex + 2}><div role="gridcell" aria-colspan={5 + Object.values(optionalColumns).filter(Boolean).length} style={{ paddingLeft: 48 + row.depth * 20 }}>{row.action === 'loading' ? <span className="fx-loading"><LoaderCircle size={15} className="fx-spinner" />{t.loading}</span> : <><button tabIndex={-1} onClick={() => performAction(row)}>{row.action === 'retry' ? t.retry : `${t.more} · ${Math.min(PAGE_SIZE, row.remaining)} / ${number.format(row.remaining)}`}</button>{row.action === 'retry' && <span className="fx-inline-error" title={errorText(groups.get(groupKey(row.parentId))?.error, locale)}>{errorText(groups.get(groupKey(row.parentId))?.error, locale)}</span>}</>}</div></div>;
            const entry = row.entry;
            const parent = entry.parentId === null ? undefined : entries.get(entry.parentId);
            const ratio = entry.allocatedSize !== null && parent?.allocatedSize !== null && parent?.allocatedSize !== undefined && parent.allocatedSize > 0 ? entry.allocatedSize / parent.allocatedSize : null;
            const Icon = entry.kind === 'directory' ? Folder : entry.kind === 'symlink' ? Link2 : File;
            const current = inspectedId === entry.id;
            return <div key={row.key} id={`fx-${row.key}`} className={`fx-row ${current ? 'fx-inspected' : ''} ${selected.has(entry.id) ? 'fx-selected' : ''} ${activeKey === row.key ? 'fx-active' : ''}`} style={style} role="row" aria-rowindex={rowIndex + 2} aria-level={flat ? undefined : row.depth + 1} aria-posinset={flat ? undefined : row.position} aria-setsize={flat ? undefined : row.total} aria-expanded={!flat && entry.kind === 'directory' ? expanded.has(entry.id) : undefined} aria-selected={selected.has(entry.id)} onClick={() => { activate(rowIndex, true); gridRef.current?.focus({ preventScroll: true }); }} onDoubleClick={() => { if (entry.kind === 'directory' && mode === 'tree' && !category) navigate(entry.id); }}>
              <div className="fx-check-cell" role="gridcell">{(entry.kind === 'file' || entry.kind === 'directory') && entry.id !== summary.rootId ? <input type="checkbox" tabIndex={-1} checked={selected.has(entry.id)} disabled={selectionDisabled} title={entry.kind === 'directory' ? t.folderSelection : undefined} aria-label={`${t.select}: ${entry.name}`} onClick={event => event.stopPropagation()} onChange={() => { toggleSelected(entry); setActiveKey(row.key); gridRef.current?.focus({ preventScroll: true }); }} /> : <span title={t.filesOnly} />}</div>
              <div className="fx-name-cell" role="rowheader" style={{ paddingLeft: 8 + (flat ? 0 : row.depth * 20) }}>
                {!flat && entry.kind === 'directory' ? <button className="fx-expand" aria-label={`${expanded.has(entry.id) ? t.collapse : t.expand}: ${entry.name}`} tabIndex={-1} onClick={event => { event.stopPropagation(); toggleExpanded(entry); }}>{expanded.has(entry.id) ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button> : <span className="fx-expand-space" />}
                <Icon size={18} className={entry.kind === 'directory' ? 'fx-folder-icon' : `fx-file-icon fx-category-${entry.category}`} aria-hidden="true" />
                <div className="fx-file-label"><span className="fx-filename" title={entry.path}>{entry.name || entry.path}</span>{flat && <span className="fx-path" title={entry.path}>{entry.path}</span>}</div>
                {entry.state !== 'ready' && <span className={`fx-state-dot fx-state-${entry.state}`} title={entry.error ? errorText(entry.error, locale) : stateLabel(entry)} aria-label={stateLabel(entry)} />}
              </div>
              <div className={`fx-number ${entry.allocatedSize === null ? 'fx-unknown' : ''}`} role="gridcell" title={entry.allocatedSize === null ? t.unknownSize : `${number.format(entry.allocatedSize)} B`}>{formatSize(entry.allocatedSize, locale)}</div>
              <div className="fx-proportion" role="gridcell"><span className="fx-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, (ratio ?? 0) * 100))}%` }} /></span><span>{ratio === null ? '—' : `${number.format(Math.round(ratio * 1000) / 10)}%`}</span></div>
              <div className="fx-number fx-count" role="gridcell">{number.format(entry.fileCount)}</div>
              {optionalColumns.logical && <div className="fx-number" role="gridcell">{formatSize(entry.logicalSize, locale)}</div>}
              {optionalColumns.modified && <div className="fx-date" role="gridcell">{entry.modifiedAt > 0 ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(entry.modifiedAt) : '—'}</div>}
              {optionalColumns.state && <div className="fx-state-text" role="gridcell" title={entry.error ? errorText(entry.error, locale) : undefined}>{stateLabel(entry)}</div>}
            </div>;
          })}
        </div>}
      </div>
    </div>
    <footer className="fx-footer"><span role="status" aria-live="polite" aria-atomic="true">{number.format(loadedCount)} {t.shown}{selectedIds.length > 0 && <span className="fx-selection-count"> · {number.format(selectedIds.length)} {t.selected}</span>}</span>{filteredNotice && <span className="fx-filtered-count">{filteredNotice}</span>}<span role="status">{summary.state === 'scanning' ? t.partial : summary.state === 'cancelled' ? t.cancelled : summary.state === 'error' ? t.scanError : ''}</span></footer>
  </section>;
}
