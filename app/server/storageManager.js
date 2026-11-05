const fs = require('fs');
const path = require('path');
const { getConfig, updateConfig, APP_DEST, PKG_VAR } = require('./configManager');
const { closeAllDbs } = require('./profileDb');

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

  // 1. TRIM_DATA_SHARE_PATHS env var (may contain colon/semicolon/comma/newline separated paths or single path with spaces)
  if (process.env.TRIM_DATA_SHARE_PATHS) {
    const envVal = process.env.TRIM_DATA_SHARE_PATHS.trim();
    if (fs.existsSync(envVal)) {
      candidates.push({ rawPath: envVal, source: 'env_share', shareName: path.basename(envVal) });
    } else {
      const envParts = envVal.split(/[:;,\n]/).map(s => s.trim()).filter(Boolean);
      for (const p of envParts) {
        candidates.push({ rawPath: p, source: 'env_share', shareName: path.basename(p) });
      }
    }
  }

  // 2. NOVELAI_SHARE_DIR env var
  if (process.env.NOVELAI_SHARE_DIR) {
    candidates.push({
      rawPath: process.env.NOVELAI_SHARE_DIR,
      source: 'env_novelai',
      shareName: path.basename(process.env.NOVELAI_SHARE_DIR)
    });
  }

  // 3. Mount shares directories: /var/apps/novelai/shares and ${TRIM_APPDEST}/shares
  const sharesDirs = [
    '/var/apps/novelai/shares',
    path.join(APP_DEST, 'shares')
  ];

  for (const sharesDir of sharesDirs) {
    try {
      if (fs.existsSync(sharesDir) && fs.statSync(sharesDir).isDirectory()) {
        const entries = fs.readdirSync(sharesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = path.join(sharesDir, entry.name);
          candidates.push({ rawPath: fullPath, source: 'shares_dir', shareName: entry.name });
        }
      }
    } catch (err) {
      console.warn(`[StorageManager] Failed to read shares dir ${sharesDir}:`, err.message);
    }
  }

  // 4. Default package var data dir (${TRIM_PKGVAR}/data)
  const defaultVarData = path.join(PKG_VAR, 'data');
  candidates.push({ rawPath: defaultVarData, source: 'default_data', shareName: 'data' });

  // 5. Current config storage path
  if (currentCfg.storagePath) {
    candidates.push({
      rawPath: currentCfg.storagePath,
      source: 'current_config',
      shareName: path.basename(currentCfg.storagePath)
    });
  }

  // Deduplicate entries by canonical real path
  const seenRealPaths = new Set();
  const results = [];

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

    const writeCheck = testPathWritable(realPath);

    // Format friendly display name & category
    let friendlyName = '';
    let itemType = 'custom';
    const baseName = item.shareName || path.basename(realPath);

    if (baseName === 'NovelAI-WebUI' || baseName === 'NovelAI' || realPath.endsWith('/shares/NovelAI-WebUI')) {
      friendlyName = `📦 默认应用文件 (应用文件/NovelAI-WebUI)`;
      itemType = 'app_share';
    } else if (item.source === 'default_data' || realPath.includes('/var/data') || realPath.includes('@appdata')) {
      friendlyName = `💾 应用私有数据包 (@appdata/novelai/data)`;
      itemType = 'appdata';
    } else if (item.source === 'shares_dir' || item.source === 'env_share' || realPath.includes('/shares/')) {
      friendlyName = `📁 共享文件夹: ${baseName} (${realPath})`;
      itemType = 'share';
    } else {
      friendlyName = `📂 自定义目录: ${baseName} (${realPath})`;
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

  // Ensure current path is marked isCurrent if not already
  const hasCurrent = results.some(r => r.isCurrent);
  if (!hasCurrent && results.length > 0 && currentResolved) {
    const match = results.find(r => r.path === currentResolved || r.mountPath === currentResolved);
    if (match) {
      match.isCurrent = true;
    }
  }

  const activeItem = results.find(r => r.isCurrent);
  const activePath = activeItem ? activeItem.path : (currentResolved || currentCfg.storagePath || (results[0] ? results[0].path : ''));

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
    } catch {}
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

module.exports = {
  testPathWritable,
  getAuthorizedPaths,
  validatePath,
  switchStoragePath
};
