export type Category = 'apps' | 'video' | 'images' | 'documents' | 'archives' | 'audio' | 'other' | 'system';
export interface Entry {
  id: number; parentId: number | null; name: string; path: string;
  kind: 'directory' | 'file' | 'symlink' | 'other';
  logicalSize: number; allocatedSize: number | null; fileCount: number; childCount: number;
  category: Category; modifiedAt: number;
  state: 'pending' | 'ready' | 'partial' | 'skipped' | 'error'; error?: string;
  shared?: boolean;
}
export interface Summary {
  scanId: string; rootPath: string; rootId: number; state: 'idle' | 'scanning' | 'completed' | 'cancelled' | 'error';
  files: number; directories: number; scannedBytes: number; logicalBytes: number;
  errors: number; skipped: number; startedAt: number; elapsedMs: number;
  volume: { total: number; free: number } | null;
  categories: { category: Category; bytes: number; files: number }[];
  message?: string;
}
export interface Query {
  parentId?: number; search?: string; category?: Category; minSize?: number; kind?: 'file' | 'directory';
  offset?: number; limit?: number; sortBy?: 'allocatedSize' | 'logicalSize' | 'name' | 'modifiedAt';
  sortDirection?: 'asc' | 'desc';
}
export interface HistoryItem {
  id: string; time: number; rootPath: string; success: number; failed: number;
  items: { path: string; status: string; error?: string }[]; freeSpaceDelta: number | null; historyError?: string;
}
export interface CleanupPlan {
  id: string; items: { id: number; path: string; size: number; eligible: boolean; reason?: string }[];
  totalBytes: number;
}
export interface DiskHarborAPI {
  info(): Promise<{ platform: string; version: string; home: string; locations: { label: string; path: string }[] }>;
  chooseDirectory(): Promise<string | null>;
  startScan(path: string): Promise<Summary>;
  cancelScan(): Promise<void>;
  summary(): Promise<Summary | null>;
  query(query: Query): Promise<{ entries: Entry[]; total: number }>;
  entry(id: number): Promise<Entry | null>;
  ancestors(id: number): Promise<Entry[]>;
  reveal(id: number): Promise<void>;
  copyPath(id: number): Promise<void>;
  planCleanup(ids: number[]): Promise<CleanupPlan>;
  executeCleanup(planId: string): Promise<HistoryItem>;
  history(): Promise<HistoryItem[]>;
  clearHistory(): Promise<void>;
  onProgress(callback: (summary: Summary) => void): () => void;
}
declare global { interface Window { diskharbor?: DiskHarborAPI } }
