const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
const fs = require('fs-extra');

// Storage location - can be customized
let storagePath = null;
let dbPath = null;
let imagesPath = null;
let db = null;

// Get storage path from settings or use default
function getStoragePath() {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.storagePath && fs.existsSync(settings.storagePath)) {
        return settings.storagePath;
      }
    } catch (err) {
      console.error('Error reading settings:', err);
    }
  }
  // Default to user data path
  return app.getPath('userData');
}

// Storage path saved in settings (even if that folder is currently missing)
function getSavedStoragePath() {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8')).storagePath || null;
  } catch (err) {
    return null;
  }
}

// All app settings (storage path plus appearance preferences)
const DEFAULT_SETTINGS = { theme: 'system', accent: 'clay', density: 'comfortable', captions: true };

function getSettings() {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    // No settings yet
  }
  return { ...DEFAULT_SETTINGS, ...saved };
}

function setSetting(key, value) {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    // No settings yet
  }
  saved[key] = value;
  fs.writeFileSync(settingsPath, JSON.stringify(saved, null, 2));
}

// Save storage path to settings (keeps the other settings)
function saveStoragePath(newPath) {
  setSetting('storagePath', newPath);
}

// Initialize database with given path
function initializeDatabase(customPath = null) {
  if (customPath) {
    storagePath = customPath;
    saveStoragePath(customPath);
  } else {
    storagePath = getStoragePath();
  }

  // Ensure storage directory exists
  fs.ensureDirSync(storagePath);
  dbPath = path.join(storagePath, 'inspiration.db');
  imagesPath = path.join(storagePath, 'images');

  // Create images folder
  fs.ensureDirSync(imagesPath);

  // Close the previous database when switching storage location
  if (db) {
    db.close();
  }

  // Initialize database
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Required for ON DELETE CASCADE to actually work in SQLite
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#0071e3',
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER,
      type TEXT NOT NULL,
      title TEXT,
      source_url TEXT,
      file_path TEXT,
      thumbnail_path TEXT,
      tags TEXT,
      notes TEXT,
      date_added INTEGER NOT NULL,
      is_favorite INTEGER DEFAULT 0,
      FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
    )
  `);
  
  db.exec('CREATE INDEX IF NOT EXISTS idx_items_collection ON items(collection_id, date_added)');

  // v2 columns: extracted palette and image metadata
  const columns = db.prepare('PRAGMA table_info(items)').all().map(c => c.name);
  [['palette', 'TEXT'], ['width', 'INTEGER'], ['height', 'INTEGER'], ['file_size', 'INTEGER']]
    .forEach(([name, type]) => {
      if (!columns.includes(name)) db.exec(`ALTER TABLE items ADD COLUMN ${name} ${type}`);
    });

  // Remove rows left behind by collections deleted before foreign keys were enabled
  // (their image files were already deleted along with the collection)
  db.prepare('DELETE FROM items WHERE collection_id NOT IN (SELECT id FROM collections)').run();

  // v1 used system blue for the default collection; v2 uses the Atelier clay
  db.prepare("UPDATE collections SET color = '#C4542F' WHERE id = 1 AND lower(color) = '#0071e3'").run();

  // Create default collection if none exists
  const defaultCollection = db.prepare('SELECT * FROM collections WHERE id = 1').get();
  if (!defaultCollection) {
    db.prepare('INSERT INTO collections (name, color, created_at) VALUES (?, ?, ?)').run(
      'My collection',
      '#C4542F',
      Date.now()
    );
  }

  console.log('Database initialized at:', dbPath);
  console.log('Images stored at:', imagesPath);
}

// Initialize with default path on startup
//initializeDatabase();

// Collection functions
function createCollection(name, color = '#0071e3') {
  const stmt = db.prepare('INSERT INTO collections (name, color, created_at) VALUES (?, ?, ?)');
  const result = stmt.run(name, color, Date.now());
  return result.lastInsertRowid;
}

function getAllCollections() {
  return db.prepare('SELECT * FROM collections ORDER BY created_at ASC').all();
}

function deleteCollection(id) {
  if (id === 1) return false;
  const items = db.prepare('SELECT file_path FROM items WHERE collection_id = ?').all(id);
  items.forEach(item => {
    if (item.file_path && fs.existsSync(item.file_path)) {
      try {
        fs.unlinkSync(item.file_path);
      } catch (err) {
        console.error('Error deleting file:', err);
      }
    }
  });
  db.prepare('DELETE FROM collections WHERE id = ?').run(id);
  return true;
}

function renameCollection(id, newName) {
  db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(newName, id);
}

function getCollectionItemCount(id) {
  const result = db.prepare('SELECT COUNT(*) as count FROM items WHERE collection_id = ?').get(id);
  return result.count;
}

// All sidebar counts in one query
function getCounts() {
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const perCollection = {};
  db.prepare('SELECT collection_id, COUNT(*) as count FROM items GROUP BY collection_id').all()
    .forEach(row => { perCollection[row.collection_id] = row.count; });
  return {
    recent: db.prepare('SELECT COUNT(*) as c FROM items WHERE date_added > ?').get(thirtyDaysAgo).c,
    favorites: db.prepare('SELECT COUNT(*) as c FROM items WHERE is_favorite = 1').get().c,
    collections: perCollection
  };
}

// After moving storage, point stored absolute file paths at the new images folder
function rewriteStoragePaths(oldImagesPath, newImagesPath) {
  db.prepare(`
    UPDATE items
    SET file_path = ? || substr(file_path, ?),
        thumbnail_path = ? || substr(thumbnail_path, ?)
    WHERE file_path LIKE ? || '%'
  `).run(newImagesPath, oldImagesPath.length + 1, newImagesPath, oldImagesPath.length + 1, oldImagesPath);
}

// Item functions
function addItem(item) {
  const stmt = db.prepare(`
    INSERT INTO items (collection_id, type, title, source_url, file_path, thumbnail_path, tags, notes, date_added, is_favorite)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    item.collection_id || 1,
    item.type,
    item.title || '',
    item.source_url || '',
    item.file_path || '',
    item.thumbnail_path || '',
    item.tags || '',
    item.notes || '',
    Date.now(),
    item.is_favorite || 0
  );
  return result.lastInsertRowid;
}

