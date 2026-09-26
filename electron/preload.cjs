'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (method, ...args) => ipcRenderer.invoke(`diskharbor:${method}`, ...args);
contextBridge.exposeInMainWorld('diskharbor', Object.freeze({
  info: () => invoke('info'),
  chooseDirectory: () => invoke('chooseDirectory'),
  startScan: (directory) => invoke('startScan', directory),
  cancelScan: () => invoke('cancelScan'),
  summary: () => invoke('summary'),
  query: (query) => invoke('query', query),
  entry: (id) => invoke('entry', id),
  ancestors: (id) => invoke('ancestors', id),
  reveal: (id) => invoke('reveal', id),
  copyPath: (id) => invoke('copyPath', id),
  planCleanup: (ids) => invoke('planCleanup', ids),
  executeCleanup: (planId) => invoke('executeCleanup', planId),
  history: () => invoke('history'),
  clearHistory: () => invoke('clearHistory'),
  onProgress: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('A callback is required.');
    const listener = (_event, summary) => callback(summary);
    ipcRenderer.on('diskharbor:progress', listener);
    return () => ipcRenderer.removeListener('diskharbor:progress', listener);
  },
}));
