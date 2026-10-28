const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, nativeTheme, Menu } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const ogs = require('open-graph-scraper');
const sharp = require('sharp');

const {
  initializeDatabase,
  getStorageInfo,
  getSavedStoragePath,
  getSettings,
  setSetting,
  getItem,
  updateItem,
  setItemMeta,
  moveItemToCollection,
  getAllTags,
  createCollection,
  getAllCollections,
  deleteCollection,
  renameCollection,
  getCollectionItemCount,
  getCounts,
  rewriteStoragePaths,
  addItem,
  getItemsByCollectionPaginated,
  deleteItem,
  searchItems,
  toggleFavorite
} = require('./database');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 20 },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // Matches the page background so there is no white flash on launch
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121110' : '#F7F5F1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.loadFile('index.html');

  // Add context menu for input fields
// Add context menu for input fields
mainWindow.webContents.on('context-menu', (e, props) => {
  const { isEditable } = props;
  
  if (isEditable) {
    const InputMenu = Menu.buildFromTemplate([
      { label: 'Undo', role: 'undo' },
      { label: 'Redo', role: 'redo' },
      { type: 'separator' },
      { label: 'Cut', role: 'cut' },
      { label: 'Copy', role: 'copy' },
      { label: 'Paste', role: 'paste' },
      { type: 'separator' },
      { label: 'Select All', role: 'selectall' }
    ]);
    
    InputMenu.popup(mainWindow);
  }
});

  mainWindow.webContents.on('will-navigate', (e) => {
    e.preventDefault();
  });

  // Never open new Electron windows; send safe links to the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Only allow web and mail links to be opened externally
function isSafeExternalUrl(url) {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol);
  } catch (e) {
    return false;
  }
}

// Unique file name so items added in the same millisecond don't overwrite each other
function uniqueName(prefix, ext) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

