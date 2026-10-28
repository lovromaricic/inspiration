// Bridge between the sandboxed page and the main process.
// The page gets only these calls — no Node.js, no file system.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CHANNELS = [
  'get-storage-info', 'choose-storage-location', 'open-storage-folder', 'open-url',
  'get-settings', 'set-setting', 'get-startup-state', 'setup-storage',
  'get-collections', 'create-collection', 'delete-collection', 'rename-collection',
  'get-collection-item-count', 'get-counts', 'get-all-tags',
  'get-items-paginated', 'search-items', 'get-item',
  'add-image', 'read-dropped-file', 'read-clipboard-image', 'read-clipboard-text',
  'preview-url', 'save-url', 'discard-temp',
  'delete-item', 'update-item', 'toggle-favorite', 'move-item',
  'get-item-details', 'save-image', 'copy-image', 'copy-text', 'pick-images'
];

contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => {
    if (!CHANNELS.includes(channel)) {
      return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  // Real path of a dropped or picked File (File.path was removed in Electron 32)
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch (e) {
      return '';
    }
  },
  platform: process.platform
});
