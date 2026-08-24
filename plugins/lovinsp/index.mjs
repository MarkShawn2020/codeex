import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { instrumentProductionCode } from '../../scripts/instrument-production-bundle.mjs';

export async function transformWebview(context) {
  await readFile(context.lovinspClient);
  const jsFiles = await context.filesBelow(context.stage, '.js');
  let transformedFiles = 0;
  let sourceMarkers = 0;
  for (const target of jsFiles) {
    const code = await readFile(target, 'utf8');
    const sourceTarget = path.join(context.sourceWebview, path.relative(context.stage, target));
    const result = instrumentProductionCode(code, sourceTarget);
    if (result.count === 0) continue;
    await writeFile(target, result.code);
    transformedFiles += 1;
    sourceMarkers += result.count;
  }
  const [rawBridgeCode, entryCode] = await Promise.all([
    readFile(context.lovinspClient, 'utf8'),
    readFile(context.entryFile, 'utf8'),
  ]);
  const bridgeCode = rawBridgeCode.replace(
    /export default ([^;]+);\s*$/,
    '$1;',
  );
  if (/\b(?:import|export)\s/.test(bridgeCode)) {
    throw new Error('Lovinsp bridge still contains ESM declarations and cannot be scoped safely.');
  }
  await writeFile(context.entryFile, `(() => {\n${bridgeCode}\n})();\n${entryCode}`);
  return { transformedFiles, sourceMarkers };
}
