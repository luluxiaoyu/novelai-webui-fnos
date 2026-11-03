const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Point storage to a temporary directory for tests
const TEST_DIR = path.join(os.tmpdir(), `novelai_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
process.env.NOVELAI_SHARE_DIR = TEST_DIR;

const configManager = require('../configManager');
configManager.updateConfig({ storagePath: TEST_DIR });

const profileDb = require('../profileDb');
const profileManager = require('../profileManager');

describe('SQLite Profile Storage & Silent Migration Tests', () => {
  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    profileDb.closeAllDbs();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  test('1. Database schema, tables, and WAL mode verification', () => {
    const profileName = 'TestWAL';
    const profileDir = profileManager.getProfileDir(profileName);
    const db = profileDb.getDb(profileDir, profileName);

    const journalMode = db.prepare('PRAGMA journal_mode;').get();
    assert.equal(journalMode.journal_mode.toLowerCase(), 'wal', 'Journal mode must be WAL');

    const syncMode = db.prepare('PRAGMA synchronous;').get();
    assert.equal(Number(syncMode.synchronous), 1, 'Synchronous pragma should be NORMAL (1)');

    const fk = db.prepare('PRAGMA foreign_keys;').get();
    assert.equal(Number(fk.foreign_keys), 1, 'Foreign keys should be ON (1)');

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table';").all().map(t => t.name);
    assert.ok(tables.includes('history'), 'history table must exist');
    assert.ok(tables.includes('prompt_history'), 'prompt_history table must exist');
    assert.ok(tables.includes('styles'), 'styles table must exist');
    assert.ok(tables.includes('prompt_groups'), 'prompt_groups table must exist');
    assert.ok(tables.includes('characters'), 'characters table must exist');
    assert.ok(tables.includes('profile_settings'), 'profile_settings table must exist');

    profileDb.closeDb(profileDir);
  });

  test('2. Silent auto-migration from data.json: data integrity and json deletion', () => {
    const profileName = 'MigrateTest';
    const profileDir = profileManager.getProfileDir(profileName);
    const jsonPath = path.join(profileDir, 'data.json');

    // Sample 1x1 transparent PNG in base64
    const samplePngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const legacyData = {
      params: {
        model: 'nai-diffusion-4-full',
        prompt: 'masterpiece, 1girl',
        negative_prompt: 'lowres, blurry',
        steps: 28,
        scale: 6.5
      },
      promptHistory: [
        {
          id: 'ph-1',
          prompt: '1girl, solo, smile',
          negative_prompt: 'lowres',
          group: 'Portrait',
          note: 'Sample note',
          isFavorite: true,
          use_coords: true,
          characters: [{ id: 'char-1', prompt: 'cat ears', uc: '', center: { x: 0.5, y: 0.5 }, enabled: true }],
          timestamp: 1700000001000
        },
        {
          id: 'ph-2',
          prompt: 'scenery, mountain, sunset',
          negative_prompt: '',
          group: 'Landscape',
          isFavorite: false,
          timestamp: 1700000002000
        }
      ],
      savedPromptGroups: ['Portrait', 'Landscape', 'Anime Style'],
      customStyles: [
        {
          id: 'style-1',
          name: 'Makoto Shinkai Style',
          category: 'Anime',
          prompt: 'by makoto shinkai, beautiful lighting',
          uc: 'gloomy, dark',
          preview: 'http://example.com/p1.jpg',
          isFavorite: true,
          updatedAt: 1700000003000
        }
      ],
      customCharacters: [
        {
          id: 'char-nahida',
          name: 'Nahida',
          category: 'Genshin',
          prompt: 'nahida(genshin impact)',
          uc: 'bad anatomy',
          avatar: 'http://example.com/nahida.png',
          preview: 'http://example.com/nahida.png',
          isBuiltin: false,
          isFavorite: true,
          updatedAt: 1700000004000
        }
      ],
      history: [
        {
          id: 'hist-base64',
          url: samplePngBase64,
          params: { prompt: 'nahida, solo', model: 'nai-diffusion-4-full' },
          timestamp: 1700000005000,
          isUpscaled: false
        },
        {
          id: 'hist-regular',
          url: '/api/images/MigrateTest/hist-regular.png',
          params: { prompt: 'scenery', model: 'nai-diffusion-4-full' },
          timestamp: 1700000006000,
          isUpscaled: true
        }
      ]
    };

    fs.writeFileSync(jsonPath, JSON.stringify(legacyData, null, 2), 'utf8');
    assert.ok(fs.existsSync(jsonPath), 'data.json must exist before migration');

    // Trigger migration by accessing profile data
    const profileData = profileManager.getProfileData(profileName);

    // 1. Verify data.json was deleted
    assert.equal(fs.existsSync(jsonPath), false, 'data.json must be deleted after silent migration');

    // 2. Verify profile.db exists
    const dbPath = path.join(profileDir, 'profile.db');
    assert.ok(fs.existsSync(dbPath), 'profile.db must exist after migration');

    // 3. Verify base64 image converted to file on disk
    const savedImgPath = path.join(profileDir, 'images', 'hist-base64.png');
    assert.ok(fs.existsSync(savedImgPath), 'hist-base64.png must be saved to images dir');

    // 4. Verify returned history data
    assert.equal(profileData.history.length, 2);
    const h1 = profileData.history.find(h => h.id === 'hist-base64');
    assert.ok(h1);
    assert.equal(h1.url, '/api/images/MigrateTest/hist-base64.png');
    assert.equal(h1.params.prompt, 'nahida, solo');
    assert.equal(h1.isUpscaled, false);

    const h2 = profileData.history.find(h => h.id === 'hist-regular');
    assert.ok(h2);
    assert.equal(h2.isUpscaled, true);

    // 5. Verify prompt history
    assert.equal(profileData.promptHistory.length, 2);
    const ph1 = profileData.promptHistory.find(p => p.id === 'ph-1');
    assert.ok(ph1);
    assert.equal(ph1.prompt, '1girl, solo, smile');
    assert.equal(ph1.group, 'Portrait');
    assert.equal(ph1.note, 'Sample note');
    assert.equal(ph1.isFavorite, true);
    assert.equal(ph1.use_coords, true);
    assert.equal(ph1.characters.length, 1);
    assert.equal(ph1.characters[0].id, 'char-1');

    // 6. Verify savedPromptGroups & promptGroups
    assert.deepEqual(profileData.savedPromptGroups.sort(), ['Anime Style', 'Landscape', 'Portrait']);
    assert.equal(profileData.promptGroups.length, 3);

    // 7. Verify styles
    assert.equal(profileData.customStyles.length, 1);
    assert.equal(profileData.customStyles[0].name, 'Makoto Shinkai Style');
    assert.equal(profileData.customStyles[0].uc, 'gloomy, dark');
    assert.equal(profileData.customStyles[0].isFavorite, true);

    // 8. Verify characters
    assert.equal(profileData.customCharacters.length, 1);
    assert.equal(profileData.customCharacters[0].name, 'Nahida');
    assert.equal(profileData.customCharacters[0].uc, 'bad anatomy');
    assert.equal(profileData.customCharacters[0].isFavorite, true);

    // 9. Verify params
    assert.equal(profileData.params.model, 'nai-diffusion-4-full');
    assert.equal(profileData.params.scale, 6.5);
  });

  test('3. Profile CRUD operations: create, switch, rename, delete', () => {
    // 1. Create
    const created = profileManager.createProfile('ProjectAlpha');
    assert.equal(created, 'ProjectAlpha');
    const dbFile = profileManager.getProfileDbPath('ProjectAlpha');
    assert.ok(fs.existsSync(dbFile), 'profile.db must be created');
    const jsonFile = profileManager.getProfileDataFile('ProjectAlpha');
    assert.equal(fs.existsSync(jsonFile), false, 'data.json should NOT be created for new profiles');

    // 2. Switch
    const active = profileManager.switchProfile('ProjectAlpha');
    assert.equal(active, 'ProjectAlpha');
    const listRes = profileManager.listProfiles();
    assert.equal(listRes.activeProfile, 'ProjectAlpha');
    assert.ok(listRes.profiles.includes('ProjectAlpha'));

    // 3. Rename
    profileManager.renameProfile('ProjectAlpha', 'ProjectBeta');
    const listAfterRename = profileManager.listProfiles();
    assert.ok(listAfterRename.profiles.includes('ProjectBeta'));
    assert.ok(!listAfterRename.profiles.includes('ProjectAlpha'));
    assert.equal(listAfterRename.activeProfile, 'ProjectBeta');

    // 4. Delete
    const deleted = profileManager.deleteProfile('ProjectBeta');
    assert.equal(deleted, true);
    const listAfterDelete = profileManager.listProfiles();
    assert.ok(!listAfterDelete.profiles.includes('ProjectBeta'));
  });

  test('4. History operations: add, delete, batchDelete, and pagination', () => {
    const profile = 'HistoryTest';
    profileManager.createProfile(profile);

    // Add 15 history items
    for (let i = 1; i <= 15; i++) {
      profileManager.addHistoryItem(profile, {
        id: `img-${i}`,
        url: `/api/images/${profile}/img-${i}.png`,
        timestamp: 1000000 + i * 100,
        params: {
          prompt: i % 2 === 0 ? `girl anime number ${i}` : `landscape scenery number ${i}`,
          negative_prompt: 'lowres',
          model: 'nai-diffusion-4-full'
        },
        isUpscaled: i > 10
      });
    }

    // Pagination test: page 1, pageSize 5
    const page1 = profileManager.getHistory(profile, { page: 1, pageSize: 5 });
    assert.equal(page1.total, 15);
    assert.equal(page1.totalPages, 3);
    assert.equal(page1.history.length, 5);
    assert.equal(page1.history[0].id, 'img-15'); // latest timestamp first

    // Pagination test: page 2, pageSize 5
    const page2 = profileManager.getHistory(profile, { page: 2, pageSize: 5 });
    assert.equal(page2.history.length, 5);
    assert.equal(page2.history[0].id, 'img-10');

    // Search test
    const searchRes = profileManager.getHistory(profile, { search: 'landscape' });
    assert.equal(searchRes.total, 8); // odd numbers: 1, 3, 5, 7, 9, 11, 13, 15
    for (const h of searchRes.history) {
      assert.ok(h.params.prompt.includes('landscape'));
    }

    // Delete single item
    profileManager.deleteHistoryItem(profile, 'img-1');
    const countAfterOneDelete = profileManager.getHistory(profile).total;
    assert.equal(countAfterOneDelete, 14);

    // Batch delete
    profileManager.batchDeleteHistoryItems(profile, ['img-2', 'img-3', 'img-4']);
    const countAfterBatchDelete = profileManager.getHistory(profile).total;
    assert.equal(countAfterBatchDelete, 11);
  });

  test('5. Large batch delete (>500 items) chunking safety', () => {
    const profile = 'LargeBatchTest';
    profileManager.createProfile(profile);

    const ids = [];
    for (let i = 1; i <= 650; i++) {
      const id = `bulk-${i}`;
      ids.push(id);
      profileManager.addHistoryItem(profile, {
        id,
        url: `/api/images/${profile}/${id}.png`,
        timestamp: 1000000 + i,
        params: { prompt: `test ${i}` }
      });
    }

    const beforeTotal = profileManager.getHistory(profile).total;
    assert.equal(beforeTotal, 650);

    // Delete all 650 items in one call (tests >500 chunking)
    profileManager.batchDeleteHistoryItems(profile, ids);

    const afterTotal = profileManager.getHistory(profile).total;
    assert.equal(afterTotal, 0);
  });

  test('6. Corrupt / empty data.json error resilience', () => {
    const profile = 'CorruptTest';
    const profileDir = profileManager.getProfileDir(profile);
    const jsonPath = path.join(profileDir, 'data.json');

    // Case A: 0-byte file
    fs.writeFileSync(jsonPath, '', 'utf8');
    const dataEmpty = profileManager.getProfileData(profile);
    assert.ok(dataEmpty);
    assert.equal(fs.existsSync(jsonPath), false, 'Empty data.json should be removed');

    // Case B: Syntax error file
    fs.writeFileSync(jsonPath, '{ malformed json: not valid', 'utf8');
    const dataCorrupt = profileManager.getProfileData(profile);
    assert.ok(dataCorrupt);
    assert.ok(fs.existsSync(`${jsonPath}.bak.corrupt`), 'Corrupt file should be renamed to .bak.corrupt');
  });

  test('7. Null/undefined edge cases in saveProfileData', () => {
    const profile = 'NullUndefinedTest';
    profileManager.createProfile(profile);

    // Should not throw ERR_INVALID_ARG_TYPE
    profileManager.saveProfileData(profile, {
      promptHistory: [
        { id: 'ph-null', prompt: 'test prompt', negative_prompt: undefined, group: undefined, note: undefined }
      ],
      savedPromptGroups: ['group1', 'group2'],
      customStyles: [
        { id: 'style-null', name: 'style1', prompt: 'sp', uc: undefined, preview: undefined }
      ],
      customCharacters: [
        { id: 'char-null', name: 'char1', prompt: 'cp', uc: undefined, avatar: undefined }
      ],
      params: { prompt: 'new draft' }
    });

    const data = profileManager.getProfileData(profile);
    assert.equal(data.promptHistory.length, 1);
    assert.equal(data.promptHistory[0].negative_prompt, '');
    assert.equal(data.customStyles.length, 1);
    assert.equal(data.customCharacters.length, 1);
    assert.equal(data.savedPromptGroups.length, 2);
    assert.equal(data.params.prompt, 'new draft');
  });

  test('8. Robustness against invalid/non-numeric pagination parameters', () => {
    const profile = 'PaginationSafetyTest';
    profileManager.createProfile(profile);

    // Add a test record
    profileManager.addHistoryItem(profile, {
      id: 'img-safe',
      url: `/api/images/${profile}/img-safe.png`,
      timestamp: Date.now(),
      params: { prompt: 'safety test', seed: 123456 }
    });

    // Test non-numeric limit, offset, and timeFilter - must NOT throw ERR_SQLITE_ERROR
    const res1 = profileManager.getHistory(profile, { limit: 'invalid', offset: 'invalid' });
    assert.equal(res1.history.length, 1);
    assert.equal(res1.total, 1);

    const res2 = profileManager.getHistory(profile, { limit: 0 });
    assert.equal(res2.history.length, 1);

    const res3 = profileManager.getHistory(profile, { timeFilter: { start: 'not-a-date', end: 'bad' } });
    assert.equal(res3.history.length, 1);

    // Search by ID and by seed in params
    const resIdSearch = profileManager.getHistory(profile, { search: 'img-safe' });
    assert.equal(resIdSearch.total, 1);

    const resSeedSearch = profileManager.getHistory(profile, { search: '123456' });
    assert.equal(resSeedSearch.total, 1);
  });

  test('9. Profile rename updates history image URLs and preserves gallery links', () => {
    const oldName = 'OriginProfile';
    const newName = 'TargetProfile';
    profileManager.createProfile(oldName);

    const buf = Buffer.from('fake image content');
    const savedUrl = profileManager.saveGeneratedImageFile(oldName, 'pic1', buf);
    assert.ok(savedUrl.includes(oldName));

    profileManager.addHistoryItem(oldName, {
      id: 'pic1',
      url: savedUrl,
      timestamp: Date.now(),
      params: { prompt: 'rename test' }
    });

    // Rename profile
    profileManager.renameProfile(oldName, newName);

    // Check history in new profile
    const historyRes = profileManager.getHistory(newName);
    assert.equal(historyRes.total, 1);
    const item = historyRes.history[0];
    assert.ok(item.url.includes(newName), `URL must point to "${newName}", got: ${item.url}`);

    // Verify getImagePath resolves with new profile name
    const resolvedPath = profileManager.getImagePath(newName, 'pic1');
    assert.ok(resolvedPath && fs.existsSync(resolvedPath), 'Image file must resolve under renamed profile');
  });

  test('10. Prompt group content and category preserved during frontend autosave', () => {
    const profile = 'GroupPreserveTest';
    profileManager.createProfile(profile);
    const pDir = profileManager.getProfileDir(profile);
    const db = profileDb.getDb(pDir, profile);

    // Initialize rich prompt groups
    profileDb.savePromptGroups(db, [
      { id: 'g1', name: 'Masterpiece', content: 'masterpiece, best quality', category: 'Quality' }
    ]);

    // Frontend performs autosave with only group name strings
    profileManager.saveProfileData(profile, {
      params: { steps: 28 },
      savedPromptGroups: ['Masterpiece']
    });

    const groups = profileDb.getAllPromptGroups(db);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, 'Masterpiece');
    assert.equal(groups[0].content, 'masterpiece, best quality', 'Group content must NOT be wiped by string save');
    assert.equal(groups[0].category, 'Quality', 'Group category must NOT be wiped by string save');
  });

  test('11. Duplicate ID resilience across custom characters, styles, and prompt history', () => {
    const profile = 'DuplicateIdTest';
    profileManager.createProfile(profile);

    // Should not throw UNIQUE constraint failed
    assert.doesNotThrow(() => {
      profileManager.saveProfileData(profile, {
        customCharacters: [
          { id: 'dup-c1', name: 'Char A', prompt: 'a' },
          { id: 'dup-c1', name: 'Char A Updated', prompt: 'a2' }
        ],
        customStyles: [
          { id: 'dup-s1', name: 'Style A', prompt: 's1' },
          { id: 'dup-s1', name: 'Style A Updated', prompt: 's2' }
        ],
        promptHistory: [
          { id: 'dup-p1', prompt: 'prompt 1' },
          { id: 'dup-p1', prompt: 'prompt 1 updated' }
        ]
      });
    });

    const data = profileManager.getProfileData(profile);
    assert.equal(data.customCharacters.length, 1);
    assert.equal(data.customCharacters[0].name, 'Char A Updated');
    assert.equal(data.customStyles.length, 1);
    assert.equal(data.customStyles[0].name, 'Style A Updated');
    assert.equal(data.promptHistory.length, 1);
    assert.equal(data.promptHistory[0].prompt, 'prompt 1 updated');
  });

  test('12. Delete history item with .png extension deletes file on disk', () => {
    const profile = 'DeleteExtTest';
    profileManager.createProfile(profile);

    const buf = Buffer.from('test png content');
    profileManager.saveGeneratedImageFile(profile, 'ext-test', buf);
    profileManager.addHistoryItem(profile, {
      id: 'ext-test',
      url: `/api/images/${profile}/ext-test.png`,
      timestamp: Date.now()
    });

    const imgPath = profileManager.getImagePath(profile, 'ext-test');
    assert.ok(imgPath && fs.existsSync(imgPath), 'Image file must exist initially');

    // Delete passing 'ext-test.png'
    profileManager.deleteHistoryItem(profile, 'ext-test.png');
    assert.equal(fs.existsSync(imgPath), false, 'Image file must be unlinked from disk');
    assert.equal(profileManager.getHistory(profile).total, 0, 'Record must be deleted from DB');
  });

  test('13. Migration with non-object JSON (null) is handled gracefully', () => {
    const profile = 'NullJsonMigrateTest';
    const profileDir = profileManager.getProfileDir(profile);
    const jsonPath = path.join(profileDir, 'data.json');

    fs.writeFileSync(jsonPath, 'null', 'utf8');

    // Should not crash and instead safely rename corrupt file
    const data = profileManager.getProfileData(profile);
    assert.ok(data);
    assert.ok(fs.existsSync(`${jsonPath}.bak.corrupt`));
  });

  test('14. Migration with both promptGroups and savedPromptGroups preserves full data', () => {
    const profile = 'PromptGroupsMigrateTest';
    const profileDir = profileManager.getProfileDir(profile);
    const jsonPath = path.join(profileDir, 'data.json');

    const legacyData = {
      promptGroups: [
        { id: 'pg1', name: 'Anime', content: 'anime style, vibrant', category: 'Style' }
      ],
      savedPromptGroups: ['Anime', 'Landscape'],
      history: []
    };

    fs.writeFileSync(jsonPath, JSON.stringify(legacyData), 'utf8');

    const data = profileManager.getProfileData(profile);
    assert.equal(data.promptGroups.length, 2);
    const gAnime = data.promptGroups.find(g => g.name === 'Anime');
    assert.ok(gAnime);
    assert.equal(gAnime.content, 'anime style, vibrant');
    assert.equal(gAnime.category, 'Style');

    const gLand = data.promptGroups.find(g => g.name === 'Landscape');
    assert.ok(gLand);
  });
});