// NEW FUNCTION - Get items with pagination (48 items per page)
function getItemsByCollectionPaginated(collectionId, page = 1, itemsPerPage = 15, type = null) {
  if (type === 'image' || type === 'url') {
    return getItemsByTypePaginated(collectionId, page, itemsPerPage, type);
  }
  const offset = (page - 1) * itemsPerPage;
  let query, countQuery;
  let params = [];
  let countParams = [];

  if (collectionId === 'all') {
    query = 'SELECT * FROM items ORDER BY date_added DESC LIMIT ? OFFSET ?';
    countQuery = 'SELECT COUNT(*) as total FROM items';
    params = [itemsPerPage, offset];
  } else if (collectionId === 'recent') {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    query = 'SELECT * FROM items WHERE date_added > ? ORDER BY date_added DESC LIMIT ? OFFSET ?';
    countQuery = 'SELECT COUNT(*) as total FROM items WHERE date_added > ?';
    params = [thirtyDaysAgo, itemsPerPage, offset];
    countParams = [thirtyDaysAgo];
  } else if (collectionId === 'favorites') {
    query = 'SELECT * FROM items WHERE is_favorite = 1 ORDER BY date_added DESC LIMIT ? OFFSET ?';
    countQuery = 'SELECT COUNT(*) as total FROM items WHERE is_favorite = 1';
    params = [itemsPerPage, offset];
  } else {
    query = 'SELECT * FROM items WHERE collection_id = ? ORDER BY date_added DESC LIMIT ? OFFSET ?';
    countQuery = 'SELECT COUNT(*) as total FROM items WHERE collection_id = ?';
    params = [collectionId, itemsPerPage, offset];
    countParams = [collectionId];
  }

  const items = db.prepare(query).all(...params);
  const totalResult = db.prepare(countQuery).get(...countParams);
  const totalItems = totalResult.total;
  const totalPages = Math.ceil(totalItems / itemsPerPage);

  return {
    items,
    pagination: {
      currentPage: page,
      totalPages,
      totalItems,
      itemsPerPage,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1
    }
  };
}

