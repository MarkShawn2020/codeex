import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  createPackageWithOptions,
  extractAll,
  extractFile,
  listPackage,
  statFile,
} from '@electron/asar';
import {
  preparedCloneApp as cloneApp,
  officialApp,
  officialArchive,
  prepareStamp,
  preparedRuntimeBundleIdentifier as runtimeBundleIdentifier,
  productIcon,
  runtimeDisplayName,
  runtimeRoot,
  sourceWebview,
  upstreamApp,
  upstreamRoot,
} from './paths.mjs';

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} failed (${result.status})${detail ? `\n${detail}` : ''}`);
  }
}

async function readFingerprint() {
  const archiveStat = await stat(officialArchive);
  const packaged = JSON.parse(extractFile(officialArchive, 'package.json').toString());
  const officialPlist = path.join(officialApp, 'Contents', 'Info.plist');
  const displayName = spawnSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleDisplayName', officialPlist],
    { encoding: 'utf8' },
  ).stdout.trim();
  return {
    appPath: officialApp,
    archiveSize: archiveStat.size,
    archiveMtimeMs: Math.trunc(archiveStat.mtimeMs),
    version: packaged.version,
    buildFlavor: packaged.codexBuildFlavor,
    buildNumber: packaged.codexBuildNumber,
    displayName,
  };
}

async function isCurrent(fingerprint) {
  try {
    const previous = JSON.parse(await readFile(prepareStamp, 'utf8'));
    const cloneArchive = path.join(cloneApp, 'Contents', 'Resources', 'app.asar');
    const clonedPackage = JSON.parse(extractFile(cloneArchive, 'package.json').toString());
    const displayName = spawnSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleDisplayName', path.join(cloneApp, 'Contents', 'Info.plist')],
      { encoding: 'utf8' },
    );
    const bundleIdentifier = spawnSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleIdentifier', path.join(cloneApp, 'Contents', 'Info.plist')],
      { encoding: 'utf8' },
    );
    return (
      JSON.stringify(previous.fingerprint) === JSON.stringify(fingerprint) &&
      (await exists(path.join(sourceWebview, 'index.html'))) &&
      clonedPackage.version === fingerprint.version &&
      clonedPackage.codexBuildFlavor === 'prod' &&
      Boolean(statFile(cloneArchive, 'webview/index.html').unpacked) &&
      displayName.stdout.trim() === runtimeDisplayName &&
      bundleIdentifier.stdout.trim() === runtimeBundleIdentifier &&
      previous.asarHash === (await sha256(cloneArchive))
    );
  } catch {
    return false;
  }
}

function setPlistValue(plist, key, value) {
  const set = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  if (set.status === 0) return;
  run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist]);
}

function originalUnpackedRoots() {
  const files = listPackage(officialArchive, { isPack: false }).map((entry) =>
    entry.replace(/^\//, ''),
  );
  const unpacked = new Set(
    files.filter((entry) => {
      try {
        return Boolean(statFile(officialArchive, entry).unpacked);
      } catch {
        return false;
      }
    }),
  );
  return [...unpacked]
    .filter((entry) => {
      const parent = path.posix.dirname(entry);
      return parent === '.' || !unpacked.has(parent);
    })
    .sort();
}

async function sha256(file) {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

async function prepare() {
  if (!(await exists(officialArchive))) {
    throw new Error(`Codex app archive not found: ${officialArchive}`);
  }

  const fingerprint = await readFingerprint();
  if (fingerprint.buildFlavor !== 'prod') {
    throw new Error(
      `Expected a production Codex build, received ${String(fingerprint.buildFlavor)}`,
    );
  }
  if (await isCurrent(fingerprint)) {
    console.log(`✓ Codex ${fingerprint.version} production source is prepared`);
    return;
  }

  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(upstreamRoot, { recursive: true });
  const stageApp = path.join(upstreamRoot, `.app-next-${process.pid}`);
  const stageClone = path.join(runtimeRoot, `.Codeex-next-${process.pid}.app`);
  const stageArchive = path.join(runtimeRoot, `.app-next-${process.pid}.asar`);
  const stageUnpacked = `${stageArchive}.unpacked`;

  await rm(stageApp, { recursive: true, force: true });
  await rm(stageClone, { recursive: true, force: true });
  await rm(stageArchive, { force: true });
  await rm(stageUnpacked, { recursive: true, force: true });

  console.log(`Extracting Codex ${fingerprint.version} production bundle…`);
  extractAll(officialArchive, stageApp);

  console.log('Creating APFS clone of the signed application…');
  run('/bin/cp', ['-cR', officialApp, stageClone]);

  const unpackRoots = ['webview', ...originalUnpackedRoots()];
  const unpackDir = `{${unpackRoots.join(',')}}`;
  console.log('Repacking app.asar with the production webview externally writable…');
  await createPackageWithOptions(stageApp, stageArchive, { unpackDir });

  const cloneResources = path.join(stageClone, 'Contents', 'Resources');
  await rm(path.join(cloneResources, 'app.asar'), { force: true });
  await rm(path.join(cloneResources, 'app.asar.unpacked'), {
    recursive: true,
    force: true,
  });
  await rename(stageArchive, path.join(cloneResources, 'app.asar'));
  await rename(stageUnpacked, path.join(cloneResources, 'app.asar.unpacked'));

  const plist = path.join(stageClone, 'Contents', 'Info.plist');
  setPlistValue(plist, 'CFBundleIdentifier', runtimeBundleIdentifier);
  setPlistValue(plist, 'CFBundleDisplayName', runtimeDisplayName);
  setPlistValue(plist, 'CFBundleName', runtimeDisplayName);
  setPlistValue(plist, 'CFBundleIconFile', 'Codeex.icns');
  await copyFile(productIcon, path.join(cloneResources, 'Codeex.icns'));

  const asarHash = await sha256(path.join(cloneResources, 'app.asar'));
  run('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${asarHash}`,
    plist,
  ]);

  await rm(upstreamApp, { recursive: true, force: true });
  await rename(stageApp, upstreamApp);
  await rm(cloneApp, { recursive: true, force: true });
  await rename(stageClone, cloneApp);
  await writeFile(
    prepareStamp,
    `${JSON.stringify({ fingerprint, asarHash, unpackRoots }, null, 2)}\n`,
  );
  console.log(`✓ Prepared Codex ${fingerprint.version} (${fingerprint.buildFlavor})`);
}

prepare().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
