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

  test('13. mergeStorageData incrementally copies files without overwriting existing files', async () => {
    const srcDir = path.join(TEST_BASE, 'merge_src_1');
    const destDir = path.join(TEST_BASE, 'merge_dest_1');
    fs.mkdirSync(path.join(srcDir, 'profiles/Default/images/2026/11'), { recursive: true });
    fs.mkdirSync(path.join(destDir, 'profiles/Default/images/2026/11'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'logs/generation/2026-11'), { recursive: true });

    // Both have shared_img.png but different content
    fs.writeFileSync(path.join(srcDir, 'profiles/Default/images/2026/11/shared.png'), 'src_shared_version');
    fs.writeFileSync(path.join(destDir, 'profiles/Default/images/2026/11/shared.png'), 'dest_original_version');

    // Source has a new unique image
    fs.writeFileSync(path.join(srcDir, 'profiles/Default/images/2026/11/new_src.png'), 'src_new_content');

    // Source has a log file
    fs.writeFileSync(path.join(srcDir, 'logs/generation/2026-11/gen_1.log'), 'gen_log_content');

    const progressReports = [];
    const res = await storageManager.mergeStorageData(srcDir, destDir, (p) => progressReports.push(p), false);

    assert.equal(res.success, true);
    assert.equal(res.filesCopied, 2); // new_src.png and gen_1.log

    // Verify existing file was NOT overwritten
    const sharedContent = fs.readFileSync(path.join(destDir, 'profiles/Default/images/2026/11/shared.png'), 'utf8');
    assert.equal(sharedContent, 'dest_original_version');

    // Verify new file was copied
    const newContent = fs.readFileSync(path.join(destDir, 'profiles/Default/images/2026/11/new_src.png'), 'utf8');
    assert.equal(newContent, 'src_new_content');

    // Verify progress reported completed
    assert.ok(progressReports.some(p => p.phase === 'completed' && p.percent === 100));
  });

  test('14. mergeStorageData merges SQLite records without duplicate key conflicts', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const srcDir = path.join(TEST_BASE, 'merge_src_db');
    const destDir = path.join(TEST_BASE, 'merge_dest_db');
    fs.mkdirSync(path.join(srcDir, 'profiles/Default'), { recursive: true });
    fs.mkdirSync(path.join(destDir, 'profiles/Default'), { recursive: true });

    const srcDb = new DatabaseSync(path.join(srcDir, 'profiles/Default/profile.db'));
    profileDb.initDbSchema(srcDb);
    // Source records
    srcDb.prepare(`INSERT INTO history (id, url, timestamp, prompt) VALUES (?, ?, ?, ?)`).run('shared_id', '/api/images/Default/shared.png', 1000, 'src prompt');
    srcDb.prepare(`INSERT INTO history (id, url, timestamp, prompt) VALUES (?, ?, ?, ?)`).run('src_unique_id', '/api/images/Default/unique.png', 2000, 'unique prompt');
    srcDb.prepare(`INSERT INTO styles (id, name, prompt) VALUES (?, ?, ?)`).run('src_style_1', 'Src Style', 'style prompt');
    srcDb.close();

    const destDb = new DatabaseSync(path.join(destDir, 'profiles/Default/profile.db'));
    profileDb.initDbSchema(destDb);
    // Dest has shared_id with different prompt
    destDb.prepare(`INSERT INTO history (id, url, timestamp, prompt) VALUES (?, ?, ?, ?)`).run('shared_id', '/api/images/Default/shared.png', 1000, 'dest original prompt');
    destDb.prepare(`INSERT INTO history (id, url, timestamp, prompt) VALUES (?, ?, ?, ?)`).run('dest_unique_id', '/api/images/Default/dest_unique.png', 3000, 'dest prompt');
    destDb.close();

    const res = await storageManager.mergeStorageData(srcDir, destDir, () => {}, false);
    assert.equal(res.success, true);
    assert.ok(res.recordsMerged >= 2);

    // Verify destination DB contents
    const checkDb = new DatabaseSync(path.join(destDir, 'profiles/Default/profile.db'));
    const rows = checkDb.prepare(`SELECT * FROM history ORDER BY timestamp`).all();
    assert.equal(rows.length, 3); // shared_id, src_unique_id, dest_unique_id

    // shared_id should preserve destination's prompt
    const sharedRow = rows.find(r => r.id === 'shared_id');
    assert.equal(sharedRow.prompt, 'dest original prompt');

    // src_unique_id should be present
    const srcRow = rows.find(r => r.id === 'src_unique_id');
    assert.equal(srcRow.prompt, 'unique prompt');

    // src_style_1 should be merged
    const styles = checkDb.prepare(`SELECT * FROM styles`).all();
    assert.equal(styles.length, 1);
    assert.equal(styles[0].name, 'Src Style');

    checkDb.close();
  });

  test('15. startMergeJob and getMergeJobStatus track asynchronous merge progress', async () => {
    const srcDir = path.join(TEST_BASE, 'job_src');
    const destDir = path.join(TEST_BASE, 'job_dest');
    fs.mkdirSync(path.join(srcDir, 'profiles/Default/images'), { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });

    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(srcDir, `profiles/Default/images/img_${i}.png`), `data_${i}`);
    }

    const job = storageManager.startMergeJob(srcDir, destDir, true);
    assert.ok(job.jobId);
    assert.equal(job.status, 'scanning');

    // Poll until completed
    let finalStatus = null;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 50));
      finalStatus = storageManager.getMergeJobStatus(job.jobId);
      if (finalStatus.status === 'completed' || finalStatus.status === 'failed') {
        break;
      }
    }

    assert.equal(finalStatus.status, 'completed');
    assert.equal(finalStatus.progress, 100);
    assert.equal(finalStatus.stats.filesCopied, 5);
    assert.equal(configManager.getConfig().storagePath, destDir);
  });

  test('16. POST /storage/merge and GET /storage/merge-status HTTP API endpoints', async () => {
    const srcDir = path.join(TEST_BASE, 'api_merge_src');
    const destDir = path.join(TEST_BASE, 'api_merge_dest');
    fs.mkdirSync(path.join(srcDir, 'profiles/Default/images'), { recursive: true });
    fs.mkdirSync(destDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'profiles/Default/images/api_test.png'), 'test_image');

    const startRes = await invoke('POST', '/storage/merge', {
      sourcePath: srcDir,
      targetPath: destDir,
      switchOnComplete: true
    });

    assert.equal(startRes.status, 200);
    assert.equal(startRes.data.success, true);
    assert.ok(startRes.data.jobId);

    // Poll status endpoint
    let pollRes = null;
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 50));
      pollRes = await invoke('GET', `/storage/merge-status?jobId=${startRes.data.jobId}`);
      if (pollRes.data.status === 'completed' || pollRes.data.status === 'failed') {
        break;
      }
    }

    assert.equal(pollRes.status, 200);
    assert.equal(pollRes.data.status, 'completed');
    assert.equal(pollRes.data.progress, 100);
  });

  test('17. getAuthorizedPaths hides @appdata/novelai/data when NovelAI-WebUI app share exists', () => {
    // Ensure NovelAI-WebUI share candidate is present
    const webuiShareDir = path.join(TEST_BASE, 'shares/NovelAI-WebUI');
    fs.mkdirSync(webuiShareDir, { recursive: true });
    process.env.TRIM_DATA_SHARE_PATHS = webuiShareDir;

    const res = storageManager.getAuthorizedPaths();
    const types = res.paths.map(p => p.type);
    const paths = res.paths.map(p => p.path);

    // App share should be present
    assert.ok(types.includes('app_share'));
    // Internal appdata should NOT be present
    assert.ok(!types.includes('appdata'), 'appdata type must be hidden when app_share exists');
    assert.ok(!paths.some(p => p.includes(path.join(TEST_PKG_VAR, 'data'))), 'internal data path must not be in list');
  });

  test('18. mergeStorageData detects symlinked alias to same realpath and finishes without locking', async () => {
    const realDir = path.join(TEST_BASE, 'merge_symlink_real');
    const linkDir = path.join(TEST_BASE, 'merge_symlink_link');
    fs.mkdirSync(path.join(realDir, 'profiles/Default'), { recursive: true });
    try {
      fs.symlinkSync(realDir, linkDir, 'dir');
    } catch {}

    if (fs.existsSync(linkDir)) {
      let progressReported = null;
      const res = await storageManager.mergeStorageData(linkDir, realDir, (p) => { progressReported = p; }, true);
      assert.equal(res.success, true);
      assert.equal(res.filesCopied, 0);
      assert.equal(res.recordsMerged, 0);
      assert.ok(progressReported);
      assert.equal(progressReported.phase, 'completed');
      assert.match(progressReported.detail, /两侧存储目录相同/);
    }
  });

  test('19. scanFilesToCopy ignores foreign directories and NAS special folders', () => {
    const srcDir = path.join(TEST_BASE, 'foreign_dirs_src');
    const destDir = path.join(TEST_BASE, 'foreign_dirs_dest');
    fs.mkdirSync(path.join(srcDir, 'profiles/Default/images'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, '@eaDir'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, '#recycle'), { recursive: true });
    fs.mkdirSync(path.join(srcDir, 'UnrelatedUserFolder'), { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'profiles/Default/images/pic.png'), 'pic_data');
    fs.writeFileSync(path.join(srcDir, 'logs/gen.log'), 'log_data');
    fs.writeFileSync(path.join(srcDir, '@eaDir/@test'), 'eadir_data');
    fs.writeFileSync(path.join(srcDir, '#recycle/deleted.png'), 'recycle_data');
    fs.writeFileSync(path.join(srcDir, 'UnrelatedUserFolder/movie.mp4'), 'mp4_data');

    const files = storageManager.scanFilesToCopy(srcDir, destDir);
    const rels = files.map(f => f.rel);

    assert.ok(rels.includes('profiles/Default/images/pic.png'));
    assert.ok(rels.includes('logs/gen.log'));
    assert.ok(!rels.some(r => r.startsWith('@eaDir')));
    assert.ok(!rels.some(r => r.startsWith('#recycle')));
    assert.ok(!rels.some(r => r.startsWith('UnrelatedUserFolder')));
  });
});
