import { spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { preparedCloneApp as cloneApp, productIcon, projectRoot } from './paths.mjs';
import { signApplication } from './code-signing.mjs';

const installRoot = path.resolve(process.env.CODEEX_INSTALL_DIR || '/Applications');
const destination = path.join(installRoot, 'Codeex.app');
const stage = path.join(installRoot, `.Codeex-next-${process.pid}.app`);
const launcherSource = path.join(projectRoot, 'launcher', 'main.swift');

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} failed (${result.status})${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout.trim();
}

async function main() {
  if (!(await exists(cloneApp))) throw new Error('Build Codeex before installing it.');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', cloneApp]);
  const pnpmPath = run('/usr/bin/which', ['pnpm']);
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));

  await rm(stage, { recursive: true, force: true });
  run('/usr/bin/ditto', [cloneApp, stage]);
  const contents = path.join(stage, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  const upstreamExecutable = path.join(macos, 'ChatGPT');
  const runtimeExecutable = path.join(macos, 'CodeexRuntime');
  if (!(await exists(upstreamExecutable))) {
    throw new Error('The prepared Codex executable is missing from the installation input.');
  }
  await rename(upstreamExecutable, runtimeExecutable);
  await copyFile(productIcon, path.join(resources, 'Codeex.icns'));
  run('/usr/bin/xcrun', [
    'swiftc',
    launcherSource,
    '-framework',
    'AppKit',
    '-framework',
    'WebKit',
    '-o',
    path.join(macos, 'Codeex'),
  ]);
  const plist = path.join(contents, 'Info.plist');
  const setPlistString = (key, value) => {
    const existing = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
    if (existing.status !== 0) run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist]);
  };
  setPlistString('CFBundleDisplayName', 'Codeex');
  setPlistString('CFBundleExecutable', 'Codeex');
  setPlistString('CFBundleIconFile', 'Codeex.icns');
  setPlistString('CFBundleIdentifier', 'ai.lovstudio.codeex');
  setPlistString('CFBundleName', 'Codeex');
  setPlistString('CFBundleShortVersionString', packageJson.version);
  setPlistString('CFBundleVersion', packageJson.version);
  setPlistString('CodeexProjectRoot', projectRoot);
  setPlistString('CodeexNodePath', process.execPath);
  setPlistString('CodeexPnpmPath', pnpmPath);
  setPlistString('CodeexRuntimeMode', 'embedded');
  const signing = signApplication(stage);
  console.log(
    signing.stable
      ? `  Stable macOS identity: ${signing.label}`
      : '  Warning: ad-hoc signing cannot retain macOS folder permissions across rebuilds.',
  );

  if (await exists(destination)) {
    const trashDirectory = path.join(os.homedir(), '.Trash', 'codeex-app-replacements');
    await mkdir(trashDirectory, { recursive: true });
    const backup = path.join(trashDirectory, `Codeex-${Date.now()}.app`);
    await rename(destination, backup);
    console.log(`  Previous Codeex app moved to ${backup}`);
  }
  await rename(stage, destination);
  const launchServices = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  run(launchServices, ['-f', destination]);
  if (installRoot !== '/Applications') {
    console.log(`✓ Built signed single-surface Codeex at ${destination}`);
    return;
  }
  run('/usr/bin/mdimport', ['-i', destination]);
  run('/usr/bin/open', ['-Ra', 'Codeex']);
  let spotlightPath = '';
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const query = spawnSync(
      '/usr/bin/mdfind',
      ['kMDItemCFBundleIdentifier == "ai.lovstudio.codeex"'],
      { encoding: 'utf8' },
    );
    spotlightPath = query.status === 0 ? query.stdout.trim() : '';
    if (spotlightPath.split('\n').includes(destination)) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!spotlightPath.split('\n').includes(destination)) {
    throw new Error('Codeex was registered with LaunchServices but Spotlight did not index it.');
  }
  console.log(`✓ Installed searchable single-surface Codeex at ${destination}`);
}

main().catch(async (error) => {
  await rm(stage, { recursive: true, force: true });
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
