'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const invoke = (method, ...args) => ipcRenderer.invoke(`diskharbor:${method}`, ...args);
function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback is required.');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(`diskharbor:${channel}`, listener);
  return () => ipcRenderer.removeListener(`diskharbor:${channel}`, listener);
}
contextBridge.exposeInMainWorld('diskharbor', Object.freeze({
  info: () => invoke('info'),
  requestElevation: () => invoke('requestElevation'),
  setLocale: (locale) => invoke('setLocale', locale),
  chooseDirectory: () => invoke('chooseDirectory'),
  startScan: (directory) => invoke('startScan', directory),
  cancelScan: (scanId) => invoke('cancelScan', scanId),
  retryScan: (id, scanId) => invoke('retryScan', id, scanId),
  summary: () => invoke('summary'),
  measureSpace: (scanId) => invoke('measureSpace', scanId),
  cacheReport: (scanId) => invoke('cacheReport', scanId),
  copyCacheSettings: (ruleId) => invoke('copyCacheSettings', ruleId),
  query: (query) => invoke('query', query),
  entry: (id) => invoke('entry', id),
  entryDetails: (id, scanId) => invoke('entryDetails', id, scanId),
  ancestors: (id) => invoke('ancestors', id),
  resolvePaths: (paths, scanId) => invoke('resolvePaths', paths, scanId),
  reveal: (id) => invoke('reveal', id),
  copyPath: (id) => invoke('copyPath', id),
  preview: (id, scanId) => invoke('preview', id, scanId),
  planCleanup: (ids, options) => invoke('planCleanup', ids, options),
  executeCleanup: (planId, locale) => invoke('executeCleanup', planId, locale),
  cancelCleanup: () => invoke('cancelCleanup'),
  cleanupStatus: () => invoke('cleanupStatus'),
  openTrash: () => invoke('openTrash'),
  history: () => invoke('history'),
  clearHistory: () => invoke('clearHistory'),
  onProgress: (callback) => subscribe('progress', callback),
  onCleanupProgress: (callback) => subscribe('cleanup-progress', callback),
}));
