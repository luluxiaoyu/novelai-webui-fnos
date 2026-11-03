const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Cache open database connections per profile directory
const dbCache = new Map();

function generateCleanId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStr(v, fallback = null) {
  if (v === undefined || v === null) return fallback;
  return String(v);
}

function normalizeNum(v, fallback = null) {
  if (v === undefined || v === null || isNaN(Number(v))) return fallback;
  return Number(v);
}

function normalizeBool(v) {
  return v ? 1 : 0;
}

/**
 * Initialize SQLite database schema and WAL pragmas for a profile
 */
function initDbSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    -- 1. 历史记录 (history / 图库)
    CREATE TABLE IF NOT EXISTS history (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      prompt TEXT,
      negative_prompt TEXT,
      model TEXT,
      params TEXT,
      created_at INTEGER,
      is_upscaled INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_history_created_at ON history (created_at DESC);

    -- 2. 历史 tag / 提示词历史 (prompt_history)
    CREATE TABLE IF NOT EXISTS prompt_history (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      negative_prompt TEXT,
      group_name TEXT,
      note TEXT,
      is_favorite INTEGER DEFAULT 0,
      use_coords INTEGER DEFAULT 0,
      characters TEXT,
      timestamp INTEGER NOT NULL,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_history_timestamp ON prompt_history (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_prompt_history_group ON prompt_history (group_name);
    CREATE INDEX IF NOT EXISTS idx_prompt_history_fav ON prompt_history (is_favorite);

    -- 3. 画师库 / 风格库 (styles)
    CREATE TABLE IF NOT EXISTS styles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT DEFAULT '自定义',
      prompt TEXT NOT NULL,
      negative_prompt TEXT,
      preview TEXT,
      is_favorite INTEGER DEFAULT 0,
      updated_at INTEGER,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_styles_category ON styles (category);
    CREATE INDEX IF NOT EXISTS idx_styles_fav ON styles (is_favorite);

    -- 4. tag 库 / 提示词组 (prompt_groups)
    CREATE TABLE IF NOT EXISTS prompt_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      content TEXT,
      category TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_groups_name ON prompt_groups (name);

    -- 5. 角色库 (characters)
    CREATE TABLE IF NOT EXISTS characters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT DEFAULT '自定义',
      prompt TEXT NOT NULL,
      negative_prompt TEXT,
      avatar TEXT,
      preview TEXT,
      is_builtin INTEGER DEFAULT 0,
      is_favorite INTEGER DEFAULT 0,
      updated_at INTEGER,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_characters_category ON characters (category);
    CREATE INDEX IF NOT EXISTS idx_characters_fav ON characters (is_favorite);

    -- 6. 配置/绘图参数/元数据 (profile_settings)
    CREATE TABLE IF NOT EXISTS profile_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

/**
 * Silently auto-migrate data.json into SQLite profile.db if data.json exists
 */
function migrateProfileIfNeeded(db, profileDir, profileName) {
  const jsonPath = path.join(profileDir, 'data.json');
  if (!fs.existsSync(jsonPath)) {
    return false;
  }

  let content = '';
  try {
    content = fs.readFileSync(jsonPath, 'utf8');
  } catch (err) {
    console.error(`[ProfileDb] Error reading ${jsonPath} for migration:`, err.message);
    return false;
  }

  if (!content || !content.trim()) {
    try {
      fs.unlinkSync(jsonPath);
    } catch {}
    return false;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch (parseErr) {
    console.error(`[ProfileDb] Corrupt data.json in profile "${profileName}":`, parseErr.message);
    try {
      fs.renameSync(jsonPath, `${jsonPath}.bak.corrupt`);
    } catch {}
    return false;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`[ProfileDb] Invalid non-object data.json in profile "${profileName}", backing up`);
    try {
      fs.renameSync(jsonPath, `${jsonPath}.bak.corrupt`);
    } catch {}
    return false;
  }

  const imagesDir = path.join(profileDir, 'images');
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  console.log(`[ProfileDb] Starting silent migration for profile "${profileName}" from data.json to SQLite...`);

  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    // 1. Migrate history (图库)
    const rawHistory = Array.isArray(parsed.history) ? parsed.history : [];
    const insHistory = db.prepare(`
      INSERT OR REPLACE INTO history 
      (id, url, timestamp, prompt, negative_prompt, model, params, created_at, is_upscaled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let validHistoryCount = 0;
    const historyIdSet = new Set();

    for (const item of rawHistory) {
      if (!item) continue;
      const cleanItem = { ...item };
      delete cleanItem.isNew;

      const imgId = String(cleanItem.id || generateCleanId('img'));
      historyIdSet.add(imgId);

      // Save base64 image data to PNG file if not yet stored on disk
      let rawBase64 = null;
      if (typeof cleanItem.url === 'string' && cleanItem.url.startsWith('data:image/')) {
        rawBase64 = cleanItem.url.split(',')[1];
      } else if (typeof cleanItem.image === 'string' && cleanItem.image.startsWith('data:image/')) {
        rawBase64 = cleanItem.image.split(',')[1];
      }

      if (rawBase64) {
        try {
          const buf = Buffer.from(rawBase64, 'base64');
          const imgPath = path.join(imagesDir, `${imgId}.png`);
          fs.writeFileSync(imgPath, buf);
          cleanItem.url = `/api/images/${encodeURIComponent(profileName)}/${encodeURIComponent(imgId)}.png`;
        } catch (e) {
          console.error(`[ProfileDb] Failed to save base64 history image (${imgId}):`, e.message);
        }
      }

      const url = String(cleanItem.url || '');
      const timestamp = normalizeNum(cleanItem.timestamp, Date.now());
      const prompt = cleanItem.params?.prompt || cleanItem.prompt || null;
      const negative_prompt = cleanItem.params?.negative_prompt || cleanItem.params?.uc || cleanItem.negative_prompt || null;
      const model = cleanItem.params?.model || cleanItem.model || null;
      let paramsStr = '{}';
      if (typeof cleanItem.params === 'object' && cleanItem.params !== null) {
        try {
          paramsStr = JSON.stringify(cleanItem.params);
        } catch {}
      } else if (typeof cleanItem.params === 'string' && cleanItem.params.trim()) {
        paramsStr = cleanItem.params;
      }
      const created_at = normalizeNum(cleanItem.created_at || cleanItem.createdAt || timestamp, timestamp);
      const is_upscaled = (cleanItem.isUpscaled || cleanItem.params?.is_upscaled) ? 1 : 0;

      insHistory.run(imgId, url, timestamp, prompt, negative_prompt, model, paramsStr, created_at, is_upscaled);
      validHistoryCount++;
    }

    // 2. Migrate prompt_history (历史 tag / 提示词历史)
    const rawPromptHistory = Array.isArray(parsed.promptHistory) ? parsed.promptHistory : [];
    const insPromptHistory = db.prepare(`
      INSERT OR REPLACE INTO prompt_history 
      (id, prompt, negative_prompt, group_name, note, is_favorite, use_coords, characters, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const promptIdSet = new Set();
    for (const item of rawPromptHistory) {
      if (!item || !item.prompt) continue;
      const pId = String(item.id || generateCleanId('ph'));
      promptIdSet.add(pId);

      const prompt = String(item.prompt);
      const negative_prompt = normalizeStr(item.negative_prompt, null);
      const group_name = normalizeStr(item.group || item.group_name, null);
      const note = normalizeStr(item.note, null);
      const is_favorite = normalizeBool(item.isFavorite);
      const use_coords = normalizeBool(item.use_coords);
      let characters = null;
      if (Array.isArray(item.characters)) {
        try {
          characters = JSON.stringify(item.characters);
        } catch {}
      } else if (typeof item.characters === 'string') {
        characters = item.characters;
      }
      const timestamp = normalizeNum(item.timestamp, Date.now());
      const created_at = normalizeNum(item.created_at || item.createdAt || timestamp, timestamp);

      insPromptHistory.run(pId, prompt, negative_prompt, group_name, note, is_favorite, use_coords, characters, timestamp, created_at);
    }

    // 3. Migrate customStyles -> styles (画师库 / 风格库)
    const rawStyles = Array.isArray(parsed.customStyles) ? parsed.customStyles : [];
    const insStyles = db.prepare(`
      INSERT OR REPLACE INTO styles 
      (id, name, category, prompt, negative_prompt, preview, is_favorite, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const styleIdSet = new Set();
    for (const item of rawStyles) {
      if (!item) continue;
      const sId = String(item.id || generateCleanId('style'));
      styleIdSet.add(sId);

      const name = String(item.name || '未命名风格');
      const category = normalizeStr(item.category, '自定义');
      const prompt = String(item.prompt || '');
      const negative_prompt = normalizeStr(item.negative_prompt || item.uc, null);
      const preview = normalizeStr(item.preview, null);
      const is_favorite = normalizeBool(item.isFavorite);
      const updated_at = normalizeNum(item.updatedAt || item.updated_at, Date.now());
      const created_at = normalizeNum(item.createdAt || item.created_at || updated_at, updated_at);

      insStyles.run(sId, name, category, prompt, negative_prompt, preview, is_favorite, updated_at, created_at);
    }

    // 4. Migrate savedPromptGroups & promptGroups -> prompt_groups (tag 库 / 提示词组)
    const rawGroups = [];
    const seenNames = new Set();
    if (Array.isArray(parsed.promptGroups)) {
      for (const g of parsed.promptGroups) {
        if (!g) continue;
        const name = typeof g === 'string' ? g.trim() : String(g.name || '').trim();
        if (name && !seenNames.has(name)) {
          seenNames.add(name);
          rawGroups.push(g);
        }
      }
    }
    if (Array.isArray(parsed.savedPromptGroups)) {
      for (const g of parsed.savedPromptGroups) {
        if (!g) continue;
        const name = typeof g === 'string' ? g.trim() : String(g.name || '').trim();
        if (name && !seenNames.has(name)) {
          seenNames.add(name);
          rawGroups.push(g);
        }
      }
    }

    const insGroups = db.prepare(`
      INSERT OR REPLACE INTO prompt_groups 
      (id, name, content, category, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const groupIdSet = new Set();
    for (const item of rawGroups) {
      if (!item) continue;
      let gId, name, content, category, created_at, updated_at;
      if (typeof item === 'string') {
        name = item.trim();
        if (!name) continue;
        gId = `grp_${Buffer.from(name).toString('hex').slice(0, 16)}`;
        content = null;
        category = null;
        created_at = Date.now();
        updated_at = created_at;
      } else {
        name = String(item.name || '').trim();
        if (!name) continue;
        gId = String(item.id || `grp_${Buffer.from(name).toString('hex').slice(0, 16)}`);
        content = normalizeStr(item.content || item.tags, null);
        category = normalizeStr(item.category, null);
        created_at = normalizeNum(item.created_at || item.createdAt, Date.now());
        updated_at = normalizeNum(item.updated_at || item.updatedAt || created_at, created_at);
      }
      groupIdSet.add(name);
      insGroups.run(gId, name, content, category, created_at, updated_at);
    }

    // 5. Migrate customCharacters -> characters (角色库)
    const rawCharacters = Array.isArray(parsed.customCharacters) ? parsed.customCharacters : [];
    const insCharacters = db.prepare(`
      INSERT OR REPLACE INTO characters 
      (id, name, category, prompt, negative_prompt, avatar, preview, is_builtin, is_favorite, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const charIdSet = new Set();
    for (const item of rawCharacters) {
      if (!item) continue;
      const cId = String(item.id || generateCleanId('char'));
      charIdSet.add(cId);

      const name = String(item.name || '未命名角色');
      const category = normalizeStr(item.category, '自定义');
      const prompt = String(item.prompt || '');
      const negative_prompt = normalizeStr(item.negative_prompt || item.uc, null);
      const avatar = normalizeStr(item.avatar, null);
      const preview = normalizeStr(item.preview || avatar, null);
      const is_builtin = normalizeBool(item.isBuiltin);
      const is_favorite = normalizeBool(item.isFavorite);
      const updated_at = normalizeNum(item.updatedAt || item.updated_at, Date.now());
      const created_at = normalizeNum(item.createdAt || item.created_at || updated_at, updated_at);

      insCharacters.run(cId, name, category, prompt, negative_prompt, avatar, preview, is_builtin, is_favorite, updated_at, created_at);
    }

    // 6. Migrate root params if present
    if (parsed.params && typeof parsed.params === 'object') {
      try {
        db.prepare(`INSERT OR REPLACE INTO profile_settings (key, value) VALUES ('params', ?)`).run(JSON.stringify(parsed.params));
      } catch {}
    }

    // 7. Verify Integrity
    const countHist = db.prepare('SELECT COUNT(*) as c FROM history').get().c;
    const countPromptHist = db.prepare('SELECT COUNT(*) as c FROM prompt_history').get().c;
    const countStyles = db.prepare('SELECT COUNT(*) as c FROM styles').get().c;
    const countGroups = db.prepare('SELECT COUNT(*) as c FROM prompt_groups').get().c;
    const countChars = db.prepare('SELECT COUNT(*) as c FROM characters').get().c;

    if (
      countHist < historyIdSet.size ||
      countPromptHist < promptIdSet.size ||
      countStyles < styleIdSet.size ||
      countGroups < groupIdSet.size ||
      countChars < charIdSet.size
    ) {
      throw new Error(`Data verification count mismatch! Expected >= [${historyIdSet.size}, ${promptIdSet.size}, ${styleIdSet.size}, ${groupIdSet.size}, ${charIdSet.size}], Actual: [${countHist}, ${countPromptHist}, ${countStyles}, ${countGroups}, ${countChars}]`);
    }

    // Set schema version and migration metadata
    db.prepare(`INSERT OR REPLACE INTO profile_settings (key, value) VALUES ('version', '2.0.0')`).run();
    db.prepare(`INSERT OR REPLACE INTO profile_settings (key, value) VALUES ('migrated_at', ?)`).run(String(Date.now()));

    db.exec('COMMIT;');

    // 8. Safely delete old data.json after verified successful transaction
    try {
      fs.unlinkSync(jsonPath);
      console.log(`[ProfileDb] Successfully migrated profile "${profileName}" to SQLite profile.db and deleted data.json`);
    } catch (unlinkErr) {
      console.warn(`[ProfileDb] Migration succeeded but failed to delete data.json:`, unlinkErr.message);
    }

    return true;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {}
    console.error(`[ProfileDb] Migration transaction failed for profile "${profileName}":`, err.message);
    try {
      fs.renameSync(jsonPath, `${jsonPath}.bak.failed`);
    } catch {}
    throw err;
  }
}

/**
 * Get or open cached DatabaseSync instance for a profile directory
 */
function getDb(profileDir, profileName = 'Default') {
  const normalizedDir = path.resolve(profileDir);
  let db;
  if (dbCache.has(normalizedDir)) {
    db = dbCache.get(normalizedDir);
  } else {
    if (!fs.existsSync(normalizedDir)) {
      fs.mkdirSync(normalizedDir, { recursive: true });
    }

    const dbPath = path.join(normalizedDir, 'profile.db');
    db = new DatabaseSync(dbPath);

    initDbSchema(db);
    dbCache.set(normalizedDir, db);
  }

  // If data.json is present (initial access or dropped in later), silently migrate and delete it
  const jsonPath = path.join(normalizedDir, 'data.json');
  if (fs.existsSync(jsonPath)) {
    migrateProfileIfNeeded(db, normalizedDir, profileName);
  }

  return db;
}

/**
 * Close and release DB connection for a profile directory
 */
function closeDb(profileDir) {
  const normalizedDir = path.resolve(profileDir);
  if (dbCache.has(normalizedDir)) {
    const db = dbCache.get(normalizedDir);
    try {
      db.close();
    } catch (e) {
      console.warn(`[ProfileDb] Error closing DB for ${normalizedDir}:`, e.message);
    }
    dbCache.delete(normalizedDir);
  }
}

/**
 * Close all cached DB connections
 */
function closeAllDbs() {
  for (const [dir, db] of dbCache.entries()) {
    try {
      db.close();
    } catch {}
  }
  dbCache.clear();
}

// Automatically close DB connections on process exit
process.on('exit', () => closeAllDbs());

// ==================== Data Format Helpers ====================

function formatDbRowToHistory(row) {
  let params = {};
  if (row.params) {
    try {
      params = typeof row.params === 'string' ? JSON.parse(row.params) : row.params;
    } catch {}
  }
  if (!params.prompt && row.prompt) params.prompt = row.prompt;
  if (!params.negative_prompt && row.negative_prompt) params.negative_prompt = row.negative_prompt;
  if (!params.model && row.model) params.model = row.model;

  return {
    id: row.id,
    url: row.url,
    prompt: row.prompt || params.prompt || '',
    negative_prompt: row.negative_prompt || params.negative_prompt || '',
    model: row.model || params.model || '',
    params,
    timestamp: Number(row.timestamp),
    createdAt: Number(row.created_at || row.timestamp),
    isUpscaled: Boolean(row.is_upscaled)
  };
}

function formatDbRowToPromptHistory(row) {
  let characters = [];
  if (row.characters) {
    try {
      characters = typeof row.characters === 'string' ? JSON.parse(row.characters) : row.characters;
    } catch {}
  }
  return {
    id: row.id,
    prompt: row.prompt,
    negative_prompt: row.negative_prompt || '',
    group: row.group_name || '',
    note: row.note || '',
    isFavorite: Boolean(row.is_favorite),
    use_coords: Boolean(row.use_coords),
    characters,
    timestamp: Number(row.timestamp),
    createdAt: Number(row.created_at || row.timestamp)
  };
}

function formatDbRowToStyle(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category || '自定义',
    prompt: row.prompt,
    uc: row.negative_prompt || '',
    negative_prompt: row.negative_prompt || '',
    preview: row.preview || '',
    isFavorite: Boolean(row.is_favorite),
    updatedAt: Number(row.updated_at || row.created_at || 0)
  };
}

function formatDbRowToPromptGroup(row) {
  return {
    id: row.id,
    name: row.name,
    content: row.content || '',
    category: row.category || '',
    updatedAt: Number(row.updated_at || row.created_at || 0)
  };
}

function formatDbRowToCharacter(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category || '自定义',
    prompt: row.prompt,
    uc: row.negative_prompt || '',
    negative_prompt: row.negative_prompt || '',
    avatar: row.avatar || '',
    preview: row.preview || row.avatar || '',
    isBuiltin: Boolean(row.is_builtin),
    isFavorite: Boolean(row.is_favorite),
    updatedAt: Number(row.updated_at || row.created_at || 0)
  };
}

// ==================== Exported Database Operations ====================

function getHistory(db, options = {}) {
  const pageRaw = parseInt(options.page, 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;

  let pageSize = null;
  const rawLimit = options.limit !== undefined ? parseInt(options.limit, 10) : undefined;
  const rawPageSize = options.pageSize !== undefined ? parseInt(options.pageSize, 10) : undefined;
  const targetSize = Number.isFinite(rawLimit) ? rawLimit : (Number.isFinite(rawPageSize) ? rawPageSize : null);
  if (targetSize !== null) {
    pageSize = Math.max(1, Math.min(1000, targetSize));
  }

  let offset;
  const rawOffset = options.offset !== undefined ? parseInt(options.offset, 10) : undefined;
  if (Number.isFinite(rawOffset) && rawOffset >= 0) {
    offset = rawOffset;
  } else if (pageSize !== null) {
    offset = (page - 1) * pageSize;
  } else {
    offset = 0;
  }

  const search = options.search ? String(options.search).trim() : '';
  const sort = String(options.sort).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const whereClauses = [];
  const params = [];

  if (search) {
    whereClauses.push('(prompt LIKE ? OR negative_prompt LIKE ? OR model LIKE ? OR id LIKE ? OR params LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term, term, term, term);
  }

  if (options.isUpscaled !== undefined) {
    whereClauses.push('is_upscaled = ?');
    params.push(options.isUpscaled ? 1 : 0);
  }

  if (options.timeFilter?.start !== undefined) {
    const startNum = Number(options.timeFilter.start);
    if (Number.isFinite(startNum)) {
      whereClauses.push('timestamp >= ?');
      params.push(startNum);
    }
  }
  if (options.timeFilter?.end !== undefined) {
    const endNum = Number(options.timeFilter.end);
    if (Number.isFinite(endNum)) {
      whereClauses.push('timestamp <= ?');
      params.push(endNum);
    }
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM history ${whereSql}`).get(...params);
  const total = countRow ? countRow.total : 0;
  const totalPages = pageSize ? Math.ceil(total / pageSize) || 1 : 1;

  let querySql = `SELECT * FROM history ${whereSql} ORDER BY timestamp ${sort}`;
  let queryParams = [...params];

  if (pageSize !== null) {
    querySql += ` LIMIT ? OFFSET ?`;
    queryParams.push(pageSize, offset);
  }

  const rows = db.prepare(querySql).all(...queryParams);

  return {
    history: rows.map(formatDbRowToHistory),
    total,
    page,
    pageSize: pageSize || total,
    totalPages
  };
}

function addHistoryItem(db, item) {
  if (!item || !item.id) return false;
  const id = String(item.id);
  const url = String(item.url || '');
  const timestamp = normalizeNum(item.timestamp, Date.now());
  const prompt = item.params?.prompt || item.prompt || null;
  const negative_prompt = item.params?.negative_prompt || item.params?.uc || item.negative_prompt || null;
  const model = item.params?.model || item.model || null;
  let paramsStr = '{}';
  if (typeof item.params === 'object' && item.params !== null) {
    try {
      paramsStr = JSON.stringify(item.params);
    } catch {}
  } else if (typeof item.params === 'string' && item.params.trim()) {
    paramsStr = item.params;
  }
  const created_at = normalizeNum(item.created_at || item.createdAt || timestamp, timestamp);
  const is_upscaled = (item.isUpscaled || item.params?.is_upscaled) ? 1 : 0;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO history 
    (id, url, timestamp, prompt, negative_prompt, model, params, created_at, is_upscaled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, url, timestamp, prompt, negative_prompt, model, paramsStr, created_at, is_upscaled);
  return true;
}

function addHistoryItems(db, items) {
  if (!Array.isArray(items) || items.length === 0) return true;
  db.exec('BEGIN TRANSACTION;');
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO history 
      (id, url, timestamp, prompt, negative_prompt, model, params, created_at, is_upscaled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of items) {
      if (!item || !item.id) continue;
      const id = String(item.id);
      const url = String(item.url || '');
      const timestamp = normalizeNum(item.timestamp, Date.now());
      const prompt = item.params?.prompt || item.prompt || null;
      const negative_prompt = item.params?.negative_prompt || item.params?.uc || item.negative_prompt || null;
      const model = item.params?.model || item.model || null;
      let paramsStr = '{}';
      if (typeof item.params === 'object' && item.params !== null) {
        try {
          paramsStr = JSON.stringify(item.params);
        } catch {}
      } else if (typeof item.params === 'string' && item.params.trim()) {
        paramsStr = item.params;
      }
      const created_at = normalizeNum(item.created_at || item.createdAt || timestamp, timestamp);
      const is_upscaled = (item.isUpscaled || item.params?.is_upscaled) ? 1 : 0;

      stmt.run(id, url, timestamp, prompt, negative_prompt, model, paramsStr, created_at, is_upscaled);
    }
    db.exec('COMMIT;');
    return true;
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function deleteHistoryItem(db, id) {
  const strId = String(id);
  const altId = strId.endsWith('.png') ? strId.slice(0, -4) : `${strId}.png`;
  const stmt = db.prepare(`DELETE FROM history WHERE id = ? OR id = ?`);
  const res = stmt.run(strId, altId);
  return res.changes > 0;
}

function batchDeleteHistoryItems(db, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return true;
  const validIds = ids.filter(i => i !== undefined && i !== null && String(i).trim() !== '');
  if (validIds.length === 0) return true;

  db.exec('BEGIN TRANSACTION;');
  try {
    const chunkSize = 400;
    for (let i = 0; i < validIds.length; i += chunkSize) {
      const chunk = validIds.slice(i, i + chunkSize);
      const allPossibleIds = new Set();
      for (const id of chunk) {
        const s = String(id);
        allPossibleIds.add(s);
        if (s.endsWith('.png')) {
          allPossibleIds.add(s.slice(0, -4));
        } else {
          allPossibleIds.add(`${s}.png`);
        }
      }
      const arr = Array.from(allPossibleIds);
      const placeholders = arr.map(() => '?').join(',');
      db.prepare(`DELETE FROM history WHERE id IN (${placeholders})`).run(...arr);
    }
    db.exec('COMMIT;');
    return true;
  } catch (e) {
    db.exec('ROLLBACK;');
    throw e;
  }
}

function getAllPromptHistory(db) {
  const rows = db.prepare(`SELECT * FROM prompt_history ORDER BY timestamp DESC`).all();
  return rows.map(formatDbRowToPromptHistory);
}

function savePromptHistory(db, list) {
  if (!Array.isArray(list)) return;
  db.exec('BEGIN TRANSACTION;');
  try {
    db.exec('DELETE FROM prompt_history;');
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO prompt_history 
      (id, prompt, negative_prompt, group_name, note, is_favorite, use_coords, characters, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of list) {
      if (!item || !item.prompt) continue;
      const id = String(item.id || generateCleanId('ph'));
      const prompt = String(item.prompt);
      const negative_prompt = normalizeStr(item.negative_prompt, null);
      const group_name = normalizeStr(item.group || item.group_name, null);
      const note = normalizeStr(item.note, null);
      const is_favorite = normalizeBool(item.isFavorite);
      const use_coords = normalizeBool(item.use_coords);
      let characters = null;
      if (Array.isArray(item.characters)) {
        try {
          characters = JSON.stringify(item.characters);
        } catch {}
      } else if (typeof item.characters === 'string') {
        characters = item.characters;
      }
      const timestamp = normalizeNum(item.timestamp, Date.now());
      const created_at = normalizeNum(item.created_at || item.createdAt || timestamp, timestamp);

      stmt.run(id, prompt, negative_prompt, group_name, note, is_favorite, use_coords, characters, timestamp, created_at);
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function getAllStyles(db) {
  const rows = db.prepare(`SELECT * FROM styles ORDER BY updated_at DESC`).all();
  return rows.map(formatDbRowToStyle);
}

function saveStyles(db, list) {
  if (!Array.isArray(list)) return;
  db.exec('BEGIN TRANSACTION;');
  try {
    db.exec('DELETE FROM styles;');
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO styles 
      (id, name, category, prompt, negative_prompt, preview, is_favorite, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of list) {
      if (!item) continue;
      const id = String(item.id || generateCleanId('style'));
      const name = String(item.name || '未命名风格');
      const category = normalizeStr(item.category, '自定义');
      const prompt = String(item.prompt || '');
      const negative_prompt = normalizeStr(item.negative_prompt || item.uc, null);
      const preview = normalizeStr(item.preview, null);
      const is_favorite = normalizeBool(item.isFavorite);
      const updated_at = normalizeNum(item.updatedAt || item.updated_at, Date.now());
      const created_at = normalizeNum(item.createdAt || item.created_at || updated_at, updated_at);

      stmt.run(id, name, category, prompt, negative_prompt, preview, is_favorite, updated_at, created_at);
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function getAllCharacters(db) {
  const rows = db.prepare(`SELECT * FROM characters ORDER BY updated_at DESC`).all();
  return rows.map(formatDbRowToCharacter);
}

function saveCharacters(db, list) {
  if (!Array.isArray(list)) return;
  db.exec('BEGIN TRANSACTION;');
  try {
    db.exec('DELETE FROM characters;');
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO characters 
      (id, name, category, prompt, negative_prompt, avatar, preview, is_builtin, is_favorite, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of list) {
      if (!item) continue;
      const id = String(item.id || generateCleanId('char'));
      const name = String(item.name || '未命名角色');
      const category = normalizeStr(item.category, '自定义');
      const prompt = String(item.prompt || '');
      const negative_prompt = normalizeStr(item.negative_prompt || item.uc, null);
      const avatar = normalizeStr(item.avatar, null);
      const preview = normalizeStr(item.preview || avatar, null);
      const is_builtin = normalizeBool(item.isBuiltin);
      const is_favorite = normalizeBool(item.isFavorite);
      const updated_at = normalizeNum(item.updatedAt || item.updated_at, Date.now());
      const created_at = normalizeNum(item.createdAt || item.created_at || updated_at, updated_at);

      stmt.run(id, name, category, prompt, negative_prompt, avatar, preview, is_builtin, is_favorite, updated_at, created_at);
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function getAllPromptGroups(db) {
  const rows = db.prepare(`SELECT * FROM prompt_groups ORDER BY name ASC`).all();
  return rows.map(formatDbRowToPromptGroup);
}

function savePromptGroups(db, list) {
  if (!Array.isArray(list)) return;

  const existingRows = db.prepare(`SELECT * FROM prompt_groups`).all();
  const existingByName = new Map();
  for (const row of existingRows) {
    existingByName.set(row.name, row);
  }

  db.exec('BEGIN TRANSACTION;');
  try {
    db.exec('DELETE FROM prompt_groups;');
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO prompt_groups 
      (id, name, content, category, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const seenNames = new Set();
    for (const item of list) {
      if (!item) continue;
      let id, name, content, category, created_at, updated_at;
      if (typeof item === 'string') {
        name = item.trim();
        if (!name || seenNames.has(name)) continue;
        seenNames.add(name);
        const existing = existingByName.get(name);
        if (existing) {
          id = existing.id;
          content = existing.content;
          category = existing.category;
          created_at = Number(existing.created_at || Date.now());
          updated_at = Date.now();
        } else {
          id = `grp_${Buffer.from(name).toString('hex').slice(0, 16)}`;
          content = null;
          category = null;
          created_at = Date.now();
          updated_at = created_at;
        }
      } else {
        name = String(item.name || '').trim();
        if (!name || seenNames.has(name)) continue;
        seenNames.add(name);
        const existing = existingByName.get(name);
        id = String(item.id || existing?.id || `grp_${Buffer.from(name).toString('hex').slice(0, 16)}`);
        content = normalizeStr(item.content ?? item.tags ?? existing?.content, null);
        category = normalizeStr(item.category ?? existing?.category, null);
        created_at = normalizeNum(item.created_at || item.createdAt || existing?.created_at, Date.now());
        updated_at = normalizeNum(item.updated_at || item.updatedAt || Date.now(), Date.now());
      }
      stmt.run(id, name, content, category, created_at, updated_at);
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

function updateHistoryProfileUrl(db, oldProfileName, newProfileName) {
  const oldPrefix1 = `/api/images/${oldProfileName}/`;
  const oldPrefix2 = `/api/images/${encodeURIComponent(oldProfileName)}/`;
  const newPrefix = `/api/images/${encodeURIComponent(newProfileName)}/`;

  try {
    db.prepare(`
      UPDATE history 
      SET url = replace(url, ?, ?) 
      WHERE url LIKE ?
    `).run(oldPrefix1, newPrefix, `${oldPrefix1}%`);

    if (oldPrefix1 !== oldPrefix2) {
      db.prepare(`
        UPDATE history 
        SET url = replace(url, ?, ?) 
        WHERE url LIKE ?
      `).run(oldPrefix2, newPrefix, `${oldPrefix2}%`);
    }
  } catch (err) {
    console.warn(`[ProfileDb] Failed to update history profile URLs from "${oldProfileName}" to "${newProfileName}":`, err.message);
  }
}

function getSettings(db) {
  const rows = db.prepare(`SELECT key, value FROM profile_settings`).all();
  const settings = {};
  for (const r of rows) {
    settings[r.key] = r.value;
  }
  return settings;
}

function saveSetting(db, key, value) {
  const strVal = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  db.prepare(`INSERT OR REPLACE INTO profile_settings (key, value) VALUES (?, ?)`).run(key, strVal);
}

module.exports = {
  getDb,
  closeDb,
  closeAllDbs,
  migrateProfileIfNeeded,
  getHistory,
  addHistoryItem,
  addHistoryItems,
  deleteHistoryItem,
  batchDeleteHistoryItems,
  getAllPromptHistory,
  savePromptHistory,
  getAllStyles,
  saveStyles,
  getAllCharacters,
  saveCharacters,
  getAllPromptGroups,
  savePromptGroups,
  updateHistoryProfileUrl,
  getSettings,
  saveSetting
};