// Same as above, limited to one item type ('image' or 'url')
function getItemsByTypePaginated(collectionId, page, itemsPerPage, type) {
  const offset = (page - 1) * itemsPerPage;
  const where = ['type = ?'];
  const params = [type];
  if (collectionId === 'recent') {
    where.push('date_added > ?');
    params.push(Date.now() - (30 * 24 * 60 * 60 * 1000));
  } else if (collectionId === 'favorites') {
    where.push('is_favorite = 1');
  } else if (collectionId !== 'all') {
    where.push('collection_id = ?');
    params.push(collectionId);
  }
  const clause = where.join(' AND ');
  const items = db.prepare(`SELECT * FROM items WHERE ${clause} ORDER BY date_added DESC LIMIT ? OFFSET ?`)
    .all(...params, itemsPerPage, offset);
  const totalItems = db.prepare(`SELECT COUNT(*) as total FROM items WHERE ${clause}`).get(...params).total;
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  return {
    items,
    pagination: { currentPage: page, totalPages, totalItems, itemsPerPage, hasNextPage: page < totalPages, hasPrevPage: page > 1 }
  };
}

function getItem(id) {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id);
}

// Update any of the editable text fields
function updateItem(id, fields) {
  const allowed = ['title', 'source_url', 'tags', 'notes'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (keys.length === 0) return;
  const sql = `UPDATE items SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...keys.map(k => fields[k] ?? ''), id);
}

function setItemMeta(id, meta) {
  db.prepare('UPDATE items SET palette = ?, width = ?, height = ?, file_size = ? WHERE id = ?')
    .run(JSON.stringify(meta.palette || []), meta.width || null, meta.height || null, meta.file_size || null, id);
}

function moveItemToCollection(id, collectionId, newPath) {
  db.prepare('UPDATE items SET collection_id = ?, file_path = ?, thumbnail_path = ? WHERE id = ?')
    .run(collectionId, newPath, newPath, id);
}

// Every tag in use, most used first (tags are stored comma-separated)
function getAllTags() {
  const counts = {};
  db.prepare("SELECT tags FROM items WHERE tags != ''").all().forEach(row => {
    row.tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean).forEach(t => {
      counts[t] = (counts[t] || 0) + 1;
    });
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
}

function deleteItem(id) {
  const item = db.prepare('SELECT file_path FROM items WHERE id = ?').get(id);
  if (item && item.file_path && fs.existsSync(item.file_path)) {
    try {
      fs.unlinkSync(item.file_path);
    } catch (err) {
      console.error('Error deleting file:', err);
    }
  }
  return db.prepare('DELETE FROM items WHERE id = ?').run(id);
}

function searchItems(query) {
  const stmt = db.prepare(`
    SELECT * FROM items
    WHERE title LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
       OR notes LIKE ? ESCAPE '\\' OR source_url LIKE ? ESCAPE '\\'
    ORDER BY date_added DESC
    LIMIT 500
  `);
  // Treat % and _ typed by the user literally
  const escaped = query.replace(/[\\%_]/g, ch => '\\' + ch);
  const searchPattern = `%${escaped}%`;
  return stmt.all(searchPattern, searchPattern, searchPattern, searchPattern);
}

function toggleFavorite(id) {
  db.prepare('UPDATE items SET is_favorite = NOT is_favorite WHERE id = ?').run(id);
}

function getStorageInfo() {
  return {
    storagePath,
    dbPath,
    imagesPath
  };
}

module.exports = {
  initializeDatabase,
  getStoragePath,
  getSavedStoragePath,
  saveStoragePath,
  getSettings,
  setSetting,
  getItem,
  updateItem,
  setItemMeta,
  moveItemToCollection,
  getAllTags,
  getStorageInfo,
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
  toggleFavorite,
  get imagesPath() { return imagesPath; },
  get storagePath() { return storagePath; }
};
