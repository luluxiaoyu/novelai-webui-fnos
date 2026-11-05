const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getConfig, updateConfig, APP_DEST, PKG_VAR } = require('./configManager');
const { closeAllDbs, initDbSchema } = require('./profileDb');

/**
 * Test whether a path exists, is a directory, and is writable.
 * @param {string} targetPath 
 * @returns {{ exists: boolean, writable: boolean, reason: string | null }}
 */
function testPathWritable(targetPath) {
  if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
    return { exists: false, writable: false, reason: '路径不能为空' };
  }
  const cleanPath = path.resolve(targetPath.trim());
  try {
    let stat;
    try {
      stat = fs.statSync(cleanPath);
    } catch (statErr) {
      if (statErr.code === 'ENOENT') {
        return { exists: false, writable: false, reason: '目录不存在' };
      }
      if (statErr.code === 'EACCES' || statErr.code === 'EPERM') {
        return {
          exists: true,
          writable: false,
          reason: '飞牛未授予访问权限，请在飞牛【应用中心】->【已安装】->【NovelAI WebUI】->【设置】->【访问权限】中添加读写授权'
        };
      }
      return { exists: false, writable: false, reason: `无法访问路径: ${statErr.message}` };
    }

    if (!stat.isDirectory()) {
      return { exists: true, writable: false, reason: '指定路径不是一个目录' };
    }
    try {
      fs.accessSync(cleanPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (accErr) {
      return {
        exists: true,
        writable: false,
        reason: '飞牛未授予读写权限，请在飞牛【应用中心】->【已安装】->【NovelAI WebUI】->【设置】->【访问权限】中添加读写授权'
      };
    }
    // Deep verification: create and immediately remove a temporary test file
    const testFileName = `.fnos_write_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const testFilePath = path.join(cleanPath, testFileName);
    try {
      fs.writeFileSync(testFilePath, 'ok', { flag: 'wx' });
      try {
        fs.unlinkSync(testFilePath);
      } catch {}
      return { exists: true, writable: true, reason: null };
    } catch (writeErr) {
      return {
        exists: true,
        writable: false,
        reason: `写入测试失败: ${writeErr.message}。请在飞牛【应用中心】->【访问权限】中确认授予了读写权限`
      };
    }
  } catch (err) {
    return { exists: false, writable: false, reason: err.message || '访问权限校验异常' };
  }
}

/**
 * Scan system for all authorized/accessible storage paths.
 * @returns {{ currentPath: string, paths: Array<object> }}
 */
function getAuthorizedPaths() {
  const currentCfg = getConfig();
  let currentResolved = null;
  if (currentCfg.storagePath) {
    const rawCur = path.resolve(currentCfg.storagePath);
    currentResolved = rawCur;
    try {
      if (fs.existsSync(rawCur)) {
        currentResolved = fs.realpathSync(rawCur);
      }
    } catch {}
  }

  const candidates = [];

  // 1. Current configured storagePath MUST be included even if not created on disk yet
  if (currentCfg.storagePath) {
    const curPath = path.resolve(currentCfg.storagePath);
    candidates.push({ rawPath: curPath, source: 'current_config', shareName: path.basename(curPath) });
  }

  // Helper to parse multi-path strings (JSON array or delimiter separated)
  const parsePathList = (val) => {
    if (!val || typeof val !== 'string') return [];
    const trimmed = val.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) {
          return arr.map(s => String(s).trim()).filter(Boolean);
        }
      } catch {}
    }
    // If it exists as a single intact directory path (even with spaces or unusual characters), prefer that
    if (fs.existsSync(trimmed)) {
      return [trimmed];
    }
    // Otherwise split on colon, semicolon, comma, or newlines
    return trimmed.split(/[:;,\n\r]/).map(s => s.trim()).filter(Boolean);
  };

  // 2. Scan environment variables
  const envVars = [
    process.env.TRIM_DATA_SHARE_PATHS,
    process.env.TRIM_SHARE_PATHS,
    process.env.TRIM_SHARE_DIR,
    process.env.TRIM_APP_SHARE,
    process.env.NOVELAI_SHARE_DIR
  ];

  for (const envVal of envVars) {
    const parsedPaths = parsePathList(envVal);
    for (const p of parsedPaths) {
      if (fs.existsSync(p)) {
        try {
          if (fs.statSync(p).isDirectory()) {
            candidates.push({ rawPath: p, source: 'env_share', shareName: path.basename(p) });
            // If the path itself is a shares container directory, also scan its child directories
            const children = fs.readdirSync(p, { withFileTypes: true });
            for (const child of children) {
              if (child.name.startsWith('.')) continue;
              const childPath = path.join(p, child.name);
              try {
                if (fs.statSync(childPath).isDirectory()) {
                  candidates.push({ rawPath: childPath, source: 'env_share_entry', shareName: child.name });
                }
              } catch {}
            }
          }
        } catch {}
      }
    }
  }

  // 3. Mount shares directories:
  // Both singular ('share') and plural ('shares') under /var/apps/novelai, APP_DEST, and PKG_VAR
  const sharesDirs = [
    '/var/apps/novelai/share',
    '/var/apps/novelai/shares',
    '/var/apps/novelai-webui/share',
    '/var/apps/novelai-webui/shares',
    path.join(APP_DEST, 'share'),
    path.join(APP_DEST, 'shares'),
    path.join(PKG_VAR, 'share'),
    path.join(PKG_VAR, 'shares')
  ];

  for (const sharesDir of sharesDirs) {
    try {
      if (fs.existsSync(sharesDir) && fs.statSync(sharesDir).isDirectory()) {
        const entries = fs.readdirSync(sharesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = path.join(sharesDir, entry.name);
          try {
            if (fs.statSync(fullPath).isDirectory()) {
              candidates.push({ rawPath: fullPath, source: 'shares_dir', shareName: entry.name });
            }
          } catch {}
        }
        if (sharesDir.endsWith('NovelAI-WebUI') || sharesDir.endsWith('NovelAI')) {
          candidates.push({ rawPath: sharesDir, source: 'app_share_dir', shareName: path.basename(sharesDir) });
        }
      }
    } catch (err) {
      console.warn(`[StorageManager] Failed to read shares dir ${sharesDir}:`, err.message);
    }
  }

  // 4. Specific NovelAI app share checks
  const specificShares = [
    '/var/apps/novelai/share/NovelAI-WebUI',
    '/var/apps/novelai/shares/NovelAI-WebUI',
    '/var/apps/novelai-webui/share/NovelAI-WebUI',
    '/var/apps/novelai-webui/shares/NovelAI-WebUI',
    path.join(APP_DEST, 'share/NovelAI-WebUI'),
    path.join(APP_DEST, 'shares/NovelAI-WebUI'),
    path.join(PKG_VAR, 'share/NovelAI-WebUI'),
    path.join(PKG_VAR, 'shares/NovelAI-WebUI'),
    '/var/apps/novelai/share/NovelAI',
    '/var/apps/novelai/shares/NovelAI',
    path.join(APP_DEST, 'share/NovelAI'),
    path.join(APP_DEST, 'shares/NovelAI')
  ];
  for (const sp of specificShares) {
    try {
      if (fs.existsSync(sp) && fs.statSync(sp).isDirectory()) {
        candidates.push({ rawPath: sp, source: 'app_share_specific', shareName: path.basename(sp) });
      }
    } catch {}
  }

  // 5. Volume mounts across /vol1 through /vol9
  for (let vol = 1; vol <= 9; vol++) {
    const volAppShare = `/vol${vol}/@appshare/NovelAI-WebUI`;
    if (fs.existsSync(volAppShare)) {
      candidates.push({ rawPath: volAppShare, source: 'app_share_vol', shareName: 'NovelAI-WebUI' });
    }
    const volShareNovelAI = `/vol${vol}/shares/NovelAI-WebUI`;
    if (fs.existsSync(volShareNovelAI)) {
      candidates.push({ rawPath: volShareNovelAI, source: 'app_share_vol', shareName: 'NovelAI-WebUI' });
    }
    const volShareSingular = `/vol${vol}/share/NovelAI-WebUI`;
    if (fs.existsSync(volShareSingular)) {
      candidates.push({ rawPath: volShareSingular, source: 'app_share_vol', shareName: 'NovelAI-WebUI' });
    }
    // Scan containers: shares, share, @appshare, @share
    for (const sub of ['shares', 'share', '@appshare', '@share']) {
      const parentDir = `/vol${vol}/${sub}`;
      try {
        if (fs.existsSync(parentDir) && fs.statSync(parentDir).isDirectory()) {
          const entries = fs.readdirSync(parentDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(parentDir, entry.name);
            try {
              if (fs.statSync(fullPath).isDirectory()) {
                candidates.push({ rawPath: fullPath, source: sub === '@appshare' ? 'vol_appshare' : 'vol_share', shareName: entry.name });
              }
            } catch {}
          }
        }
      } catch {}
    }
  }

  // 6. Default package var data dir (${TRIM_PKGVAR}/data)
  const defaultVarData = path.join(PKG_VAR, 'data');
  candidates.push({ rawPath: defaultVarData, source: 'default_data', shareName: 'data' });

  // Deduplicate entries by canonical real path
  const seenRealPaths = new Set();
  let results = [];

  for (const item of candidates) {
    const resolvedPath = path.resolve(item.rawPath);
    let realPath = resolvedPath;
    try {
      if (fs.existsSync(resolvedPath)) {
        realPath = fs.realpathSync(resolvedPath);
      }
    } catch {}

    const key = realPath.toLowerCase();
    if (seenRealPaths.has(key)) {
      continue;
    }
    seenRealPaths.add(key);

    // If path exists on disk, ensure it is a directory (skip non-directory files)
    try {
      if (fs.existsSync(realPath) && !fs.statSync(realPath).isDirectory()) {
        continue;
      }
    } catch {}

    const writeCheck = testPathWritable(realPath);

    // Format friendly display name & category (strictly no emojis, professional terminology)
    let friendlyName = '';
    let itemType = 'custom';
    const baseName = item.shareName || path.basename(realPath);

    if (
      baseName === 'NovelAI-WebUI' || 
      baseName === 'NovelAI' || 
      realPath.endsWith('/share/NovelAI-WebUI') || 
      realPath.endsWith('/shares/NovelAI-WebUI') || 
      realPath.includes('@appshare/NovelAI-WebUI') ||
      realPath.includes('/shares/NovelAI-WebUI') ||
      realPath.includes('/share/NovelAI-WebUI')
    ) {
      friendlyName = '应用文件/NovelAI-WebUI (默认)';
      itemType = 'app_share';
    } else if (item.source === 'default_data' || realPath.includes('/var/data') || realPath.includes('@appdata') || realPath.endsWith('/var/data')) {
      friendlyName = `应用私有目录: ${baseName}`;
      itemType = 'appdata';
    } else if (
      item.source === 'shares_dir' || 
      item.source === 'vol_share' || 
      item.source === 'env_share' || 
      item.source === 'env_share_entry' ||
      realPath.includes('/shares/') || 
      realPath.includes('/share/')
    ) {
      friendlyName = `共享文件夹: ${baseName}`;
      itemType = 'share';
    } else {
      friendlyName = `自定义路径: ${baseName}`;
      itemType = 'custom';
    }

    const isCurrent = currentResolved ? (currentResolved === realPath || currentResolved === resolvedPath) : false;

    results.push({
      path: realPath,
      mountPath: resolvedPath !== realPath ? resolvedPath : null,
      name: friendlyName,
      type: itemType,
      exists: writeCheck.exists,
      writable: writeCheck.writable,
      reason: writeCheck.reason,
      isCurrent: !!isCurrent
    });
  }

  // When App Shared Directory is available and exists, hide internal private directory (@appdata)
  // Safety guarantee: only filter if there are other valid paths so results is never empty
  const hasAppShare = results.some(r => r.type === 'app_share' && r.exists);
  if (hasAppShare && results.length > 1) {
    const nonAppData = results.filter(r => !(r.type === 'appdata' || r.path.includes('/var/data') || r.path.includes('@appdata')));
    if (nonAppData.length > 0) {
      results = nonAppData;
    }
  }

  // When App Shared Directory is available and current storagePath points to internal var/data, switch default to app_share
  const appShareItem = results.find(r => r.type === 'app_share' && r.writable) || results.find(r => r.type === 'app_share');
  if (appShareItem && (!currentResolved || currentResolved.includes('/var/data') || currentResolved.includes('@appdata') || currentResolved === path.resolve(defaultVarData))) {
    currentResolved = appShareItem.path;
    appShareItem.isCurrent = true;
    updateConfig({ storagePath: appShareItem.path });
  }

  // Ensure current path is marked isCurrent if not already
  const hasCurrent = results.some(r => r.isCurrent);
  if (!hasCurrent && results.length > 0 && currentResolved) {
    const match = results.find(r => r.path === currentResolved || r.mountPath === currentResolved);
    if (match) {
      match.isCurrent = true;
    }
  }

  const activeItem = results.find(r => r.isCurrent);
  const activePath = activeItem ? activeItem.path : (appShareItem ? appShareItem.path : (currentResolved || currentCfg.storagePath || (results[0] ? results[0].path : '')));

  return {
    currentPath: activePath,
    paths: results
  };
}

/**
 * Validate a candidate storage path
 * @param {string} targetPath 
 * @param {boolean} [createIfMissing=false] 
 * @returns {{ exists: boolean, writable: boolean, reason: string | null }}
 */
function validatePath(targetPath, createIfMissing = false) {
  if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
    return { exists: false, writable: false, reason: '路径不能为空' };
  }
  const cleanPath = path.resolve(targetPath.trim());
  if (createIfMissing && !fs.existsSync(cleanPath)) {
    try {
      fs.mkdirSync(cleanPath, { recursive: true });
    } catch (err) {
      return { exists: false, writable: false, reason: `创建目录失败: ${err.message}` };
    }
  }
  return testPathWritable(cleanPath);
}

/**
 * Safely switch active storagePath, ensure profiles/ directory exists, clear SQLite DB cache, and update config.
 * @param {string} newPath 
 * @returns {{ success: boolean, storagePath: string, config: object }}
 */
function switchStoragePath(newPath) {
  if (!newPath || typeof newPath !== 'string' || !newPath.trim()) {
    throw new Error('目标存储路径不能为空');
  }

  const cleanPath = path.resolve(newPath.trim());

  // Ensure target folder exists or create it
  if (!fs.existsSync(cleanPath)) {
    try {
      fs.mkdirSync(cleanPath, { recursive: true });
    } catch (mkdirErr) {
      throw new Error(`创建目标存储目录失败: ${mkdirErr.message}。请检查父目录写权限`);
    }
  }

  // Validate writability
  const check = testPathWritable(cleanPath);
  if (!check.writable) {
    throw new Error(check.reason || '目标存储目录无写权限，无法切换');
  }

  // Ensure profiles/ exists under cleanPath
  const profilesDir = path.join(cleanPath, 'profiles');
  if (!fs.existsSync(profilesDir)) {
    try {
      fs.mkdirSync(profilesDir, { recursive: true });
    } catch (profErr) {
      throw new Error(`创建 profiles 目录失败: ${profErr.message}`);
    }
  }

  // Ensure logs/ directory also exists under cleanPath
  const logsDir = path.join(cleanPath, 'logs');
  if (!fs.existsSync(logsDir)) {
    try {
      fs.mkdirSync(logsDir, { recursive: true });
    } catch {}
  }

  // Close and flush all open SQLite databases so queries against new directory open newly located DBs
  closeAllDbs();

  // Update configuration
  const updated = updateConfig({ storagePath: cleanPath });

  return {
    success: true,
    storagePath: cleanPath,
    config: updated
  };
}

/**
 * Recursively scan directory and collect files to copy.
 * Ignores temporary files, lock files, sockets, WAL/SHM files, and profile.db (handled via SQL).
 */
function scanFilesToCopy(sourceDir, targetDir, currentRelDir = '', filesToCopy = []) {
  const currentSrc = currentRelDir ? path.join(sourceDir, currentRelDir) : sourceDir;
  if (!fs.existsSync(currentSrc)) return filesToCopy;

  let entries = [];
  try {
    entries = fs.readdirSync(currentSrc, { withFileTypes: true });
  } catch (err) {
    console.warn(`[StorageManager] Cannot read directory ${currentSrc}:`, err.message);
    return filesToCopy;
  }

  for (const entry of entries) {
    const entryName = entry.name;
    // Skip hidden system/temporary files, recycle bins, and sockets
    if (
      entryName.startsWith('.fnos_') || 
      entryName.startsWith('.@') ||
      entryName === '@eaDir' ||
      entryName === '#recycle' ||
      entryName.endsWith('.sock') || 
      entryName.endsWith('.tmp')
    ) {
      continue;
    }
    // Skip SQLite database and journal files (handled specially)
    if (entryName === 'profile.db' || entryName.endsWith('.db-wal') || entryName.endsWith('.db-shm')) {
      continue;
    }

    // At top level of storage directory, only recurse into profiles and logs (ignore foreign directories)
    if (!currentRelDir && entry.isDirectory() && entryName !== 'profiles' && entryName !== 'logs') {
      continue;
    }

    const relPath = currentRelDir ? path.join(currentRelDir, entryName) : entryName;
    const srcFilePath = path.join(sourceDir, relPath);
    const destFilePath = path.join(targetDir, relPath);

    if (entry.isDirectory()) {
      scanFilesToCopy(sourceDir, targetDir, relPath, filesToCopy);
    } else if (entry.isFile()) {
      // Incremental copy: only copy if file does not exist in target
      if (!fs.existsSync(destFilePath)) {
        filesToCopy.push({
          src: srcFilePath,
          dest: destFilePath,
          rel: relPath
        });
      }
    }
  }

  return filesToCopy;
}

/**
 * Scan source profiles directory for SQLite profile.db files and count their records.
 */
function scanProfileDbs(sourceDir) {
  const profilesDir = path.join(sourceDir, 'profiles');
  const dbs = [];
  if (!fs.existsSync(profilesDir)) return dbs;

  let entries = [];
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    return dbs;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const profileName = entry.name;
    const dbPath = path.join(profilesDir, profileName, 'profile.db');
    if (fs.existsSync(dbPath)) {
      let recordCount = 0;
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const tables = ['history', 'prompt_history', 'styles', 'prompt_groups', 'characters', 'profile_settings'];
        for (const t of tables) {
          try {
            const countRow = db.prepare(`SELECT COUNT(*) as count FROM ${t}`).get();
            if (countRow && countRow.count) {
              recordCount += Number(countRow.count);
            }
          } catch {}
        }
        db.close();
      } catch (err) {
        console.warn(`[StorageManager] Failed to count DB records for ${profileName}:`, err.message);
      }
      dbs.push({
        profileName,
        dbPath,
        recordCount
      });
    }
  }

  return dbs;
}

/**
 * Perform incremental merge of data from sourceDir to targetDir
 * @param {string} sourceDir 
 * @param {string} targetDir 
 * @param {function} onProgress 
 * @param {boolean} [switchOnComplete=true]
 * @returns {Promise<{ success: boolean, filesCopied: number, recordsMerged: number, storagePath: string }>}
 */
async function mergeStorageData(sourceDir, targetDir, onProgress = () => {}, switchOnComplete = true) {
  if (!sourceDir || !targetDir) {
    throw new Error('源目录与目标目录均不能为空');
  }
  const cleanSource = path.resolve(sourceDir.trim());
  const cleanTarget = path.resolve(targetDir.trim());

  let realSource = cleanSource;
  let realTarget = cleanTarget;
  try {
    if (fs.existsSync(cleanSource)) realSource = fs.realpathSync(cleanSource);
  } catch {}
  try {
    if (fs.existsSync(cleanTarget)) realTarget = fs.realpathSync(cleanTarget);
  } catch {}

  if (cleanSource === cleanTarget || realSource === realTarget) {
    if (switchOnComplete && cleanTarget !== cleanSource) {
      switchStoragePath(cleanTarget);
    }
    onProgress({
      phase: 'completed',
      percent: 100,
      current: 0,
      total: 0,
      detail: '两侧存储目录相同，无需合并'
    });
    return { success: true, filesCopied: 0, recordsMerged: 0, storagePath: cleanTarget };
  }

  // Ensure target exists and is writable
  if (!fs.existsSync(cleanTarget)) {
    fs.mkdirSync(cleanTarget, { recursive: true });
  }
  const check = testPathWritable(cleanTarget);
  if (!check.writable) {
    throw new Error(check.reason || '目标存储目录无写入权限，无法执行合并');
  }

  // Ensure target profiles and logs directories exist
  fs.mkdirSync(path.join(cleanTarget, 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(cleanTarget, 'logs'), { recursive: true });

  onProgress({
    phase: 'scanning',
    percent: 0,
    current: 0,
    total: 0,
    detail: '正在扫描待合并的文件与历史档案...'
  });

  const filesToCopy = scanFilesToCopy(cleanSource, cleanTarget);
  const profileDbs = scanProfileDbs(cleanSource);
  const totalDbRecords = profileDbs.reduce((sum, item) => sum + item.recordCount, 0);
  const totalItems = filesToCopy.length + totalDbRecords;

  let current = 0;
  let filesCopied = 0;
  let recordsMerged = 0;

  if (totalItems === 0) {
    if (switchOnComplete) {
      switchStoragePath(cleanTarget);
    }
    onProgress({
      phase: 'completed',
      percent: 100,
      current: 0,
      total: 0,
      detail: '增量合并完成（两侧数据已完全一致）',
      stats: { filesCopied: 0, recordsMerged: 0, sourcePath: cleanSource, targetPath: cleanTarget }
    });
    return { success: true, filesCopied: 0, recordsMerged: 0, storagePath: cleanTarget };
  }

  // Phase 1: Copy missing files
  for (let i = 0; i < filesToCopy.length; i++) {
    const item = filesToCopy[i];
    try {
      fs.mkdirSync(path.dirname(item.dest), { recursive: true });
      fs.copyFileSync(item.src, item.dest);
      filesCopied++;
    } catch (copyErr) {
      console.warn(`[StorageManager] Failed to copy file ${item.src} to ${item.dest}:`, copyErr.message);
    }
    current++;
    if (current % 10 === 0 || current === filesToCopy.length) {
      const pct = Math.min(99, Math.floor((current * 100) / totalItems));
      onProgress({
        phase: 'merging',
        percent: pct,
        current,
        total: totalItems,
        detail: `正在复制文件: ${item.rel}`
      });
      await new Promise(r => setImmediate(r));
    }
  }

  // Phase 2: Merge SQLite profile databases without duplicate key conflicts
  closeAllDbs(); // Flush any open connections

  for (const p of profileDbs) {
    const targetProfileDir = path.join(cleanTarget, 'profiles', p.profileName);
    fs.mkdirSync(targetProfileDir, { recursive: true });
    const targetDbPath = path.join(targetProfileDir, 'profile.db');

    let sourceDb = null;
    let targetDb = null;

    try {
      sourceDb = new DatabaseSync(p.dbPath, { readOnly: true });
      targetDb = new DatabaseSync(targetDbPath);
      initDbSchema(targetDb);

      targetDb.exec('BEGIN TRANSACTION');

      // 1. history
      try {
        const rows = sourceDb.prepare('SELECT * FROM history').all();
        const insertHistory = targetDb.prepare(`
          INSERT OR IGNORE INTO history (id, url, timestamp, prompt, negative_prompt, model, params, created_at, is_upscaled)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of rows) {
          insertHistory.run(
            row.id,
            row.url,
            row.timestamp,
            row.prompt,
            row.negative_prompt,
            row.model,
            row.params,
            row.created_at,
            row.is_upscaled || 0
          );
          current++;
          recordsMerged++;
          if (current % 10 === 0) {
            const pct = Math.min(99, Math.floor((current * 100) / totalItems));
            onProgress({
              phase: 'merging',
              percent: pct,
              current,
              total: totalItems,
              detail: `正在合并档案 [${p.profileName}] 生图记录 (${recordsMerged})`
            });
            await new Promise(r => setImmediate(r));
          }
        }
      } catch (err) {
        console.warn(`[StorageManager] Error merging history for ${p.profileName}:`, err.message);
      }

      // 2. prompt_history
      try {
        const rows = sourceDb.prepare('SELECT * FROM prompt_history').all();
        const insertPromptHist = targetDb.prepare(`
          INSERT OR IGNORE INTO prompt_history (id, prompt, negative_prompt, group_name, note, is_favorite, use_coords, characters, timestamp, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of rows) {
          insertPromptHist.run(
            row.id,
            row.prompt,
            row.negative_prompt,
            row.group_name,
            row.note,
            row.is_favorite || 0,
            row.use_coords || 0,
            row.characters,
            row.timestamp,
            row.created_at
          );
          current++;
          recordsMerged++;
        }
      } catch (err) {
        console.warn(`[StorageManager] Error merging prompt_history for ${p.profileName}:`, err.message);
      }

      // 3. styles
      try {
        const rows = sourceDb.prepare('SELECT * FROM styles').all();
        const insertStyle = targetDb.prepare(`
          INSERT OR IGNORE INTO styles (id, name, category, prompt, negative_prompt, preview, is_favorite, updated_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of rows) {
          insertStyle.run(
            row.id,
            row.name,
            row.category,
            row.prompt,
            row.negative_prompt,
            row.preview,
            row.is_favorite || 0,
            row.updated_at,
            row.created_at
          );
          current++;
          recordsMerged++;
        }
      } catch (err) {
        console.warn(`[StorageManager] Error merging styles for ${p.profileName}:`, err.message);
      }

      // 4. prompt_groups
      try {
        const rows = sourceDb.prepare('SELECT * FROM prompt_groups').all();
        const insertGroup = targetDb.prepare(`
          INSERT OR IGNORE INTO prompt_groups (id, name, content, category, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const row of rows) {
          insertGroup.run(
            row.id,
            row.name,
            row.content,
            row.category,
            row.created_at,
            row.updated_at
          );
          current++;
          recordsMerged++;
        }
      } catch (err) {
        console.warn(`[StorageManager] Error merging prompt_groups for ${p.profileName}:`, err.message);
      }

      // 5. characters
      try {
        const rows = sourceDb.prepare('SELECT * FROM characters').all();
        const insertChar = targetDb.prepare(`
          INSERT OR IGNORE INTO characters (id, name, category, prompt, negative_prompt, avatar, preview, is_builtin, is_favorite, updated_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of rows) {
          insertChar.run(
            row.id,
            row.name,
            row.category,
            row.prompt,
            row.negative_prompt,
            row.avatar,
            row.preview,
            row.is_builtin || 0,
            row.is_favorite || 0,
            row.updated_at,
            row.created_at
          );
          current++;
          recordsMerged++;
        }
      } catch (err) {
        console.warn(`[StorageManager] Error merging characters for ${p.profileName}:`, err.message);
      }

      // 6. profile_settings
      try {
        const rows = sourceDb.prepare('SELECT * FROM profile_settings').all();
        const insertSetting = targetDb.prepare(`
          INSERT OR IGNORE INTO profile_settings (key, value)
          VALUES (?, ?)
        `);
        for (const row of rows) {
          insertSetting.run(row.key, row.value);
          current++;
          recordsMerged++;
        }
      } catch (err) {
        console.warn(`[StorageManager] Error merging profile_settings for ${p.profileName}:`, err.message);
      }

      targetDb.exec('COMMIT');
    } catch (dbErr) {
      if (targetDb) {
        try { targetDb.exec('ROLLBACK'); } catch {}
      }
      throw dbErr;
    } finally {
      if (sourceDb) {
        try { sourceDb.close(); } catch {}
      }
      if (targetDb) {
        try { targetDb.close(); } catch {}
      }
    }

    await new Promise(r => setImmediate(r));
  }

  // Phase 3: Switch storage directory if requested
  closeAllDbs();
  if (switchOnComplete) {
    switchStoragePath(cleanTarget);
  }

  onProgress({
    phase: 'completed',
    percent: 100,
    current: totalItems,
    total: totalItems,
    detail: `增量合并完成！共复制 ${filesCopied} 个文件，合并 ${recordsMerged} 条记录`,
    stats: {
      filesCopied,
      recordsMerged,
      sourcePath: cleanSource,
      targetPath: cleanTarget
    }
  });

  return {
    success: true,
    filesCopied,
    recordsMerged,
    storagePath: cleanTarget
  };
}

