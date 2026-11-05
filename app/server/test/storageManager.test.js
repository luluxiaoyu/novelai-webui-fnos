const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_BASE = path.join(os.tmpdir(), `novelai_storage_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
fs.mkdirSync(TEST_BASE, { recursive: true });

// Setup test environment
const TEST_APP_DEST = path.join(TEST_BASE, 'appdest');
const TEST_PKG_VAR = path.join(TEST_BASE, 'pkgvar');
const TEST_SHARES = path.join(TEST_APP_DEST, 'shares');
const TEST_REAL_SHARE = path.join(TEST_BASE, 'real_volumes/shares/my_photos');

fs.mkdirSync(TEST_SHARES, { recursive: true });
fs.mkdirSync(TEST_REAL_SHARE, { recursive: true });
fs.mkdirSync(path.join(TEST_PKG_VAR, 'data'), { recursive: true });

// Create symlink in shares pointing to real share
try {
  fs.symlinkSync(TEST_REAL_SHARE, path.join(TEST_SHARES, 'my_photos'), 'dir');
} catch (e) {
  // If symlink creation fails on some filesystems, create regular dir
  fs.mkdirSync(path.join(TEST_SHARES, 'my_photos'), { recursive: true });
}

// Set environment variables
process.env.TRIM_APPDEST = TEST_APP_DEST;
process.env.TRIM_PKGVAR = TEST_PKG_VAR;
process.env.NOVELAI_SHARE_DIR = path.join(TEST_BASE, 'novelai_share');
fs.mkdirSync(process.env.NOVELAI_SHARE_DIR, { recursive: true });

const configManager = require('../configManager');
configManager.updateConfig({ storagePath: process.env.NOVELAI_SHARE_DIR, activeProfile: 'Default' });

const profileDb = require('../profileDb');
const storageManager = require('../storageManager');
const routes = require('../routes');

describe('StorageManager & Authorized Paths Tests', () => {

  after(() => {
    profileDb.closeAllDbs();
    try {
      fs.rmSync(TEST_BASE, { recursive: true, force: true });
    } catch {}
  });

  test('1. testPathWritable accurately validates writable and non-writable paths', () => {
    // Empty path
    const emptyRes = storageManager.testPathWritable('');
    assert.equal(emptyRes.writable, false);
    assert.equal(emptyRes.exists, false);

    // Non-existent path
    const nonExistent = storageManager.testPathWritable(path.join(TEST_BASE, 'does_not_exist'));
    assert.equal(nonExistent.writable, false);
    assert.equal(nonExistent.exists, false);

    // Regular writable directory
    const writableDir = path.join(TEST_BASE, 'writable_dir');
    fs.mkdirSync(writableDir, { recursive: true });
    const okRes = storageManager.testPathWritable(writableDir);
    assert.equal(okRes.writable, true);
    assert.equal(okRes.exists, true);
    assert.equal(okRes.reason, null);

    // File instead of directory
    const filePath = path.join(TEST_BASE, 'some_file.txt');
    fs.writeFileSync(filePath, 'hello');
    const fileRes = storageManager.testPathWritable(filePath);
    assert.equal(fileRes.writable, false);
    assert.equal(fileRes.exists, true);
    assert.match(fileRes.reason, /不是一个目录/);
  });

  test('2. getAuthorizedPaths discovers env vars, shares directory, and default data dir', () => {
    const extraShareDir = path.join(TEST_BASE, 'extra_share');
    fs.mkdirSync(extraShareDir, { recursive: true });
    process.env.TRIM_DATA_SHARE_PATHS = `${extraShareDir}:/non_existent_share`;

    const res = storageManager.getAuthorizedPaths();
    assert.ok(res.paths && Array.isArray(res.paths));
    assert.ok(res.paths.length >= 3);

    const pathsList = res.paths.map(p => p.path);
    // Should include extraShareDir
    assert.ok(pathsList.includes(fs.realpathSync(extraShareDir)));
    // Should include NOVELAI_SHARE_DIR
    assert.ok(pathsList.includes(fs.realpathSync(process.env.NOVELAI_SHARE_DIR)));
    // Should include shares link target
    assert.ok(pathsList.includes(fs.realpathSync(TEST_REAL_SHARE)));

    // Verify current path is marked
    const currentEntry = res.paths.find(p => p.isCurrent);
    assert.ok(currentEntry, 'At least one entry should have isCurrent: true');

    // Friendly names verification
    const shareEntry = res.paths.find(p => p.path === fs.realpathSync(TEST_REAL_SHARE));
    assert.ok(shareEntry);
    assert.match(shareEntry.name, /共享文件夹/);
  });

  test('3. validatePath validates paths and supports createIfMissing', () => {
    const freshDir = path.join(TEST_BASE, 'auto_created_dir');
    assert.equal(fs.existsSync(freshDir), false);

    // Without createIfMissing -> should report non-existent
    const check1 = storageManager.validatePath(freshDir, false);
    assert.equal(check1.exists, false);
    assert.equal(check1.writable, false);

    // With createIfMissing -> should create and report writable
    const check2 = storageManager.validatePath(freshDir, true);
    assert.equal(check2.exists, true);
    assert.equal(check2.writable, true);
    assert.equal(fs.existsSync(freshDir), true);
  });

  test('4. switchStoragePath ensures profiles/ exists, closes DBs, and updates config', () => {
    const targetDir = path.join(TEST_BASE, 'new_storage_dir');
    fs.mkdirSync(targetDir, { recursive: true });

    // Open a DB in current path first
    const curDb = profileDb.getDb(path.join(process.env.NOVELAI_SHARE_DIR, 'profiles/Default'), 'Default');
    assert.ok(curDb);

    const switchResult = storageManager.switchStoragePath(targetDir);
    assert.equal(switchResult.success, true);
    assert.equal(switchResult.storagePath, targetDir);

    // profiles/ directory must have been created
    const profilesDir = path.join(targetDir, 'profiles');
    assert.ok(fs.existsSync(profilesDir));

    // Config must reflect the new path
    const updatedCfg = configManager.getConfig();
    assert.equal(updatedCfg.storagePath, targetDir);

    // Opening DB now will open in targetDir/profiles/Default
    const newDb = profileDb.getDb(path.join(targetDir, 'profiles/Default'), 'Default');
    assert.ok(newDb);
  });

  test('5. switchStoragePath throws error for non-writable or invalid paths', () => {
    assert.throws(() => {
      storageManager.switchStoragePath('');
    }, /不能为空/);

    assert.throws(() => {
      storageManager.switchStoragePath(null);
    }, /不能为空/);
  });
});

describe('Storage API Express HTTP Endpoints Tests', () => {

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
        headers: { 'content-type': 'application/json' }
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
        }
      };

      routes(req, res, (err) => {
        if (err) resolve({ status: 500, error: err });
        else resolve({ status: 404 });
      });
    });
  }

  test('6. GET /storage/authorized-paths returns authorized paths and status', async () => {
    const res = await invoke('GET', '/storage/authorized-paths');
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.ok(Array.isArray(res.data.paths));
    assert.ok(res.data.currentPath);
  });

  test('7. POST /storage/validate-path validates writable and missing paths', async () => {
    // Missing path -> 400
    const errRes = await invoke('POST', '/storage/validate-path', {});
    assert.equal(errRes.status, 400);
    assert.equal(errRes.data.success, false);

    // Valid path
    const validDir = path.join(TEST_BASE, 'api_validate_test');
    fs.mkdirSync(validDir, { recursive: true });
    const okRes = await invoke('POST', '/storage/validate-path', { path: validDir });
    assert.equal(okRes.status, 200);
    assert.equal(okRes.data.success, true);
    assert.equal(okRes.data.writable, true);

    // Non-existent path
    const noExistRes = await invoke('POST', '/storage/validate-path', { path: path.join(TEST_BASE, 'no_such_dir_1234') });
    assert.equal(noExistRes.status, 200);
    assert.equal(noExistRes.data.success, false);
    assert.equal(noExistRes.data.writable, false);
  });

  test('8. POST /storage/switch switches active path and updates config', async () => {
    const newStorage = path.join(TEST_BASE, 'api_switch_target');
    fs.mkdirSync(newStorage, { recursive: true });

    const res = await invoke('POST', '/storage/switch', { path: newStorage });
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.equal(res.data.storagePath, newStorage);

    assert.ok(fs.existsSync(path.join(newStorage, 'profiles')));
    assert.equal(configManager.getConfig().storagePath, newStorage);
  });

  test('9. POST /storage/switch rejects empty or invalid path with 400', async () => {
    const res = await invoke('POST', '/storage/switch', { path: '' });
    assert.equal(res.status, 400);
    assert.equal(res.data.success, false);
  });

  test('10. POST /settings with storagePath safely delegates to switchStoragePath', async () => {
    const settingsTarget = path.join(TEST_BASE, 'api_settings_target');
    fs.mkdirSync(settingsTarget, { recursive: true });

    const res = await invoke('POST', '/settings', {
      storagePath: settingsTarget,
      apiToken: 'test-token-123'
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.ok(fs.existsSync(path.join(settingsTarget, 'profiles')));
    assert.ok(fs.existsSync(path.join(settingsTarget, 'logs')));
    assert.equal(configManager.getConfig().storagePath, settingsTarget);
  });

  test('11. POST /config with storagePath safely delegates to switchStoragePath', async () => {
    const configTarget = path.join(TEST_BASE, 'api_config_target');
    fs.mkdirSync(configTarget, { recursive: true });

    const res = await invoke('POST', '/config', {
      config: { storagePath: configTarget }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.ok(fs.existsSync(path.join(configTarget, 'profiles')));
    assert.equal(configManager.getConfig().storagePath, configTarget);
  });

  test('12. switchStoragePath through a symlink resolves to real path and creates profiles and logs', () => {
    const realDir = path.join(TEST_BASE, 'symlink_real_target');
    fs.mkdirSync(realDir, { recursive: true });
    const symlinkPath = path.join(TEST_BASE, 'symlink_link_target');
    try {
      fs.symlinkSync(realDir, symlinkPath, 'dir');
    } catch {}

    if (fs.existsSync(symlinkPath)) {
      const res = storageManager.switchStoragePath(symlinkPath);
      assert.equal(res.success, true);
      assert.equal(res.storagePath, symlinkPath);
      assert.ok(fs.existsSync(path.join(realDir, 'profiles')));
      assert.ok(fs.existsSync(path.join(realDir, 'logs')));
    }
  });
});
