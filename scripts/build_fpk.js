#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist_fpk');

console.log('[fnOS Builder] Starting NovelAI .fpk multi-architecture packaging...');

// 1. Ensure cmd files are executable
execSync(`chmod +x "${path.join(ROOT_DIR, 'cmd')}"/* 2>/dev/null || true`);

// 1.1 Ensure frontend is built
const uiDistIndex = path.join(ROOT_DIR, 'app/ui/dist/index.html');
const skipFrontend = process.argv.includes('--skip-frontend') || process.env.SKIP_FRONTEND === 'true';
if (!skipFrontend) {
  console.log('Compiling frontend dist now...');
  execSync('npm --prefix frontend run build', { stdio: 'inherit' });
} else if (!fs.existsSync(uiDistIndex)) {
  console.log('Frontend dist not found. Compiling frontend now...');
  execSync('npm --prefix frontend install && npm --prefix frontend run build', { stdio: 'inherit' });
}

// 1.2 Ensure server node_modules are installed and up to date
const serverPkgPath = path.join(ROOT_DIR, 'app/server/package.json');
if (fs.existsSync(serverPkgPath)) {
  const serverPkg = JSON.parse(fs.readFileSync(serverPkgPath, 'utf8'));
  const requiredDeps = Object.keys(serverPkg.dependencies || {});
  const missingDeps = requiredDeps.filter(dep => !fs.existsSync(path.join(ROOT_DIR, 'app/server/node_modules', dep)));
  if (missingDeps.length > 0) {
    console.log(`Missing server dependencies (${missingDeps.join(', ')}). Installing now...`);
    execSync('npm --prefix app/server install --omit=dev --cache /tmp/.npm-cache', { stdio: 'inherit' });
  }
}

// 2. Read base manifest
const manifestPath = path.join(ROOT_DIR, 'manifest');
if (!fs.existsSync(manifestPath)) {
  console.error('Error: manifest file not found!');
  process.exit(1);
}

function extractChangelogFromMd(targetVersion) {
  if (process.env.APP_CHANGELOG) {
    return process.env.APP_CHANGELOG.replace(/\r?\n/g, '<br>');
  }
  const changelogPath = path.join(ROOT_DIR, 'CHANGELOGS.md');
  if (fs.existsSync(changelogPath)) {
    const content = fs.readFileSync(changelogPath, 'utf8');
    const verPattern = targetVersion ? (targetVersion.includes('.') && targetVersion.split('.').length === 2 ? `${targetVersion.replace(/\./g, '\\.')}(\\.0)?` : targetVersion.replace(/\./g, '\\.')) : '[0-9.]+';
    const regex = new RegExp(`##\\s*\\[?v?${verPattern}\\]?[^\\n]*\\n([\\s\\S]*?)(?=\\n##|\\s*$)`, 'i');
    let match = content.match(regex);
    if (!match) {
      match = content.match(/##\s*\[?[^\]\n]+\]?[^\n]*\n([\s\S]*?)(?=\n##|\s*$)/);
    }
    const block = match ? match[1] : null;
    if (block) {
      const items = block
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('-') || l.startsWith('*'))
        .map(l => l.replace(/^[-*]\s*/, '').replace(/\*\*([^*]+)\*\*[：:]\s*/, '$1: '));
      if (items.length > 0) {
        return items.map((item, idx) => `${idx + 1}. ${item}`).join('<br>');
      }
    }
  }
  return '';
}

let baseManifest = fs.readFileSync(manifestPath, 'utf8');
const appnameMatch = baseManifest.match(/^appname=(.+)$/m);
const versionMatch = baseManifest.match(/^version=(.+)$/m);

const appname = appnameMatch ? appnameMatch[1].trim() : 'novelai';
let version = versionMatch ? versionMatch[1].trim() : '1.0.0';

// Check for version override (via CLI --version=1.0.1 or APP_VERSION env var)
const cliVersionArg = process.argv.find(arg => arg.startsWith('--version='));
const overrideVersion = process.env.APP_VERSION || (cliVersionArg ? cliVersionArg.split('=')[1] : null);

if (overrideVersion) {
  version = overrideVersion.replace(/^v/, '').trim();
  console.log(`Using target version override: ${version}`);
  baseManifest = baseManifest.replace(/^version=.+$/m, `version=${version}`);
}

const isDev = process.env.DEV_BUILD === 'true' || process.argv.includes('--dev');
if (isDev) {
  console.log('Dev build mode active');
}

// 3. Prepare clean dist directory
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

// 4. Build app.tgz with dual layout compatibility:
//    - Top-level: ui/, server/ (standard fnOS target layout)
//    - Nested:    app/ui/, app/server/ (legacy layout compatibility)
const appStaging = path.join(DIST_DIR, 'app_payload_staging');
fs.mkdirSync(appStaging, { recursive: true });

// Copy ui/ and server/ directly to top-level
execSync(`cp -R "${path.join(ROOT_DIR, 'app/ui')}" "${appStaging}/"`);
execSync(`cp -R "${path.join(ROOT_DIR, 'app/server')}" "${appStaging}/"`);

// Also provide app/ subdirectory mapping for dual-path resilience
const nestedAppDir = path.join(appStaging, 'app');
fs.mkdirSync(nestedAppDir, { recursive: true });
execSync(`cp -R "${path.join(ROOT_DIR, 'app/ui')}" "${nestedAppDir}/"`);
execSync(`cp -R "${path.join(ROOT_DIR, 'app/server')}" "${nestedAppDir}/"`);

