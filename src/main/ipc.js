import { ipcMain } from 'electron';

const CHANNELS = {
  'library:state': 'state',
  'catalog:refresh': 'refreshCatalog',
  'catalog:search': 'search',
  'generator:install': 'install',
  'generator:uninstall': 'uninstall',
  'generator:launch': 'launch',
  'generator:openWeb': 'openWeb',
  'generator:mirror': 'mirror',
  'generator:checkUpdates': 'checkUpdates',
  'generator:versions': 'versions',
  'generator:useVersion': 'useVersion',
  'generator:removeVersion': 'removeVersion',
  'library:toggleFavorite': 'toggleFavorite',
  'library:setFavorite': 'setFavorite',
  'library:setTags': 'setTags',
  'settings:update': 'updateSettings',
  'sources:add': 'addSource',
  'sources:remove': 'removeSource',
  'shell:openExternal': 'openExternal',
  'shell:openFolder': 'openFolder',
  'webmirror:snapshots': 'webmirrorSnapshots',
  'webmirror:open': 'openSnapshot',
  'projects:describe': 'describeProject',
  'projects:add': 'addProject',
  'projects:remove': 'removeProject',
  'projects:restore': 'restoreProject',
  'projects:setHidden': 'setHidden',
  'library:chooseFolder': 'chooseDataFolder',
  'library:move': 'moveData',
  'runtimes:install': 'installRuntime',
  'runtimes:remove': 'removeRuntime',
  'jobs:list': 'jobs',
  'jobs:clear': 'clearJobs',
};

export function registerIpc(services, getWindow) {
  for (const [channel, method] of Object.entries(CHANNELS)) {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return { ok: true, value: await services[method](payload ?? {}) };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    });
  }
  services.subscribe((channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  });
  // First load happens here rather than in the renderer so a slow GitHub call
  // does not block the window from showing.
  services.refreshCatalog().catch((error) => console.error('catalog refresh failed', error));
}
