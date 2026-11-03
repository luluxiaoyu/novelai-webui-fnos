const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getConfig, updateConfig } = require('./configManager');
const { queueManager } = require('./queueManager');
const profileManager = require('./profileManager');
const proxyClient = require('./proxyClient');

// ==================== Settings & Auth Status ====================

router.get('/settings', (req, res) => {
  const cfg = getConfig();
  const settingsData = {
    apiToken: cfg.apiToken || '',
    apiBaseUrl: cfg.apiBaseUrl || 'https://image.novelai.net',
    storagePath: cfg.storagePath,
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

router.post('/settings', (req, res) => {
  try {
    const updated = updateConfig(req.body || {});
    res.json({
      success: true,
      message: '设置已成功保存',
      settings: updated
    });
  } catch (err) {
    res.status(500).json({ error: err.message || '保存设置失败' });
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
    const imgUrl = profileManager.saveGeneratedImageFile(target, imgId, buf);

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

// Delete single image from NAS disk and history
router.delete('/profiles/images/:id', (req, res) => {
  try {
    const cfg = getConfig();
    const { id } = req.params;
    const profile = req.query.profile || cfg.activeProfile || 'Default';
    profileManager.deleteHistoryItem(profile, id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// Direct Image File Serving
router.get('/images/:profile/:id', (req, res) => {
  const { profile, id } = req.params;
  const imgPath = profileManager.getImagePath(profile, id);
  if (!imgPath) {
    return res.status(404).send('Image not found');
  }
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(imgPath);
});

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
