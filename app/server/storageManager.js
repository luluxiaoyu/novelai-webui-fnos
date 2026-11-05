const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getConfig, updateConfig, DATA_DIR } = require('./configManager');
const { closeAllDbs, initDbSchema } = require('./profileDb');
const { isFnosRuntime, assertStorageAdmin, callFnosApi, checkUserPaths } = require('./fnosApi');

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
      fs.unlinkSync(testFilePath);
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

// Resolve existing ancestors too, so a missing child cannot escape through a symlink.
function canonicalPath(targetPath, depth = 0) {
  if (depth > 40) throw new Error('目录符号链接层级过深');
  const resolved = path.resolve(targetPath);
  let ancestor = resolved;
  let suffix = '';
  while (true) {
    try { return path.join(fs.realpathSync(ancestor), suffix); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      try {
        if (fs.lstatSync(ancestor).isSymbolicLink()) {
          return path.join(canonicalPath(path.resolve(path.dirname(ancestor), fs.readlinkSync(ancestor)), depth + 1), suffix);
        }
      } catch (linkError) {
        if (linkError.code !== 'ENOENT' && linkError.code !== 'ENOTDIR') throw linkError;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix = path.join(path.basename(ancestor), suffix);
      ancestor = parent;
    }
  }
}

function withinDirectory(target, root) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function getAuthorizationRoots() {
  const roots = [{ path: DATA_DIR, type: 'app_share', name: '默认应用目录' }];
  try {
    if (!isFnosRuntime()) throw new Error('当前为本地运行环境，仅提供默认目录和当前配置');
    const result = await callFnosApi('trim.file.getSharedAccessibleFolders');
    if (!Array.isArray(result?.paths) || !result.paths.every(p => typeof p === 'string' && path.isAbsolute(p))) {
      throw new Error('飞牛授权目录响应格式无效');
    }
    roots.push(...result.paths.map(p => ({ path: p, type: 'share', name: `已授权目录：${path.basename(p)}` })));
    return { roots, authorizationStatus: 'available', warning: null };
  } catch (error) {
    return { roots, authorizationStatus: 'unavailable', warning: `未能同步飞牛授权目录：${error.message}。保留默认目录和原有配置；新目录授权需要 fnOS 1.2.0401 或更高版本。` };
  }
}

// Listing is read-only: no probing files, mkdir, config writes, or implicit migration.
async function getAuthorizedPaths(req) {
  const currentPath = getConfig().storagePath;
  const authorization = await getAuthorizationRoots();
  const candidates = [...authorization.roots, { path: currentPath, type: 'custom', name: '当前配置目录（未确认授权）' }];
  const paths = [];
  let currentReal;
  try { currentReal = canonicalPath(currentPath); } catch { currentReal = path.resolve(currentPath); }
  for (const item of candidates) {
    const mountPath = path.resolve(item.path);
    let realPath;
    try { realPath = canonicalPath(mountPath); } catch { realPath = mountPath; }
    const existing = paths.find(entry => entry.path === realPath);
    if (existing) {
      if (!existing.aliases.includes(mountPath)) existing.aliases.push(mountPath);
      continue;
    }
    const entry = { path: realPath, mountPath: realPath !== mountPath ? mountPath : null, aliases: [mountPath], name: item.name, type: item.type,
      authorization: item.type === 'custom' ? 'unconfirmed' : (item.type === 'share' ? 'shared' : 'default'),
      exists: false, writable: false, reason: null, isCurrent: realPath === currentReal };
    try {
      entry.exists = fs.statSync(realPath).isDirectory();
      if (!entry.exists) throw new Error('指定路径不是目录');
      fs.accessSync(realPath, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
      entry.writable = true;
    } catch (error) { entry.reason = error.code === 'ENOENT' ? '目录不存在' : error.message; }
    if (item.type === 'custom' && authorization.authorizationStatus === 'available') {
      entry.authorization = authorization.roots.some(root => {
        try { return withinDirectory(realPath, canonicalPath(root.path)); } catch { return false; }
      }) ? 'shared' : 'unconfirmed';
    }
    if (item.type === 'custom') entry.name = entry.authorization === 'shared' ? '当前配置目录（位于授权范围内）' : '当前配置目录（未确认授权）';
    paths.push(entry);
  }
  if (isFnosRuntime() && authorization.authorizationStatus === 'available' && req) {
    try {
      const acls = await checkUserPaths(req, paths.map(p => p.path));
      for (const item of paths) {
        const acl = acls.find(acl => acl.path === item.path);
        if (!acl?.readable || !acl?.writable) { item.writable = false; item.reason = '当前飞牛用户没有此目录的读写权限'; }
      }
    } catch (error) {
      for (const item of paths) { item.writable = false; item.reason = `用户权限检查失败：${error.message}`; }
    }
  }
  return { currentPath, paths, authorizationStatus: authorization.authorizationStatus, warning: authorization.warning };
}

async function assertStorageAccess(req, targetPath) {
  assertStorageAdmin(req);
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath.trim()) || targetPath.includes('\0') || targetPath.split(/[\\/]/).includes('..')) {
    throw new Error('请提供不含上级目录跳转的绝对路径');
  }
  const cleanPath = canonicalPath(targetPath.trim());
  const authorization = await getAuthorizationRoots();
  const allowed = authorization.roots.some(root => {
    try { return withinDirectory(cleanPath, canonicalPath(root.path)); } catch { return false; }
  });
  let legacyCurrent = false;
  if (!allowed && authorization.authorizationStatus === 'unavailable') {
    try { legacyCurrent = cleanPath === canonicalPath(getConfig().storagePath); } catch {}
  }
  if (!allowed && !legacyCurrent) {
    const error = new Error(authorization.authorizationStatus === 'unavailable' ? authorization.warning : '目标不在应用已授权目录范围内，请先添加授权');
    error.statusCode = 403;
    throw error;
  }
  if (isFnosRuntime() && authorization.authorizationStatus === 'available') {
    let existingPath = cleanPath;
    while (!fs.existsSync(existingPath) && path.dirname(existingPath) !== existingPath) existingPath = path.dirname(existingPath);
    const acls = await checkUserPaths(req, [existingPath]);
    const acl = acls.find(item => item.path === existingPath);
    if (!acl?.readable || !acl?.writable) {
      const error = new Error('当前飞牛用户没有目标目录的读写权限');
      error.statusCode = 403;
      throw error;
    }
  }
  return cleanPath;
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

  const cleanPath = canonicalPath(newPath.trim());

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
  assertStorageAccess,
  canonicalPath,
  validatePath,
  switchStoragePath,
  scanFilesToCopy,
  scanProfileDbs,
  mergeStorageData,
  startMergeJob,
  getMergeJobStatus
};
