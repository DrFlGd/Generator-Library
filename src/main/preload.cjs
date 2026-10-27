// The whole bridge between the page and the main process. Every function returns a
// promise; `on` subscribes to progress events. Sandboxed preloads must be CommonJS.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('library', {
  platform: process.platform,
  getState: invoke('library:state'),
  refreshCatalog: invoke('catalog:refresh'),
  search: invoke('catalog:search'),
  install: invoke('generator:install'),
  uninstall: invoke('generator:uninstall'),
  launch: invoke('generator:launch'),
  openWeb: invoke('generator:openWeb'),
  mirror: invoke('generator:mirror'),
  checkUpdates: invoke('generator:checkUpdates'),
  toggleFavorite: invoke('library:toggleFavorite'),
  updateSettings: invoke('settings:update'),
  addSource: invoke('sources:add'),
  removeSource: invoke('sources:remove'),
  openExternal: invoke('shell:openExternal'),
  openFolder: invoke('shell:openFolder'),
  webmirrorSnapshots: invoke('webmirror:snapshots'),
  openSnapshot: invoke('webmirror:open'),
  describeProject: invoke('projects:describe'),
  addProject: invoke('projects:add'),
  removeProject: invoke('projects:remove'),
  restoreProject: invoke('projects:restore'),
  setHidden: invoke('projects:setHidden'),
  installRuntime: invoke('runtimes:install'),
  removeRuntime: invoke('runtimes:remove'),
  jobs: invoke('jobs:list'),
  clearJobs: invoke('jobs:clear'),
  on(channel, handler) {
    const allowed = ['jobs:changed', 'catalog:changed'];
    if (!allowed.includes(channel)) throw new Error(`unknown channel ${channel}`);
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
