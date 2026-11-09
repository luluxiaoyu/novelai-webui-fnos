const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { getConfig, updateConfig, DEFAULT_IMAGE_SUBDIR_PATTERN } = require('./configManager');
const { queueManager } = require('./queueManager');
const profileManager = require('./profileManager');
const proxyClient = require('./proxyClient');
const storageManager = require('./storageManager');
const { canManageStorage, assertStorageAdmin } = require('./fnosApi');

// ==================== Settings & Auth Status ====================

router.get('/settings', (req, res) => {
  const cfg = getConfig();
  const settingsData = {
    apiToken: cfg.apiToken || '',
    apiBaseUrl: cfg.apiBaseUrl || 'https://image.novelai.net',
    storagePath: cfg.storagePath,
    canManageStorage: canManageStorage(req),
    imageSubdirPattern: cfg.imageSubdirPattern || DEFAULT_IMAGE_SUBDIR_PATTERN,
    activeProfile: cfg.activeProfile || 'Default',
    enableEncryption: !!cfg.enableEncryption,
    encryptionKey: cfg.encryptionKey || 'nahida1027',
    maxConcurrency: cfg.maxConcurrency || 1,
    enableLogging: cfg.enableLogging !== false
  };
  res.json({
    success: true,
    ...settingsData,
    settings: settingsData
  });
});

router.post('/settings', async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    if (Object.hasOwn(body, 'storagePath')) {
      if (typeof body.storagePath !== 'string' || !body.storagePath.trim()) {
        return res.status(400).json({ success: false, error: '存储路径不能为空' });
      }
      if (body.storagePath !== getConfig().storagePath) {
        const target = await storageManager.assertStorageAccess(req, body.storagePath);
        storageManager.switchStoragePath(target);
      }
      // The storage operation has already persisted its result; never replay a stale path in the general merge.
      delete body.storagePath;
    }
    const updated = updateConfig(body);
    res.json({
      success: true,
      message: '设置已成功保存',
      settings: updated
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || '保存设置失败' });
  }
});

// GET /api/config and POST /api/config endpoints
router.get('/config', (req, res) => {
  const cfg = getConfig();
  res.json({
    success: true,
    ...cfg,
    config: cfg
  });
});

router.post('/config', async (req, res) => {
  try {
    const data = { ...(req.body?.config || req.body || {}) };
    if (Object.hasOwn(data, 'storagePath')) {
      if (typeof data.storagePath !== 'string' || !data.storagePath.trim()) {
        return res.status(400).json({ success: false, error: '存储路径不能为空' });
      }
      if (data.storagePath !== getConfig().storagePath) {
        const target = await storageManager.assertStorageAccess(req, data.storagePath);
        storageManager.switchStoragePath(target);
      }
      // The storage operation has already persisted its result; never replay a stale path in the general merge.
      delete data.storagePath;
    }
    const updated = updateConfig(data);
    res.json({
      success: true,
      message: '配置已成功保存',
      ...updated,
      config: updated
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message || '保存配置失败' });
  }
});

// Test upstream API base URL latency and connectivity
router.post('/settings/test-url', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ success: false, error: '请提供要测试的 URL' });
  }

  const targetUrl = url.trim().replace(/\/+$/, '');
  const start = Date.now();
  try {
    const cfg = getConfig();
    const token = cfg.apiToken ? (cfg.apiToken.startsWith('Bearer ') ? cfg.apiToken : `Bearer ${cfg.apiToken}`) : '';
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };
    if (token) {
      headers['Authorization'] = token;
    }

    const testEndpoint = `${targetUrl}/ai/generate-image/suggest-tags?model=nai-diffusion-4-full&prompt=test`;
    const resp = await axios.get(testEndpoint, {
      headers,
      timeout: 10000,
      validateStatus: () => true
    });

    const latency = Date.now() - start;
    if (resp.status >= 200 && resp.status < 500) {
      return res.json({
        success: true,
        latency,
        status: resp.status,
        message: `连通正常 (${latency}ms)`
      });
    } else {
      return res.json({
        success: false,
        latency,
        error: `反代服务返回异常状态码: ${resp.status}`
      });
    }
  } catch (err) {
    const latency = Date.now() - start;
    return res.json({
      success: false,
      latency,
      error: `连通失败: ${err.message}`
    });
  }
});

// Compatibility auth endpoints
router.get('/auth/status', (req, res) => {
  res.json({
    siteAuthEnabled: false,
    siteUnlocked: true,
    hasAccessKey: true,
    success: true
  });
});