const tempAppTgz = path.join(DIST_DIR, 'app.tgz');
console.log('Compressing app payload into app.tgz...');
execSync(`COPYFILE_DISABLE=1 tar --exclude=".DS_Store" -czf "${tempAppTgz}" -C "${appStaging}" .`);

// Clean temporary staging for app.tgz
fs.rmSync(appStaging, { recursive: true, force: true });

const appTgzBuffer = fs.readFileSync(tempAppTgz);
const appTgzMd5 = crypto.createHash('md5').update(appTgzBuffer).digest('hex');
console.log(`app.tgz MD5 Checksum: ${appTgzMd5}`);

// Supported matrix
const TARGETS = [
  { name: 'all', platform: 'all' },
  { name: 'amd64', platform: 'x86' },
  { name: 'arm64', platform: 'arm' }
];

const builtPackages = [];

for (const target of TARGETS) {
  console.log(`\nPackaging for [${target.name} / platform=${target.platform}]...`);
  const stagingDir = path.join(DIST_DIR, `staging_${target.name}`);
  fs.mkdirSync(stagingDir, { recursive: true });

  // Copy app.tgz
  fs.copyFileSync(tempAppTgz, path.join(stagingDir, 'app.tgz'));

  // Copy outer package components
  execSync(`cp -R "${path.join(ROOT_DIR, 'cmd')}" "${stagingDir}/"`);
  execSync(`cp -R "${path.join(ROOT_DIR, 'config')}" "${stagingDir}/"`);
  if (fs.existsSync(path.join(ROOT_DIR, 'wizard'))) {
    execSync(`cp -R "${path.join(ROOT_DIR, 'wizard')}" "${stagingDir}/"`);
  } else {
    fs.mkdirSync(path.join(stagingDir, 'wizard'), { recursive: true });
  }
  execSync(`cp -R "${path.join(ROOT_DIR, 'app/ui')}" "${stagingDir}/"`);
  execSync(`cp "${path.join(ROOT_DIR, 'ICON.PNG')}" "${stagingDir}/"`);
  execSync(`cp "${path.join(ROOT_DIR, 'ICON_256.PNG')}" "${stagingDir}/"`);
  if (fs.existsSync(path.join(ROOT_DIR, 'PACKAGE_ICON.PNG'))) {
    execSync(`cp "${path.join(ROOT_DIR, 'PACKAGE_ICON.PNG')}" "${stagingDir}/"`);
  }
  if (fs.existsSync(path.join(ROOT_DIR, 'PACKAGE_ICON_256.PNG'))) {
    execSync(`cp "${path.join(ROOT_DIR, 'PACKAGE_ICON_256.PNG')}" "${stagingDir}/"`);
  }

  // Build target manifest
  let targetManifest = baseManifest.trim();
  // Adjust platform
  if (targetManifest.match(/^platform=.*$/m)) {
    targetManifest = targetManifest.replace(/^platform=.*$/m, `platform=${target.platform}`);
  } else {
    targetManifest += `\nplatform=${target.platform}`;
  }
  // Ensure no os_min_version block
  targetManifest = targetManifest.replace(/^os_min_version=.*$/m, '').trim();

  // Inject or update changelog from CHANGELOGS.md
  const changelog = extractChangelogFromMd(version);
  if (changelog) {
    if (targetManifest.match(/^changelog=.*$/m)) {
      targetManifest = targetManifest.replace(/^changelog=.*$/m, `changelog=${changelog}`);
    } else {
      targetManifest += `\nchangelog=${changelog}`;
    }
  }

  // Remove existing checksum if present
  targetManifest = targetManifest.replace(/^checksum=.*$/m, '').trim();
  // Append checksum
  targetManifest += `\nchecksum=${appTgzMd5}\n`;

  fs.writeFileSync(path.join(stagingDir, 'manifest'), targetManifest, 'utf8');

  // Package into final .fpk
  const fpkFileName = `${appname}_${version}_${target.name}.fpk`;
  const fpkPath = path.join(DIST_DIR, fpkFileName);

  execSync(`COPYFILE_DISABLE=1 tar --exclude=".DS_Store" -czf "${fpkPath}" -C "${stagingDir}" manifest app.tgz cmd config wizard ui ICON.PNG ICON_256.PNG PACKAGE_ICON.PNG PACKAGE_ICON_256.PNG`);
  
  // Clean staging
  fs.rmSync(stagingDir, { recursive: true, force: true });

  const stats = fs.statSync(fpkPath);
  const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
  builtPackages.push({ name: fpkFileName, path: fpkPath, size: sizeMb, target: target.name });
}

// Clean temporary app.tgz
fs.unlinkSync(tempAppTgz);

// If in dev mode, also create alias: mslfrp-dev.fpk
if (isDev) {
  const primaryPkg = builtPackages.find(p => p.target === 'all') || builtPackages[0];
  if (primaryPkg) {
    const devFpkName = `${appname}-dev.fpk`;
    fs.copyFileSync(primaryPkg.path, path.join(DIST_DIR, devFpkName));
    console.log(`Dev package saved as: ${devFpkName}`);
  }
}

console.log('\n==============================================');
console.log('Build Complete for all target architectures!');
for (const pkg of builtPackages) {
  console.log(`[${pkg.target}] ${pkg.name} (${pkg.size} MB)`);
}
console.log(`Output Directory: ${DIST_DIR}`);
console.log('==============================================\n');
