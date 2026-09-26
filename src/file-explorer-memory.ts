import type { Category, Entry, Query } from './types';

export type ExplorerMode = 'tree' | 'files';
export interface ExplorerVisibility { includeHidden: boolean; includeSystem: boolean }
export const DEFAULT_EXPLORER_VISIBILITY: ExplorerVisibility = { includeHidden: true, includeSystem: true };
export const RESTORE_PAGE_SIZE = 100;
export const MAX_MEMORY_VIEWS = 16;
export const MAX_EXPANDED_PATHS = 16;
export const MAX_RESTORE_ROWS = 2000;
export const MAX_ROWS_PER_GROUP = 500;
const MAX_ANCESTORS = 64;

export interface ExplorerPreferences {
  search: string;
  minSize: number;
  sort: { key: NonNullable<Query['sortBy']>; direction: 'asc' | 'desc' };
  columns: { logical: boolean; modified: boolean; state: boolean };
}
export interface ExplorerLocation { path: string; ancestors: string[] }
export interface ExplorerViewMemory extends ExplorerLocation {
  expandedPaths: string[];
  pages: { path: string; count: number }[];
  scrollTop: number;
  scrollLeft: number;
  anchorPath?: string;
  anchorOffset?: number;
  activePath?: string;
  limited?: boolean;
}
export interface ExplorerMemory {
  rootPath: string | null;
  scanIds: Record<string, string | null>;
  preferences: Record<ExplorerMode, ExplorerPreferences>;
  locations: Partial<Record<string, ExplorerLocation>>;
  views: Map<string, ExplorerViewMemory>;
}

export function defaultExplorerPreferences(): ExplorerPreferences {
  return { search: '', minSize: 0, sort: { key: 'allocatedSize', direction: 'desc' }, columns: { logical: false, modified: false, state: false } };
}
export function createExplorerMemory(): ExplorerMemory {
  return { rootPath: null, scanIds: { tree: null, files: null }, preferences: { tree: defaultExplorerPreferences(), files: defaultExplorerPreferences() }, locations: {}, views: new Map() };
}
export function prepareExplorerRoot(memory: ExplorerMemory, rootPath: string, scanId: string): void {
  if (memory.rootPath === rootPath) return;
  Object.assign(memory, createExplorerMemory(), { rootPath, scanIds: { tree: scanId, files: scanId } });
}
export function explorerMemoryKey(mode: ExplorerMode, visibility: ExplorerVisibility = DEFAULT_EXPLORER_VISIBILITY): string {
  return visibility.includeHidden && visibility.includeSystem ? mode : `${mode}:${Number(visibility.includeHidden)}:${Number(visibility.includeSystem)}`;
}
export function explorerViewKey(mode: ExplorerMode, path: string, preferences: ExplorerPreferences, category?: Category, visibility: ExplorerVisibility = DEFAULT_EXPLORER_VISIBILITY): string {
  return JSON.stringify([mode, path, preferences.search.trim(), preferences.minSize, preferences.sort.key, preferences.sort.direction, category ?? '', visibility.includeHidden, visibility.includeSystem]);
}

function boundedAncestors(paths: string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.length <= MAX_ANCESTORS ? unique : [unique[0], ...unique.slice(-(MAX_ANCESTORS - 1))];
}

// Budget all groups together so restoring a wide tree cannot launch hundreds
// of automatic page reads. User-requested Load more remains unrestricted.
export function restorePageBudget(path: string, expandedPaths: string[], pages: ExplorerViewMemory['pages']): ExplorerViewMemory['pages'] {
  const paths = [...new Set([path, ...expandedPaths])].slice(0, MAX_EXPANDED_PATHS + 1);
  const desired = new Map(pages.map(page => [page.path, page.count]));
  const result = paths.map(value => ({ path: value, count: RESTORE_PAGE_SIZE }));
  let remaining = MAX_RESTORE_ROWS - result.length * RESTORE_PAGE_SIZE;
  for (const group of result) {
    const wanted = Math.min(MAX_ROWS_PER_GROUP, Math.max(RESTORE_PAGE_SIZE, Math.ceil((desired.get(group.path) || 0) / RESTORE_PAGE_SIZE) * RESTORE_PAGE_SIZE));
    const extra = Math.min(remaining, wanted - group.count);
    group.count += extra;
    remaining -= extra;
  }
  return result;
}

export function rememberExplorerView(memory: ExplorerMemory, key: string, view: ExplorerViewMemory): void {
  const expandedPaths = [...new Set(view.expandedPaths)].filter(path => path !== view.path).slice(0, MAX_EXPANDED_PATHS);
  const pages = restorePageBudget(view.path, expandedPaths, view.pages);
  const pageByPath = new Map(pages.map(page => [page.path, page.count]));
  const limited = view.expandedPaths.length > expandedPaths.length || view.pages.some(page => page.count > (pageByPath.get(page.path) ?? 0));
  const saved: ExplorerViewMemory = {
    path: view.path, ancestors: boundedAncestors(view.ancestors), expandedPaths, pages,
    scrollTop: Math.max(0, Math.min(MAX_RESTORE_ROWS * 50, view.scrollTop)),
    scrollLeft: Math.max(0, view.scrollLeft),
    ...(view.anchorPath ? { anchorPath: view.anchorPath, anchorOffset: Math.max(0, Math.min(49, view.anchorOffset ?? 0)) } : {}),
    ...(view.activePath ? { activePath: view.activePath } : {}),
    limited: limited || view.limited,
  };
  memory.views.delete(key);
  memory.views.set(key, saved);
  while (memory.views.size > MAX_MEMORY_VIEWS) memory.views.delete(memory.views.keys().next().value!);
}

export function locationCandidates(location: ExplorerLocation | undefined, rootPath: string): string[] {
  return [...new Set([...(location ? [location.path, ...boundedAncestors(location.ancestors).reverse()] : []), rootPath])];
}

export function isExplorerEntryVisible(entry: Pick<Entry, 'path' | 'hiddenPath' | 'systemPath'>, visibility: ExplorerVisibility = DEFAULT_EXPLORER_VISIBILITY, rootPath?: string): boolean {
  return entry.path === rootPath || ((visibility.includeHidden || !entry.hiddenPath) && (visibility.includeSystem || !entry.systemPath));
}

export function nearestResolvedDirectory(paths: string[], resolved: (Entry | null)[], visibility: ExplorerVisibility = DEFAULT_EXPLORER_VISIBILITY, rootPath?: string): Entry | null {
  for (let index = 0; index < paths.length; index++) {
    const entry = resolved[index];
    // Check exact paths as well as kind; IDs alone are never restoration keys.
    if (entry?.kind === 'directory' && entry.path === paths[index] && isExplorerEntryVisible(entry, visibility, rootPath)) return entry;
  }
  return null;
}

export function restoredActiveId(path: string | undefined, entries: Pick<Entry, 'id' | 'path'>[]): number | undefined {
  return path ? entries.find(entry => entry.path === path)?.id : undefined;
}