let currentMergeJob = null;

/**
 * Start an asynchronous merge task with progress tracking
 */
function startMergeJob(sourceDir, targetDir, switchOnComplete = true) {
  if (currentMergeJob && (currentMergeJob.status === 'scanning' || currentMergeJob.status === 'merging')) {
    return {
      jobId: currentMergeJob.id,
      message: '已有增量合并任务正在进行中',
      status: currentMergeJob.status
    };
  }

  const cleanSource = path.resolve(sourceDir.trim());
  const cleanTarget = path.resolve(targetDir.trim());

  const jobId = `merge_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  currentMergeJob = {
    id: jobId,
    status: 'scanning',
    progress: 0,
    current: 0,
    total: 0,
    detail: '正在扫描文件与历史记录...',
    error: null,
    stats: null,
    sourcePath: cleanSource,
    targetPath: cleanTarget,
    startedAt: Date.now()
  };

  setImmediate(async () => {
    try {
      await mergeStorageData(
        cleanSource,
        cleanTarget,
        (progressInfo) => {
          if (!currentMergeJob || currentMergeJob.id !== jobId) return;
          currentMergeJob.status = progressInfo.phase;
          currentMergeJob.progress = progressInfo.percent;
          currentMergeJob.current = progressInfo.current;
          currentMergeJob.total = progressInfo.total;
          currentMergeJob.detail = progressInfo.detail;
          if (progressInfo.stats) {
            currentMergeJob.stats = progressInfo.stats;
          }
        },
        switchOnComplete
      );
    } catch (err) {
      if (currentMergeJob && currentMergeJob.id === jobId) {
        currentMergeJob.status = 'failed';
        currentMergeJob.error = err.message;
        currentMergeJob.detail = `合并失败: ${err.message}`;
      }
    }
  });

  return {
    jobId,
    message: '增量合并任务已启动',
    status: 'scanning'
  };
}

/**
 * Get current merge job status
 */
function getMergeJobStatus(jobId) {
  if (!currentMergeJob) {
    return {
      status: 'idle',
      progress: 0,
      current: 0,
      total: 0,
      detail: '',
      error: null
    };
  }

  if (jobId && currentMergeJob.id !== jobId) {
    return {
      status: 'unknown',
      progress: 0,
      current: 0,
      total: 0,
      detail: '指定的合并任务不存在或已过期',
      error: 'Job not found'
    };
  }

  return {
    jobId: currentMergeJob.id,
    status: currentMergeJob.status,
    progress: currentMergeJob.progress,
    current: currentMergeJob.current,
    total: currentMergeJob.total,
    detail: currentMergeJob.detail,
    error: currentMergeJob.error,
    stats: currentMergeJob.stats,
    targetPath: currentMergeJob.targetPath
  };
}

module.exports = {
  testPathWritable,
  getAuthorizedPaths,
  validatePath,
  switchStoragePath,
  scanFilesToCopy,
  scanProfileDbs,
  mergeStorageData,
  startMergeJob,
  getMergeJobStatus
};
