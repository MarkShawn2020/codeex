import { spawnSync } from 'node:child_process';

const developerIdPattern = /^\s*\d+\)\s+([A-F0-9]{40})\s+"(Developer ID Application:[^"]+)"/gm;

export function parseDeveloperIdIdentities(output) {
  return [...String(output || '').matchAll(developerIdPattern)].map((match) => ({
    hash: match[1],
    label: match[2],
  }));
}

function discoverDeveloperIdIdentities() {
  const result = spawnSync(
    '/usr/bin/security',
    ['find-identity', '-v', '-p', 'codesigning'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return [];
  return parseDeveloperIdIdentities(`${result.stdout}\n${result.stderr}`);
}

export function resolveCodeSigningIdentity({
  env = process.env,
  discoveredIdentities,
} = {}) {
  const configured = env.CODEEX_SIGN_IDENTITY?.trim();
  if (configured) {
    if (configured === '-' || configured.toLowerCase() === 'adhoc') {
      return {
        identity: '-',
        label: 'ad-hoc',
        stable: false,
        source: 'CODEEX_SIGN_IDENTITY',
      };
    }
    return {
      identity: configured,
      label: configured,
      stable: true,
      source: 'CODEEX_SIGN_IDENTITY',
    };
  }

  const identities = discoveredIdentities || discoverDeveloperIdIdentities();
  if (identities.length === 1) {
    return {
      identity: identities[0].hash,
      label: identities[0].label,
      stable: true,
      source: 'keychain',
    };
  }
  if (identities.length > 1) {
    throw new Error(
      'Multiple Developer ID Application identities are available. Set CODEEX_SIGN_IDENTITY to the intended certificate hash or label.',
    );
  }
  if (env.CODEEX_REQUIRE_STABLE_SIGNATURE === '1') {
    throw new Error(
      'Codeex requires a stable signature, but no Developer ID Application identity is available.',
    );
  }
  return {
    identity: '-',
    label: 'ad-hoc',
    stable: false,
    source: 'fallback',
  };
}

export function signApplication(target, {
  env = process.env,
  plan = resolveCodeSigningIdentity({ env }),
  deep = true,
  hardenedRuntime = false,
  entitlements,
} = {}) {
  const args = ['--force'];
  if (deep) args.push('--deep');
  args.push('--sign', plan.identity);
  if (plan.stable && env.CODEEX_SIGN_TIMESTAMP !== '1') {
    args.push('--timestamp=none');
  }
  if (hardenedRuntime) args.push('--options', 'runtime');
  if (entitlements) args.push('--entitlements', entitlements);
  // Let each bundle's Info.plist or Mach-O retain its own identifier. Passing
  // one outer --identifier through --deep collapses Renderer, Service, and
  // runtime helpers onto the same identity and makes TCC grants brittle.
  args.push(target);
  const result = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(
      `/usr/bin/codesign failed (${result.status})${detail ? `\n${detail}` : ''}`,
    );
  }
  return plan;
}

export function readCodeSignature(target) {
  const result = spawnSync('/usr/bin/codesign', ['-dvvv', target], {
    encoding: 'utf8',
  });
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    valid: result.status === 0,
    adHoc: /\bSignature=adhoc\b/.test(output),
    teamIdentifier: output.match(/^TeamIdentifier=(.+)$/m)?.[1] || null,
    authority: output.match(/^Authority=(.+)$/m)?.[1] || null,
  };
}
