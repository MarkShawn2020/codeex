import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  launcherDist,
  officialApp,
  productIcon,
  projectRoot,
} from './paths.mjs';
import {
  resolveCodeSigningIdentity,
  signApplication,
} from './code-signing.mjs';
import { launcherInfoPlist } from './launcher-plist.mjs';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
    env: options.env || process.env,
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} failed (${result.status})${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout?.trim() || '';
}

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

async function sha256(target) {
  const hash = createHash('sha256');
  hash.update(await readFile(target));
  return hash.digest('hex');
}

async function copyDirectory(source, destination) {
  if (!(await exists(source))) throw new Error(`Release input is missing: ${source}`);
  await mkdir(path.dirname(destination), { recursive: true });
  run('/usr/bin/ditto', [source, destination]);
}

async function filesBelow(root) {
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) result.push(target);
    }
  }
  return result;
}

async function isMachO(target) {
  const handle = await import('node:fs/promises').then(({ open }) => open(target, 'r'));
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    if (bytesRead !== 4) return false;
    return new Set([
      'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe',
      'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca',
    ]).has(header.toString('hex'));
  } finally {
    await handle.close();
  }
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const version = packageJson.version;
  const releaseRoot = path.join(projectRoot, '.release');
  const app = path.join(releaseRoot, 'Codeex.app');
  const contents = path.join(app, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  const embeddedRoot = path.join(resources, 'codeex-runtime');
  const nodeExecutable = path.join(resources, 'node', 'bin', 'node');
  const dmgRoot = path.join(releaseRoot, 'dmg-root');
  const dmg = path.join(releaseRoot, `Codeex-${version}-arm64.dmg`);
  const checksums = path.join(releaseRoot, 'SHA256SUMS.txt');
  const manifest = path.join(releaseRoot, 'release-manifest.json');
  const nodeEntitlements = path.join(releaseRoot, 'node-entitlements.plist');
  const officialNode = path.join(officialApp, 'Contents', 'Resources', 'cua_node', 'bin', 'node');
  const officialNodeLicense = path.join(officialApp, 'Contents', 'Resources', 'cua_node', 'LICENSE');

  if (!(await exists(officialNode))) {
    throw new Error(`The official Codex bundled Node runtime is missing: ${officialNode}`);
  }
  if (!(await exists(launcherDist))) {
    throw new Error('Build the Codeex plugin center before packaging the release.');
  }
  const signingPlan = resolveCodeSigningIdentity();
  if (!signingPlan.stable) {
    throw new Error('A public Codeex release requires a stable Developer ID Application identity.');
  }
  const signingEnv = { ...process.env, CODEEX_SIGN_TIMESTAMP: '1' };

  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(macos, { recursive: true });
  await mkdir(resources, { recursive: true });
  await mkdir(path.dirname(nodeExecutable), { recursive: true });

  run('/usr/bin/xcrun', [
    'swiftc',
    '-O',
    path.join(projectRoot, 'launcher', 'main.swift'),
    '-framework',
    'AppKit',
    '-framework',
    'WebKit',
    '-o',
    path.join(macos, 'Codeex'),
  ]);
  await copyFile(productIcon, path.join(resources, 'Codeex.icns'));
  await copyFile(officialNode, nodeExecutable);
  await chmod(nodeExecutable, 0o755);
  await copyFile(officialNodeLicense, path.join(resources, 'node', 'LICENSE'));

  for (const directory of ['scripts', 'plugins', 'bridge', 'assets', 'node_modules']) {
    await copyDirectory(path.join(projectRoot, directory), path.join(embeddedRoot, directory));
  }
  await copyDirectory(launcherDist, path.join(embeddedRoot, 'launcher-ui'));
  for (const file of ['package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'README.md']) {
    await mkdir(embeddedRoot, { recursive: true });
    await copyFile(path.join(projectRoot, file), path.join(embeddedRoot, file));
  }

  await writeFile(
    path.join(contents, 'Info.plist'),
    launcherInfoPlist({
      version,
      nodePath: '@bundle/Contents/Resources/node/bin/node',
      projectRoot: '@bundle/Contents/Resources/codeex-runtime',
    }),
  );
  await writeFile(nodeEntitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
`);

  const nestedMachO = [];
  for (const target of await filesBelow(resources)) {
    if (await isMachO(target)) nestedMachO.push(target);
  }
  for (const target of nestedMachO.sort()) {
    signApplication(target, {
      env: signingEnv,
      plan: signingPlan,
      deep: false,
      hardenedRuntime: true,
      ...(target === nodeExecutable ? { entitlements: nodeEntitlements } : {}),
    });
  }
  signApplication(app, {
    env: signingEnv,
    plan: signingPlan,
    deep: false,
    hardenedRuntime: true,
  });
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);

  await mkdir(dmgRoot, { recursive: true });
  await copyDirectory(app, path.join(dmgRoot, 'Codeex.app'));
  await symlink('/Applications', path.join(dmgRoot, 'Applications'));
  run('/usr/bin/hdiutil', [
    'create',
    '-volname',
    'Codeex',
    '-srcfolder',
    dmgRoot,
    '-ov',
    '-format',
    'UDZO',
    dmg,
  ], { inherit: true });
  signApplication(dmg, {
    env: signingEnv,
    plan: signingPlan,
    deep: false,
  });

  const digest = await sha256(dmg);
  const size = (await stat(dmg)).size;
  await writeFile(checksums, `${digest}  ${path.basename(dmg)}\n`);
  await writeFile(manifest, `${JSON.stringify({
    schemaVersion: 1,
    product: 'Codeex',
    version,
    architecture: 'arm64',
    minimumSystemVersion: '13.0',
    app,
    dmg,
    dmgBytes: size,
    dmgSha256: digest,
    signingIdentity: signingPlan.label,
    includesOfficialCodexBinary: false,
    requiresOfficialCodexAtRuntime: true,
    nestedMachOFiles: nestedMachO.length,
  }, null, 2)}\n`);
  console.log(`✓ Built Codeex ${version} release (${size} bytes; sha256 ${digest})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
