const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');

const TEST_DIR = path.join(os.tmpdir(), `novelai_subdir_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
process.env.NOVELAI_SHARE_DIR = TEST_DIR;

const configManager = require('../configManager');
const profileDb = require('../profileDb');
const profileManager = require('../profileManager');
const routes = require('../routes');

let app;

function invoke(method, urlPath, body = null) {
  return new Promise((resolve) => {
    let qIdx = urlPath.indexOf('?');
    let pathOnly = qIdx !== -1 ? urlPath.slice(0, qIdx) : urlPath;
    let queryStr = qIdx !== -1 ? urlPath.slice(qIdx + 1) : '';
    let query = {};
    if (queryStr) {
      const sp = new URLSearchParams(queryStr);
      for (const [k, v] of sp.entries()) query[k] = v;
    }

    let statusCode = 200;
    const resHeaders = {};

    const req = {
      method: method.toUpperCase(),
      url: urlPath,
      originalUrl: urlPath,
      path: pathOnly,
      query,
      body: body || {},
      headers: {
        'content-type': 'application/json'
      }
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      setHeader(k, v) {
        resHeaders[k.toLowerCase()] = v;
      },
      json(data) {
        resolve({ status: statusCode, headers: resHeaders, data });
      },
      send(data) {
        resolve({ status: statusCode, headers: resHeaders, data });
      },
      sendFile(filePath) {
        resolve({ status: statusCode, headers: resHeaders, filePath });
      }
    };

    app(req, res, () => {
      resolve({ status: 404, headers: resHeaders, data: { error: 'Not found' } });
    });
  });
}

describe('Configurable Image Subfolder Pattern Tests', () => {
  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    configManager.updateConfig({
      storagePath: TEST_DIR,
      activeProfile: 'Default',
      imageSubdirPattern: '/{year}/{month}/'
    });

    app = express();
    app.use(express.json());
    app.use('/api', routes);
  });

  after(() => {
    profileDb.closeAllDbs();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  test('1. Pattern normalization & validation rules', () => {
    const { normalizeImageSubdirPattern, DEFAULT_IMAGE_SUBDIR_PATTERN } = configManager;

    assert.equal(DEFAULT_IMAGE_SUBDIR_PATTERN, '/{year}/{month}/');

    // Empty / whitespace / undefined / null fallback to default
    assert.equal(normalizeImageSubdirPattern(''), '/{year}/{month}/');
    assert.equal(normalizeImageSubdirPattern('   '), '/{year}/{month}/');
    assert.equal(normalizeImageSubdirPattern(null), '/{year}/{month}/');
    assert.equal(normalizeImageSubdirPattern(undefined), '/{year}/{month}/');

    // Backslash conversion
    assert.equal(normalizeImageSubdirPattern('\\{year}\\{month}\\'), '/{year}/{month}/');
    assert.equal(normalizeImageSubdirPattern('{year}\\{month}'), '/{year}/{month}/');

    // Directory traversal prevention: '..' is stripped
    assert.equal(normalizeImageSubdirPattern('/../{year}/{month}/'), '/{year}/{month}/');
    assert.equal(normalizeImageSubdirPattern('/foo/../../bar/'), '/foo/bar/');

    // Unsafe characters stripped
    assert.equal(normalizeImageSubdirPattern('/{year}:*{month}?<>|/'), '/{year}{month}/');

    // Collapse consecutive slashes and normalize leading/trailing
    assert.equal(normalizeImageSubdirPattern('///{year}////{month}///'), '/{year}/{month}/');
    assert.equal(normalizeImageSubdirPattern('{year}/{month}'), '/{year}/{month}/');

    // Only slashes fallback to default
    assert.equal(normalizeImageSubdirPattern('////'), '/{year}/{month}/');
  });

  test('2. Variable interpolation in resolveImageSubdir', () => {
    // Known timestamp: 2026-11-04 12:00:00 local time
    const fixedDate = new Date(2026, 10, 4, 12, 0, 0); // month is 0-indexed: 10 = Nov
    const ts = fixedDate.getTime();

    // Default pattern /{year}/{month}/
    const sub1 = profileManager.resolveImageSubdir('/{year}/{month}/', {
      timestamp: ts,
      model: 'nai-diffusion-4-full',
      profile: 'TestProfile'
    });
    assert.equal(sub1, '2026/11');

    // Full date and day pattern: /{year}/{month}/{day}/
    const sub2 = profileManager.resolveImageSubdir('/{year}/{month}/{day}/', {
      timestamp: ts,
      model: 'nai-diffusion-4-full',
      profile: 'TestProfile'
    });
    assert.equal(sub2, '2026/11/04');

    // Date, model, profile pattern: /{profile}/{model}/{date}/
    const sub3 = profileManager.resolveImageSubdir('/{profile}/{model}/{date}/', {
      timestamp: ts,
      model: 'nai-diffusion-4-full',
      profile: 'TestProfile'
    });
    assert.equal(sub3, 'TestProfile/nai-diffusion-4-full/2026-11-04');

    // Unsafe model characters sanitized
    const sub4 = profileManager.resolveImageSubdir('/{model}/', {
      timestamp: ts,
      model: 'nai:diffusion/v4?full',
      profile: 'TestProfile'
    });
    assert.equal(sub4, 'nai_diffusion_v4_full');
  });

  test('3. Custom pattern recursive directory creation and image saving', () => {
    const profile = 'SubdirProfile';
    profileManager.createProfile(profile);

    // Set custom pattern: /{year}/{month}/{day}/
    configManager.updateConfig({ imageSubdirPattern: '/{year}/{month}/{day}/' });

    const fixedDate = new Date(2026, 10, 4, 12, 0, 0);
    const ts = fixedDate.getTime();
    const fakeBuffer = Buffer.from('image bytes for 2026-11-04');

    const url = profileManager.saveGeneratedImageFile(profile, 'img-daily-1', fakeBuffer, {
      timestamp: ts,
      model: 'nai-diffusion-4-full'
    });

    assert.equal(url, `/api/images/${profile}/2026/11/04/img-daily-1.png`);

    // Verify recursive directory and file created on disk
    const profileDir = profileManager.getProfileDir(profile);
    const expectedDiskPath = path.join(profileDir, '2026', '11', '04', 'img-daily-1.png');
    assert.ok(fs.existsSync(expectedDiskPath), 'File must exist at nested date directory');
    assert.equal(fs.readFileSync(expectedDiskPath, 'utf8'), 'image bytes for 2026-11-04');
  });

  test('4. Image serving endpoint supports nested subpaths and legacy paths', async () => {
    const profile = 'SubdirProfile';

    // 1. Nested subpath request
    const resNested = await invoke('GET', `/api/images/${profile}/2026/11/04/img-daily-1.png`);
    assert.equal(resNested.status, 200);
    assert.ok(resNested.filePath.endsWith(path.join('2026', '11', '04', 'img-daily-1.png')));

    // 2. Direct flat lookup (by id fallback)
    const resFlat = await invoke('GET', `/api/images/${profile}/img-daily-1.png`);
    assert.equal(resFlat.status, 200);
    assert.ok(resFlat.filePath.endsWith('img-daily-1.png'));

    // 3. Legacy path under images/
    const profileDir = profileManager.getProfileDir(profile);
    const legacyDir = path.join(profileDir, 'images');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'legacy-pic.png'), 'legacy bytes');

    const resLegacy = await invoke('GET', `/api/images/${profile}/legacy-pic.png`);
    assert.equal(resLegacy.status, 200);
    assert.ok(resLegacy.filePath.endsWith(path.join('images', 'legacy-pic.png')));

    // 4. Path traversal attempt rejected with 404
    const resTraversal1 = await invoke('GET', `/api/images/${profile}/../../config.json`);
    assert.equal(resTraversal1.status, 404);

    const resTraversal2 = await invoke('GET', `/api/images/${profile}/%2e%2e%2f%2e%2e%2fconfig.json`);
    assert.equal(resTraversal2.status, 404);
  });

  test('5. Single deletion removes image in nested subdirectory and DB record', () => {
    const profile = 'DeleteSubdirProfile';
    profileManager.createProfile(profile);

    configManager.updateConfig({ imageSubdirPattern: '/{year}/{month}/' });
    const fixedDate = new Date(2026, 10, 4, 12, 0, 0);
    const ts = fixedDate.getTime();
    const fakeBuffer = Buffer.from('delete test content');

    const url = profileManager.saveGeneratedImageFile(profile, 'del-item-1', fakeBuffer, { timestamp: ts });
    profileManager.addHistoryItem(profile, {
      id: 'del-item-1',
      url,
      timestamp: ts,
      params: { prompt: 'delete me' }
    });

    const diskPath = profileManager.getImagePath(profile, 'del-item-1');
    assert.ok(diskPath && fs.existsSync(diskPath), 'Image must exist before deletion');

    // Delete by ID
    profileManager.deleteHistoryItem(profile, 'del-item-1');
    assert.equal(fs.existsSync(diskPath), false, 'Image must be deleted from nested subdir on disk');
    assert.equal(profileManager.getHistory(profile).total, 0, 'DB record must be removed');
  });

  test('6. Batch deletion cleans up multiple images across nested subdirectories', () => {
    const profile = 'BatchSubdirProfile';
    profileManager.createProfile(profile);

    configManager.updateConfig({ imageSubdirPattern: '/{year}/{month}/' });

    const diskPaths = [];
    for (let i = 1; i <= 5; i++) {
      const fixedDate = new Date(2026, i, 1, 12, 0, 0); // different months
      const ts = fixedDate.getTime();
      const fakeBuffer = Buffer.from(`batch item ${i}`);
      const id = `batch-item-${i}`;
      const url = profileManager.saveGeneratedImageFile(profile, id, fakeBuffer, { timestamp: ts });
      profileManager.addHistoryItem(profile, {
        id,
        url,
        timestamp: ts,
        params: { prompt: `batch ${i}` }
      });
      const dp = profileManager.getImagePath(profile, id);
      assert.ok(dp && fs.existsSync(dp));
      diskPaths.push(dp);
    }

    assert.equal(profileManager.getHistory(profile).total, 5);

    // Batch delete 3 items
    profileManager.batchDeleteHistoryItems(profile, ['batch-item-1', 'batch-item-2', 'batch-item-3']);
    assert.equal(profileManager.getHistory(profile).total, 2);

    assert.equal(fs.existsSync(diskPaths[0]), false);
    assert.equal(fs.existsSync(diskPaths[1]), false);
    assert.equal(fs.existsSync(diskPaths[2]), false);
    assert.equal(fs.existsSync(diskPaths[3]), true);
    assert.equal(fs.existsSync(diskPaths[4]), true);
  });

  test('7. API /api/config and /api/settings exposure and validation', async () => {
    // GET /api/config
    const resGetConfig = await invoke('GET', '/api/config');
    assert.equal(resGetConfig.status, 200);
    assert.equal(resGetConfig.data.success, true);
    assert.ok(resGetConfig.data.imageSubdirPattern);

    // POST /api/config with custom pattern
    const resPostConfig = await invoke('POST', '/api/config', {
      imageSubdirPattern: '\\{model}\\{year}-{month}\\'
    });
    assert.equal(resPostConfig.status, 200);
    assert.equal(resPostConfig.data.success, true);
    // Backslashes auto-converted to slashes and normalized
    assert.equal(resPostConfig.data.config.imageSubdirPattern, '/{model}/{year}-{month}/');

    // GET /api/settings exposes updated pattern
    const resGetSettings = await invoke('GET', '/api/settings');
    assert.equal(resGetSettings.status, 200);
    assert.equal(resGetSettings.data.settings.imageSubdirPattern, '/{model}/{year}-{month}/');

    // POST /api/settings updates pattern with normalization
    const resPostSettings = await invoke('POST', '/api/settings', {
      imageSubdirPattern: '   '
    });
    assert.equal(resPostSettings.status, 200);
    // Whitespace resets to default
    assert.equal(resPostSettings.data.settings.imageSubdirPattern, '/{year}/{month}/');
  });

  test('8. Sensitive database and system files are strictly blocked from image serving', async () => {
    const profile = 'SecurityTestProfile';
    profileManager.createProfile(profile);

    const profileDir = profileManager.getProfileDir(profile);
    // profile.db exists in profileDir
    assert.ok(fs.existsSync(path.join(profileDir, 'profile.db')));

    // 1. Direct getImagePath queries for sensitive files must return null
    assert.equal(profileManager.getImagePath(profile, 'profile.db'), null);
    assert.equal(profileManager.getImagePath(profile, 'profile.db-wal'), null);
    assert.equal(profileManager.getImagePath(profile, 'profile.db-shm'), null);
    assert.equal(profileManager.getImagePath(profile, 'data.json'), null);
    assert.equal(profileManager.getImagePath(profile, '.'), null);

    // 2. HTTP GET /api/images/:profile/profile.db must return 404
    const resDb = await invoke('GET', `/api/images/${profile}/profile.db`);
    assert.equal(resDb.status, 404);

    const resWal = await invoke('GET', `/api/images/${profile}/profile.db-wal`);
    assert.equal(resWal.status, 404);

    const resJson = await invoke('GET', `/api/images/${profile}/data.json`);
    assert.equal(resJson.status, 404);

    // 3. Trying to access parent directory with .png appended must return null
    assert.equal(profileManager.getImagePath(profile, '.'), null);
  });

  test('9. Full gateway/host URLs in history are correctly parsed and deleted on disk', () => {
    const profile = 'FullUrlProfile';
    profileManager.createProfile(profile);

    configManager.updateConfig({ imageSubdirPattern: '/{year}/{month}/' });
    const fixedDate = new Date(2026, 10, 4, 12, 0, 0);
    const ts = fixedDate.getTime();
    const fakeBuffer = Buffer.from('gateway url test bytes');

    // Save image to disk
    const savedUrl = profileManager.saveGeneratedImageFile(profile, 'gw-img-1', fakeBuffer, { timestamp: ts });
    assert.ok(savedUrl.includes('/2026/11/gw-img-1.png'));

    // Simulate frontend saving absolute gateway URL in history
    const fullGatewayUrl = `https://nas.local:3000/proxy/apps/novelai${savedUrl}`;
    profileManager.addHistoryItem(profile, {
      id: 'gw-img-1',
      url: fullGatewayUrl,
      timestamp: ts,
      params: { prompt: 'gateway test' }
    });

    const diskPath = profileManager.getImagePath(profile, 'gw-img-1');
    assert.ok(diskPath && fs.existsSync(diskPath));

    // Deletion must resolve and unlink the file on disk even with full URL
    profileManager.deleteHistoryItem(profile, 'gw-img-1');
    assert.equal(fs.existsSync(diskPath), false, 'Disk file must be deleted despite gateway prefix in URL');
    assert.equal(profileManager.getHistory(profile).total, 0);
  });

  test('10. Subpath DELETE route unlinks file and removes DB record', async () => {
    const profile = 'SubpathDeleteProfile';
    profileManager.createProfile(profile);

    configManager.updateConfig({ imageSubdirPattern: '/{year}/{month}/' });
    const fixedDate = new Date(2026, 10, 4, 12, 0, 0);
    const ts = fixedDate.getTime();
    const fakeBuffer = Buffer.from('subpath delete test bytes');

    profileManager.saveGeneratedImageFile(profile, 'sub-del-1', fakeBuffer, { timestamp: ts });
    profileManager.addHistoryItem(profile, {
      id: 'sub-del-1',
      url: `/api/images/${profile}/2026/11/sub-del-1.png`,
      timestamp: ts,
      params: { prompt: 'subpath delete' }
    });

    const diskPath = profileManager.getImagePath(profile, '2026/11/sub-del-1.png');
    assert.ok(diskPath && fs.existsSync(diskPath));

    // HTTP DELETE with subpath in route
    const resDel = await invoke('DELETE', `/api/profiles/images/2026/11/sub-del-1.png?profile=${profile}`);
    assert.equal(resDel.status, 200);
    assert.equal(resDel.data.success, true);
    assert.equal(fs.existsSync(diskPath), false);
    assert.equal(profileManager.getHistory(profile).total, 0);
  });

  test('11. Edge-case and degenerate patterns normalize safely to default', () => {
    const { normalizeImageSubdirPattern } = configManager;
    assert.equal(normalizeImageSubdirPattern('/./././'), '/{year}/{month}/');
    assert.equal(normalizeImageSubdirPattern('/.../..../'), '/{year}/{month}/');
    assert.equal(normalizeImageSubdirPattern('/../'), '/{year}/{month}/');
    assert.equal(normalizeImageSubdirPattern('.'), '/{year}/{month}/');
  });
});