// Escape text before putting it into SVG markup
function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Download a remote file into a buffer (follows redirects, checks status and type)
async function fetchImageBuffer(url, timeoutMs = 10000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status}`);
  }
  const type = response.headers.get('content-type') || '';
  if (type && !type.startsWith('image/') && !type.startsWith('application/octet-stream')) {
    throw new Error('URL is not an image');
  }
  return Buffer.from(await response.arrayBuffer());
}

// Where the library lives decides what the window shows first:
// 'ok' opens the library, 'welcome' and 'missing' show the setup screen in the app.
let startupState = { status: 'ok' };

function decideStartup() {
  const savedPath = getSavedStoragePath();
  const defaultDb = path.join(app.getPath('userData'), 'inspiration.db');

  if (savedPath) {
    if (fs.existsSync(savedPath)) {
      initializeDatabase(savedPath);
      return { status: 'ok' };
    }
    // Folder is gone: external drive unplugged, or it was moved or renamed
    return { status: 'missing', savedPath };
  }

  // Before v2 the default location was never written to settings
  if (fs.existsSync(defaultDb)) {
    initializeDatabase(app.getPath('userData'));
    if (getCollectionItemCount(1) > 0 || getAllCollections().length > 1) {
      return { status: 'ok' };
    }
  }
  return { status: 'welcome' };
}

app.whenReady().then(async () => {
  startupState = decideStartup();

  // The packaged app gets its icon from assets/icon.icns; show it in the Dock during development too
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  }

  // Light / dark / follow macOS, from Settings › Appearance
  nativeTheme.themeSource = getSettings().theme || 'system';

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Get collection folder path by ID
function getCollectionFolderPath(collectionId) {
  const { imagesPath } = getStorageInfo();
  const collectionFolder = path.join(imagesPath, collectionId.toString());
  // Ensure collection folder exists
  fs.ensureDirSync(collectionFolder);
  return collectionFolder;
}

// Optimize image with sharp
async function optimizeImage(inputPath, outputPath) {
  try {
    await sharp(inputPath)
      .rotate() // respect EXIF orientation (phone photos)
      .flatten({ background: '#ffffff' }) // transparent PNGs become white, not black
      .resize(1920, null, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 80 })
      .toFile(outputPath);
    console.log('Image optimized:', outputPath);
    return true;
  } catch (error) {
    console.error('Error optimizing image:', error);
    return false;
  }
}

// Generate text card image for URLs without preview
async function generateTextCard(title, domain, outputPath) {
  try {
    const width = 800;
    const height = 1000;
    const palettes = [
      { bg: '#E8572A', fg: '#1A0F0A', sub: '#5A2410' },
      { bg: '#2F4B3E', fg: '#F2EDE4', sub: '#A9BBAE' },
      { bg: '#1B1A18', fg: '#F2EDE4', sub: '#8A847A' },
      { bg: '#E9E4F5', fg: '#26215C', sub: '#6B63A8' },
      { bg: '#F0C93E', fg: '#1A1408', sub: '#6B5410' },
      { bg: '#F2EDE4', fg: '#161514', sub: '#8A847A' }
    ];

    const hash = domain.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const c = palettes[hash % palettes.length];

    // Wrap the title onto up to four lines of ~16 characters
    const words = String(title).split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      if ((line + ' ' + word).trim().length > 16 && line) {
        lines.push(line);
        line = word;
      } else {
        line = (line + ' ' + word).trim();
      }
      if (lines.length === 4) break;
    }
    if (line && lines.length < 4) lines.push(line);
    const titleText = lines.map((l, i) =>
      `<text x="64" y="${560 + i * 92}" font-family="Georgia, 'Times New Roman', serif" font-size="88" fill="${c.fg}">${escapeXml(l.substring(0, 22))}</text>`
    ).join('');

    const svg = `
      <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${width}" height="${height}" fill="${c.bg}"/>
        <text x="64" y="96" font-family="Menlo, monospace" font-size="24" letter-spacing="2" fill="${c.sub}">${escapeXml(domain.toUpperCase())}</text>
        ${titleText}
        <text x="64" y="${height - 64}" font-family="Menlo, monospace" font-size="22" letter-spacing="2" fill="${c.sub}">LINK</text>
      </svg>
    `;

    await sharp(Buffer.from(svg))
      .jpeg({ quality: 90 })
      .toFile(outputPath);

    console.log('Text card generated:', outputPath);
    return true;
  } catch (error) {
    console.error('Error generating text card:', error);
    return false;
  }
}

// Main colors of an image: quantize pixels into buckets and keep the most common distinct ones
async function extractPalette(imagePath, count = 5) {
  const { data, info } = await sharp(imagePath)
    .resize(64, 64, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = new Map();
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += r; bucket.g += g; bucket.b += b; bucket.n++;
    buckets.set(key, bucket);
  }

  const sorted = [...buckets.values()]
    .map(x => ({ r: x.r / x.n, g: x.g / x.n, b: x.b / x.n, n: x.n }))
    .sort((a, b) => b.n - a.n);

  const picked = [];
  for (const c of sorted) {
    const distinct = picked.every(p => Math.hypot(p.r - c.r, p.g - c.g, p.b - c.b) > 40);
    if (distinct) picked.push(c);
    if (picked.length === count) break;
  }
  const hex = v => Math.round(v).toString(16).padStart(2, '0');
  return picked.map(c => `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`.toUpperCase());
}

// Palette, dimensions and file size for an item's image
async function computeItemMeta(id, imagePath) {
  try {
    const [palette, metadata, stat] = await Promise.all([
      extractPalette(imagePath),
      sharp(imagePath).metadata(),
      fs.stat(imagePath)
    ]);
    const meta = { palette, width: metadata.width, height: metadata.height, file_size: stat.size };
    setItemMeta(id, meta);
    return meta;
  } catch (error) {
    console.error('Error reading image details:', error);
    return null;
  }
}

// True when a path from the page points inside our own images folder
function isInsideImages(filePath) {
  const { imagesPath } = getStorageInfo();
  const resolved = path.resolve(String(filePath || ''));
  return resolved.startsWith(path.resolve(imagesPath) + path.sep);
}

// True when a path is one of our own temp files (downloads, clipboard and dropped images)
function isOwnTempFile(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  const base = path.basename(resolved);
  const inAppTemp = resolved.startsWith(path.resolve(app.getPath('temp')) + path.sep) && base.startsWith('inspiration-');
  const inImagesRoot = path.dirname(resolved) === path.resolve(getStorageInfo().imagesPath) && /^(clipboard_|temp_)/.test(base);
  return inAppTemp || inImagesRoot;
}

// Read clipboard image
ipcMain.handle('read-clipboard-image', async () => {
  try {
    const image = clipboard.readImage();
    if (image.isEmpty()) {
      return { success: false, error: 'No image in clipboard' };
    }

    const buffer = image.toPNG();
    const { imagesPath } = getStorageInfo();
    const tempPath = path.join(imagesPath, uniqueName('clipboard', 'png'));

    await fs.writeFile(tempPath, buffer);
    console.log('Clipboard image saved to temp:', tempPath);

    return { success: true, path: tempPath };
  } catch (error) {
    console.error('Error reading clipboard:', error);
    return { success: false, error: error.message };
  }
});

// Storage handlers
ipcMain.handle('get-storage-info', async () => {
  return getStorageInfo();
});

// Updated handler for changing storage location (from Settings menu)
ipcMain.handle('choose-storage-location', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Change Storage Location',
    buttonLabel: 'Select Folder'
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, canceled: true };
  }

  const newPath = result.filePaths[0];
  
  // Check if there's existing data to migrate
  const oldStorage = getStorageInfo();
  const hasExistingData = oldStorage.storagePath && 
                          fs.existsSync(oldStorage.dbPath);
  
  if (hasExistingData) {
    // Only show migration dialog if there's actual existing data
    const moveData = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Move Existing Data', 'Start Fresh', 'Cancel'],
      defaultId: 0,
      title: 'Move Data?',
      message: 'Would you like to move your existing data to the new location?',
      detail: 'Move: Copy all collections and images to new location\nStart Fresh: Begin with empty database'
    });

    if (moveData.response === 2) {
      return { success: false, canceled: true };
    }

    const shouldMoveData = moveData.response === 0;

    try {
      if (shouldMoveData) {
        await fs.copy(oldStorage.dbPath, path.join(newPath, 'inspiration.db'));
        await fs.copy(oldStorage.imagesPath, path.join(newPath, 'images'));
      }

      initializeDatabase(newPath);
      if (shouldMoveData) {
        // Items store absolute paths; point them at the copied images
        rewriteStoragePaths(oldStorage.imagesPath, path.join(newPath, 'images'));
      }

      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Success',
        message: 'Storage location changed successfully!',
        detail: 'The app will now restart to apply changes.'
      }).then(() => {
        app.relaunch();
        app.exit(0);
      });

      return { success: true, path: newPath };
    } catch (error) {
      console.error('Error changing storage location:', error);
      return { success: false, error: error.message };
    }
  } else {
    // No existing data, just set new path
    try {
      initializeDatabase(newPath);
      return { success: true, path: newPath };
    } catch (error) {
      console.error('Error setting storage location:', error);
      return { success: false, error: error.message };
    }
  }
});

ipcMain.handle('open-storage-folder', async () => {
  const { storagePath } = getStorageInfo();
  shell.openPath(storagePath);
  return true;
});

ipcMain.handle('open-url', async (event, url) => {
  if (!isSafeExternalUrl(url)) return false;
  await shell.openExternal(url);
  return true;
});

// Collection handlers
ipcMain.handle('get-collections', async () => {
  return getAllCollections();
});

ipcMain.handle('create-collection', async (event, name, color) => {
  const newId = createCollection(name, color);
  const collectionFolder = getCollectionFolderPath(newId);
  console.log('Created collection folder:', collectionFolder);
  return newId;
});

ipcMain.handle('delete-collection', async (event, id) => {
  if (id === 1) return false;

  try {
    const collectionFolder = getCollectionFolderPath(id);
    if (fs.existsSync(collectionFolder)) {
      await fs.remove(collectionFolder);
      console.log('Deleted collection folder:', collectionFolder);
    }
  } catch (error) {
    console.error('Error deleting collection folder:', error);
  }

  return deleteCollection(id);
});

ipcMain.handle('rename-collection', async (event, id, newName) => {
  renameCollection(id, newName);
  return true;
});

ipcMain.handle('get-collection-item-count', async (event, id) => {
  return getCollectionItemCount(id);
});

ipcMain.handle('get-counts', async () => {
  return getCounts();
});

// NEW: Pagination handler
ipcMain.handle('get-items-paginated', async (event, collectionId, page, itemsPerPage, type) => {
  return getItemsByCollectionPaginated(collectionId, page, itemsPerPage, type);
});

ipcMain.handle('add-image', async (event, filePath, options = {}) => {
  const { collectionId = 1, title = '', sourceUrl = '', tags = '' } = options;
  try {
    console.log('Backend: Adding image from path:', filePath);

    if (!filePath || !fs.existsSync(filePath)) {
      console.error('Backend: File does not exist:', filePath);
      return { success: false, error: 'File does not exist' };
    }

    const collectionFolder = getCollectionFolderPath(collectionId);
    const fileName = uniqueName('img', 'jpg');
    const destPath = path.join(collectionFolder, fileName);

    console.log('Backend: Optimizing and copying to:', destPath);

    const optimized = await optimizeImage(filePath, destPath);
    if (!optimized) {
      await fs.copy(filePath, destPath);
    }

    // Clean up temp files we created ourselves (never the user's originals)
    const base = path.basename(filePath);
    const isOwnTemp = /^(clipboard_|temp_|inspiration-)/.test(base) &&
      (filePath.startsWith(getStorageInfo().imagesPath) || filePath.startsWith(app.getPath('temp')));
    if (isOwnTemp) {
      try {
        await fs.unlink(filePath);
      } catch (e) {
        console.log('Could not delete temp file:', filePath);
      }
    }

    const id = addItem({
      collection_id: collectionId,
      type: 'image',
      title: title || '',
      source_url: sourceUrl || '',
      tags: tags || '',
      file_path: destPath,
      thumbnail_path: destPath
    });
    await computeItemMeta(id, destPath);

    console.log('Backend: Image added successfully with ID:', id);
    return { success: true, id };
  } catch (error) {
    console.error('Backend: Error adding image:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('read-dropped-file', async (event, fileData) => {
  try {
    const { imagesPath } = getStorageInfo();
    const tempPath = path.join(imagesPath, uniqueName('temp', 'jpg'));
    const bufferPath = path.join(imagesPath, uniqueName('buffer', 'tmp'));

    await fs.writeFile(bufferPath, Buffer.from(fileData.buffer));
    const optimized = await optimizeImage(bufferPath, tempPath);
    await fs.unlink(bufferPath);
    if (!optimized) {
      return { success: false, error: 'Unsupported image format' };
    }

    return { success: true, path: tempPath };
  } catch (error) {
    console.error('Error reading dropped file:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-item', async (event, id) => {
  try {
    deleteItem(id);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('search-items', async (event, query) => {
  return searchItems(query);
});

ipcMain.handle('toggle-favorite', async (event, id) => {
  toggleFavorite(id);
  return true;
});

ipcMain.handle('save-image', async (event, imagePath) => {
  try {
    if (!isInsideImages(imagePath)) {
      return { success: false, error: 'Not a library image' };
    }
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Image',
      defaultPath: path.join(app.getPath('downloads'), path.basename(imagePath)),
      filters: [
        { name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    await fs.copy(imagePath, result.filePath);
    return { success: true, path: result.filePath };
  } catch (error) {
    console.error('Error saving image:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('read-clipboard-text', async () => {
  try {
    const text = clipboard.readText();
    if (text && text.trim()) {
      return { success: true, text: text.trim() };
    }
    return { success: false };
  } catch (error) {
    console.error('Error reading clipboard text:', error);
    return { success: false, error: error.message };
  }
});

// ---- v2 handlers ----

ipcMain.handle('get-startup-state', async () => {
  return {
    ...startupState,
    documentsPath: path.join(app.getPath('documents'), 'Inspiration'),
    defaultPath: app.getPath('userData')
  };
});

// Setup screen: open or create the library folder, then the app starts
ipcMain.handle('setup-storage', async (event, mode) => {
  let target = null;
  if (mode === 'documents') {
    target = path.join(app.getPath('documents'), 'Inspiration');
  } else if (mode === 'default') {
    target = app.getPath('userData');
  } else if (mode === 'retry') {
    target = startupState.savedPath;
    if (!target || !fs.existsSync(target)) {
      return { success: false, error: 'Still not there. Reconnect the drive, or locate the folder.' };
    }
  } else if (mode === 'choose') {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder for your library',
      message: 'Pick an existing library, or create a new folder with “New Folder”.',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true };
    target = result.filePaths[0];
  } else {
    return { success: false, error: 'Unknown option' };
  }

  try {
    const existing = fs.existsSync(path.join(target, 'inspiration.db'));
    await fs.ensureDir(target);
    initializeDatabase(target);
    startupState = { status: 'ok' };
    const counts = getCounts();
    const items = Object.values(counts.collections).reduce((a, b) => a + b, 0);
    return { success: true, path: target, existing, items };
  } catch (error) {
    console.error('Error setting up storage:', error);
    return { success: false, error: "Couldn't use that folder. Pick one you can write to." };
  }
});

ipcMain.handle('get-settings', async () => {
  return { ...getSettings(), version: app.getVersion() };
});

ipcMain.handle('set-setting', async (event, key, value) => {
  const allowed = {
    theme: ['system', 'light', 'dark'],
    accent: ['clay', 'pine', 'indigo', 'ochre', 'ink'],
    density: ['compact', 'comfortable', 'spacious'],
    captions: [true, false]
  };
  if (!allowed[key] || !allowed[key].includes(value)) return false;
  setSetting(key, value);
  if (key === 'theme') {
    nativeTheme.themeSource = value;
  }
  return true;
});

ipcMain.handle('get-item', async (event, id) => {
  return getItem(id);
});

ipcMain.handle('update-item', async (event, id, fields) => {
  updateItem(id, fields || {});
  return getItem(id);
});

ipcMain.handle('get-all-tags', async () => {
  return getAllTags();
});

// Palette and image details; computed now for items saved before v2
ipcMain.handle('get-item-details', async (event, id) => {
  const item = getItem(id);
  if (!item) return null;
  if (!item.palette && item.file_path && fs.existsSync(item.file_path)) {
    await computeItemMeta(id, item.file_path);
  }
  const fresh = getItem(id);
  let palette = [];
  try { palette = JSON.parse(fresh.palette || '[]'); } catch (e) {}
  return { ...fresh, palette };
});

ipcMain.handle('move-item', async (event, id, collectionId) => {
  try {
    const item = getItem(id);
    if (!item) return { success: false, error: 'Item not found' };
    let newPath = item.file_path;
    if (item.file_path && fs.existsSync(item.file_path)) {
      newPath = path.join(getCollectionFolderPath(collectionId), path.basename(item.file_path));
      await fs.move(item.file_path, newPath, { overwrite: false });
    }
    moveItemToCollection(id, collectionId, newPath);
    return { success: true };
  } catch (error) {
    console.error('Error moving item:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('copy-image', async (event, imagePath) => {
  if (!isInsideImages(imagePath)) return false;
  clipboard.writeImage(nativeImage.createFromPath(imagePath));
  return true;
});

ipcMain.handle('copy-text', async (event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

ipcMain.handle('pick-images', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Add images',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'avif', 'tif', 'tiff'] }]
  });
  return result.canceled ? [] : result.filePaths;
});

// Step 1 of adding a link: fetch title, description and cover without saving anything
ipcMain.handle('preview-url', async (event, rawUrl) => {
  let url = String(rawUrl || '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
  let domain = url;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { success: false, error: 'Only web links can be added' };
    }
    domain = parsed.hostname.replace(/^www\./, '');
  } catch (e) {
    return { success: false, error: "That doesn't look like a link" };
  }

  const tempPath = path.join(app.getPath('temp'), uniqueName('inspiration-', 'img'));

  // A direct image link: download just the image
  try {
    const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000), redirect: 'follow' });
    if ((head.headers.get('content-type') || '').startsWith('image/')) {
      await fs.writeFile(tempPath, await fetchImageBuffer(url));
      const name = decodeURIComponent(path.basename(new URL(url).pathname)).replace(/\.[a-z0-9]+$/i, '');
      return { success: true, url, domain, isImage: true, title: name || domain, description: '', imagePath: tempPath };
    }
  } catch (e) {
    // Fall through to page scraping
  }

  let og = null;
  try {
    const result = await Promise.race([
      ogs({ url, timeout: 6000 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 7000))
    ]);
    og = result.result;
  } catch (e) {
    console.log('Could not read page details for', url);
  }

  let imagePath = null;
  if (og?.ogImage?.[0]?.url) {
    try {
      const imageUrl = new URL(og.ogImage[0].url, url).href;
      await fs.writeFile(tempPath, await fetchImageBuffer(imageUrl, 8000));
      imagePath = tempPath;
    } catch (e) {
      console.log('Could not download cover for', url);
    }
  }

  return {
    success: true,
    url,
    domain,
    isImage: false,
    title: og?.ogTitle || og?.dcTitle || domain,
    description: og?.ogDescription || '',
    imagePath
  };
});

// Step 2: save the previewed link (or image link) into a collection
ipcMain.handle('save-url', async (event, data) => {
  try {
    const { url, domain = '', title = '', tags = '', collectionId = 1, imagePath = null, isImage = false } = data || {};
    const collectionFolder = getCollectionFolderPath(collectionId);
    let destPath = null;

    if (imagePath && isOwnTempFile(imagePath) && fs.existsSync(imagePath)) {
      destPath = path.join(collectionFolder, uniqueName(isImage ? 'img' : 'url', 'jpg'));
      const optimized = await optimizeImage(imagePath, destPath);
      await fs.remove(imagePath);
      if (!optimized) destPath = null;
    }

    if (!destPath) {
      destPath = path.join(collectionFolder, uniqueName('textcard', 'jpg'));
      const generated = await generateTextCard(title || domain, domain || url, destPath);
      if (!generated) return { success: false, error: 'Could not create a preview for this link' };
    }

    const id = addItem({
      collection_id: collectionId,
      type: isImage ? 'image' : 'url',
      title: title || domain,
      source_url: url,
      tags,
      file_path: destPath,
      thumbnail_path: destPath
    });
    await computeItemMeta(id, destPath);
    return { success: true, id };
  } catch (error) {
    console.error('Error saving link:', error);
    return { success: false, error: error.message };
  }
});

// Remove a temp download when the person cancels
ipcMain.handle('discard-temp', async (event, filePath) => {
  if (isOwnTempFile(filePath)) {
    await fs.remove(filePath).catch(() => {});
  }
  return true;
});
