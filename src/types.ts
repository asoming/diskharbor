export type Category = 'apps' | 'video' | 'images' | 'documents' | 'archives' | 'audio' | 'other' | 'system';
export interface Entry {
  id: number; parentId: number | null; name: string; path: string;
  kind: 'directory' | 'file' | 'symlink' | 'other';
  logicalSize: number; allocatedSize: number | null; fileCount: number; childCount: number;
  category: Category; modifiedAt: number;
  state: 'pending' | 'ready' | 'partial' | 'skipped' | 'error'; error?: string;
  shared?: boolean;
}
export interface ScanCoverage {
  deviceId: string | null;
  mountPath: string | null;
  filesystem: string | null;
  boundaryDetection: 'mount-table' | 'device-only';
  skipped: { mounts: number; symbolicLinks: number; virtualFilesystems: number; specialFiles: number };
  unknownAllocatedEntries: number;
  unsupportedNames: number;
}
export interface Summary {
  scanId: string; rootPath: string; rootId: number; state: 'idle' | 'scanning' | 'completed' | 'cancelled' | 'error';
  files: number; directories: number; scannedBytes: number; logicalBytes: number;
  errors: number; skipped: number; startedAt: number; elapsedMs: number;
  cancelRequested?: boolean;
  errorDetails?: { id: number; code: string }[];
  volume: { total: number; free: number } | null;
  coverage?: ScanCoverage;
  categories: { category: Category; bytes: number; files: number }[];
  message?: string;
}
export interface Query {
  parentId?: number; search?: string; category?: Category; minSize?: number; kind?: 'file' | 'directory';
  offset?: number; limit?: number; sortBy?: 'allocatedSize' | 'logicalSize' | 'name' | 'modifiedAt';
  sortDirection?: 'asc' | 'desc';
}
export type OperationState = 'running' | 'completed' | 'cancelled' | 'interrupted';
export type ItemStatus = 'pending' | 'processing' | 'trashed' | 'failed' | 'skipped' | 'cancelled' | 'unknown';
export interface HistoryItem {
  id: string; time: number; rootPath: string; success: number; failed: number;
  state?: OperationState; planId?: string; totalBytes?: number; total?: number; finishedAt?: number;
  skipped?: number; cancelled?: number;
  items: { path: string; status: ItemStatus; error?: string; kind?: 'file' | 'directory'; size?: number }[];
  freeSpaceDelta: number | null; historyError?: string;
}
export interface CleanupPlan {
  id: string;
  items: { id: number; path: string; size: number; eligible: boolean; reason?: string;
    kind: 'file' | 'directory' | 'symlink' | 'other'; fileCount?: number; blockedPath?: string }[];
  totalBytes: number; omittedCount: number; createdAt: number; expiresAt: number;
}
export interface CleanupProgress {
  id: string; planId: string;
  state: 'confirming' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
  total: number; processed: number; success: number; failed: number; skipped: number; cancelled: number;
  currentPath?: string; startedAt: number;
}
export type FilePreviewResult =
  | { kind: 'text'; text: string; truncated: boolean; bytesRead: number; mime: 'text/plain'; path: string }
  | { kind: 'image'; dataUrl: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number; bytesRead: number; path: string };
export interface BrowserCacheRule {
  id: string; version: 1; platform: 'linux' | 'win32' | 'darwin';
  browserId: 'chrome' | 'chromium' | 'firefox'; browserName: string;
  settingsAddress: string; sources: string[]; validatedAppVersions: string[];
  validation: 'metadata-fixtures' | 'native-browser';
}
export interface BrowserCacheFinding {
  entry: Entry; ruleId: string; profile: string; complete: boolean;
}
export interface BrowserCacheReport {
  scanId: string; rootPath: string; scanState: Summary['state']; ruleSetVersion: string;
  findings: BrowserCacheFinding[]; truncated: boolean; rules: BrowserCacheRule[];
}
export interface DiskHarborAPI {
  info(): Promise<{ platform: string; version: string; home: string; locations: { label: string; path: string }[] }>;
  chooseDirectory(): Promise<string | null>;
  startScan(path: string): Promise<Summary>;
  cancelScan(scanId: string): Promise<Summary | null>;
  retryScan(id: number, scanId: string): Promise<Summary>;
  summary(): Promise<Summary | null>;
  query(query: Query): Promise<{ entries: Entry[]; total: number }>;
  entry(id: number): Promise<Entry | null>;
  ancestors(id: number): Promise<Entry[]>;
  resolvePaths(paths: string[], scanId: string): Promise<(Entry | null)[]>;
  reveal(id: number): Promise<void>;
  copyPath(id: number): Promise<void>;
  preview(id: number, scanId: string): Promise<FilePreviewResult>;
  cacheReport(scanId: string): Promise<BrowserCacheReport>;
  copyCacheSettings(ruleId: string): Promise<void>;
  planCleanup(ids: number[]): Promise<CleanupPlan>;
  executeCleanup(planId: string, locale?: 'zh-CN' | 'en'): Promise<HistoryItem>;
  cancelCleanup(): Promise<void>;
  cleanupStatus(): Promise<CleanupProgress | null>;
  onCleanupProgress(callback: (progress: CleanupProgress) => void): () => void;
  openTrash(): Promise<void>;
  setLocale(locale: 'zh-CN' | 'en'): Promise<void>;
  history(): Promise<HistoryItem[]>;
  clearHistory(): Promise<void>;
  onProgress(callback: (summary: Summary) => void): () => void;
}
declare global { interface Window { diskharbor?: DiskHarborAPI } }