router.post('/auth/verify-access', (req, res) => {
  res.json({
    success: true,
    siteUnlocked: true,
    allowPaid: true
  });
});

// ==================== Storage Directory Management ====================

// List authorized storage paths & check write status
router.get('/storage/authorized-paths', async (req, res) => {
  try {
    const data = await storageManager.getAuthorizedPaths(req);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || '获取已授权目录列表失败' });
  }
});

// Test whether a candidate path is writable
router.post('/storage/validate-path', async (req, res) => {
  try {
    const { path: targetPath } = req.body || {};
    if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
      return res.status(400).json({ success: false, error: '请提供待验证的存储路径' });
    }
    const target = await storageManager.assertStorageAccess(req, targetPath);
    const result = storageManager.validatePath(target, false);
    if (result.writable) {
      return res.json({
        success: true,
        path: targetPath.trim(),
        exists: result.exists,
        writable: true,
        message: '路径有效且具有读写权限'
      });
    } else {
      return res.json({
        success: false,
        path: targetPath.trim(),
        exists: result.exists,
        writable: false,
        error: result.reason || '指定路径无读写权限'
      });
    }
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message || '路径验证失败' });
  }
});

// Safely switch storage path, ensuring profiles/ exists and flushing DB cache
router.post('/storage/switch', async (req, res) => {
  try {
    const { path: targetPath } = req.body || {};
    if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
      return res.status(400).json({ success: false, error: '请提供目标存储路径' });
    }
    const target = await storageManager.assertStorageAccess(req, targetPath);
    const result = storageManager.switchStoragePath(target);
    res.json({
      success: true,
      message: '存储目录已成功切换并即时生效',
      storagePath: result.storagePath,
      config: result.config
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({ success: false, error: err.message || '切换存储路径失败' });
  }
});

// Start incremental merge between storage directories
router.post('/storage/merge', async (req, res) => {
  try {
    assertStorageAdmin(req);
    const { sourcePath, targetPath, switchOnComplete = true } = req.body || {};
    if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
      return res.status(400).json({ success: false, error: '请提供目标存储路径' });
    }
    const currentCfg = getConfig();
    const src = (sourcePath && typeof sourcePath === 'string' && sourcePath.trim()) 
      ? sourcePath.trim() 
      : currentCfg.storagePath;

    if (storageManager.canonicalPath(src) !== storageManager.canonicalPath(currentCfg.storagePath)) {
      return res.status(400).json({ success: false, error: '合并来源必须是当前生效的存储目录' });
    }
    await storageManager.assertStorageAccess(req, src);
    const target = await storageManager.assertStorageAccess(req, targetPath);
    const startResult = storageManager.startMergeJob(src, target, !!switchOnComplete);
    res.json({
      success: true,
      jobId: startResult.jobId,
      message: startResult.message,
      status: startResult.status
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({ success: false, error: err.message || '启动增量合并失败' });
  }
});

// Query incremental merge progress status
router.get('/storage/merge-status', (req, res) => {
  try {
    const { jobId } = req.query || {};
    const status = storageManager.getMergeJobStatus(jobId);
    res.json({
      success: true,
      ...status
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || '获取合并状态失败' });
  }
});

// Serve raw image from NAS disk for Upscale, Img2Img, or Metadata inspection
router.get('/storage/raw-image', (req, res) => {
  try {
    const rawPath = req.query.path;
    if (!rawPath || typeof rawPath !== 'string' || !rawPath.trim()) {
      return res.status(400).json({ error: '请提供有效的文件路径' });
    }
    const trimmedPath = rawPath.trim();
    if (!path.isAbsolute(trimmedPath) || trimmedPath.includes('\0') || trimmedPath.split(/[\\/]/).includes('..')) {
      return res.status(400).json({ error: '无效的文件路径，必须为无跳转符号的绝对路径' });
    }
    const cleanPath = path.resolve(trimmedPath);

    // Whitelist image extensions
    const ext = path.extname(cleanPath).toLowerCase();
    const ALLOWED_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
    if (!ALLOWED_EXTS.includes(ext)) {
      return res.status(400).json({ error: '仅支持读取图片文件 (.png, .jpg, .jpeg, .webp)' });
    }

    // Security: Disallow sensitive system prefixes
    const forbiddenPrefixes = ['/proc', '/sys', '/dev', '/etc', '/run', '/boot', '/root'];
    if (forbiddenPrefixes.some(prefix => cleanPath === prefix || cleanPath.startsWith(prefix + '/'))) {
      return res.status(403).json({ error: '禁止访问系统敏感目录' });
    }

    // Check existence and read permissions
    let stat;
    try {
      stat = fs.statSync(cleanPath);
    } catch (statErr) {
      if (statErr.code === 'ENOENT') {
        return res.status(404).json({ error: '指定的文件不存在' });
      }
      return res.status(403).json({ error: '无权读取该文件，请确认飞牛系统访问权限' });
    }

    if (!stat.isFile()) {
      return res.status(400).json({ error: '指定的路径不是一个有效文件' });
    }

    try {
      fs.accessSync(cleanPath, fs.constants.R_OK);
    } catch (accErr) {
      return res.status(403).json({ error: '无权读取该文件，请确认飞牛系统访问权限' });
    }

    const mimeMap = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp'
    };
    res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(cleanPath);
  } catch (err) {
    res.status(500).json({ error: err.message || '读取图片失败' });
  }
});

// ==================== Queue Status ====================

router.get('/queue-status', (req, res) => {
  const status = queueManager.getStatus();
  res.json({ success: true, ...status });
});

// ==================== Multi-Profile (Archives) ====================

router.get('/profiles', (req, res) => {
  try {
    const data = profileManager.listProfiles();
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/profiles', (req, res) => {
  try {
    const { name } = req.body || {};
    const created = profileManager.createProfile(name);
    res.json({ success: true, profile: created });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/profiles/switch', (req, res) => {
  try {
    const { profile } = req.body || {};
    const active = profileManager.switchProfile(profile);
    res.json({ success: true, activeProfile: active });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/profiles/rename', (req, res) => {
  try {
    const { oldName, newName } = req.body || {};
    profileManager.renameProfile(oldName, newName);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/profiles/:name', (req, res) => {
  try {
    const { name } = req.params;
    profileManager.deleteProfile(name);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/profiles/data', (req, res) => {
  try {
    const cfg = getConfig();
    const profile = req.query.profile || cfg.activeProfile || 'Default';
    const limitNum = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitNum) ? limitNum : undefined;
    const offsetNum = parseInt(req.query.offset, 10);
    const offset = Number.isFinite(offsetNum) ? offsetNum : undefined;
    const pageNum = parseInt(req.query.page, 10);
    const page = Number.isFinite(pageNum) ? pageNum : undefined;
    const pageSizeNum = parseInt(req.query.pageSize, 10);
    const pageSize = Number.isFinite(pageSizeNum) ? pageSizeNum : undefined;
    const data = profileManager.getProfileData(profile, { limit, offset, page, pageSize });
    res.json({ success: true, profile, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/profiles/data', (req, res) => {
  try {
    const cfg = getConfig();
    const { profile, data } = req.body || {};
    const target = profile || cfg.activeProfile || 'Default';
    profileManager.saveProfileData(target, data || {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dedicated history query and pagination endpoint
router.get('/profiles/history', (req, res) => {
  try {
    const cfg = getConfig();
    const profile = req.query.profile || cfg.activeProfile || 'Default';
    const pageNum = parseInt(req.query.page, 10);
    const page = Number.isFinite(pageNum) && pageNum >= 1 ? pageNum : 1;
    const rawPageSize = parseInt(req.query.pageSize || req.query.limit, 10);
    const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 ? rawPageSize : 50;
    const offsetNum = parseInt(req.query.offset, 10);
    const offset = Number.isFinite(offsetNum) && offsetNum >= 0 ? offsetNum : undefined;
    const search = req.query.search || '';
    const sort = req.query.sort || 'desc';
    const isUpscaled = req.query.isUpscaled !== undefined ? (req.query.isUpscaled === 'true' || req.query.isUpscaled === '1') : undefined;
    
    let timeFilter;
    if (req.query.startTime || req.query.endTime) {
      const sNum = parseInt(req.query.startTime, 10);
      const eNum = parseInt(req.query.endTime, 10);
      timeFilter = {
        start: Number.isFinite(sNum) ? sNum : undefined,
        end: Number.isFinite(eNum) ? eNum : undefined
      };
    }

    const result = profileManager.getHistory(profile, { page, pageSize, offset, search, sort, isUpscaled, timeFilter });
    res.json({ success: true, profile, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resolve absolute NAS disk path for an image
router.get('/profiles/images/disk-path', (req, res) => {
  try {
    const profile = req.query.profile || getConfig().activeProfile || 'Default';
    const subpathOrId = req.query.url || req.query.id;
    if (!subpathOrId) {
      return res.status(400).json({ success: false, error: '缺少图片标识或路径' });
    }
    const diskPath = profileManager.getImagePath(profile, subpathOrId);
    if (!diskPath) {
      return res.status(404).json({ success: false, error: '未在磁盘中找到该图片文件' });
    }
    res.json({
      success: true,
      path: diskPath
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || '获取图片磁盘路径失败' });
  }
});

// Save single generated image to NAS disk and history
router.post('/profiles/images/save', (req, res) => {
  try {
    const cfg = getConfig();
    const { profile, item } = req.body || {};
    const target = profile || cfg.activeProfile || 'Default';
    const rawImage = item ? (item.image || item.url) : null;
    if (!item || !rawImage) {
      return res.status(400).json({ error: 'Missing image data' });
    }

    const imgId = item.id || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    let rawBase64 = rawImage;
    if (typeof rawBase64 === 'string' && rawBase64.includes(',')) {
      rawBase64 = rawBase64.split(',')[1];
    }
    const buf = Buffer.from(rawBase64, 'base64');
    const imgUrl = profileManager.saveGeneratedImageFile(target, imgId, buf, item);

    // Record directly in SQLite history
    const historyItem = {
      ...item,
      id: imgId,
      url: imgUrl,
      prompt: item.prompt || item.params?.prompt || '',
      negative_prompt: item.negative_prompt || item.params?.negative_prompt || item.params?.uc || '',
      model: item.model || item.params?.model || '',
      params: item.params || {},
      timestamp: item.timestamp || Date.now(),
      isUpscaled: Boolean(item.isUpscaled || item.params?.is_upscaled)
    };

    profileManager.addHistoryItem(target, historyItem);

    res.json({ success: true, url: imgUrl, item: historyItem });
  } catch (err) {
    console.error('[Routes] Error saving image to disk:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete single image from NAS disk and history (supports flat ID and nested subpath)
const deleteImageHandler = (req, res) => {
  try {
    const cfg = getConfig();
    const id = req.params[0] || req.params.id;
    const profile = req.query.profile || cfg.activeProfile || 'Default';
    profileManager.deleteHistoryItem(profile, id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

router.delete('/profiles/images/*', deleteImageHandler);
router.delete('/profiles/images/:id', deleteImageHandler);

// Batch delete images from NAS disk and history
router.post('/profiles/images/delete-batch', (req, res) => {
  try {
    const cfg = getConfig();
    const { profile, ids } = req.body || {};
    const target = profile || cfg.activeProfile || 'Default';
    profileManager.batchDeleteHistoryItems(target, ids || []);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Direct Image File Serving (supports wildcard/nested subpaths & flat paths)
const serveImageHandler = (req, res) => {
  const { profile } = req.params;
  const subpath = req.params[0] || req.params.id;
  const imgPath = profileManager.getImagePath(profile, subpath);
  if (!imgPath) {
    return res.status(404).send('Image not found');
  }
  const isDownload = req.query.download === '1' || req.query.download === 'true';
  if (isDownload) {
    const filename = req.query.filename || path.basename(imgPath);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  }
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(imgPath);
};

router.get('/images/:profile/*', serveImageHandler);
router.get('/images/:profile/:id', serveImageHandler);

// ==================== Upstream Proxy Routes ====================

router.get('/user/subscription', (req, res) => proxyClient.forwardRequest(req, res, '/user/subscription'));
router.get('/user/data', (req, res) => proxyClient.forwardRequest(req, res, '/user/data'));
router.get('/user/information', (req, res) => proxyClient.forwardRequest(req, res, '/user/information'));

router.get('/ai/generate-image/suggest-tags', (req, res) => proxyClient.forwardRequest(req, res, '/ai/generate-image/suggest-tags'));
router.get('/generate-image/suggest-tags', (req, res) => proxyClient.forwardRequest(req, res, '/ai/generate-image/suggest-tags'));

router.post('/ai/generate-image', proxyClient.generateImage);
router.post('/generate-image', proxyClient.generateImage);

router.post('/ai/generate-image-stream', proxyClient.generateImageStream);
router.post('/generate-image-stream', proxyClient.generateImageStream);

router.post('/ai/upscale', proxyClient.upscaleImage);
router.post('/upscale', proxyClient.upscaleImage);

module.exports = router;
