import { parse } from '@babel/parser';
import MagicString from 'magic-string';

function memberName(node) {
  if (!node || node.type !== 'MemberExpression') return null;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.computed && node.property.type === 'StringLiteral') return node.property.value;
  return null;
}

function unwrapCallee(node) {
  let current = node;
  while (current?.type === 'ParenthesizedExpression') current = current.expression;
  if (current?.type === 'SequenceExpression') {
    current = current.expressions.at(-1);
  }
  return current;
}

function domTag(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value?.cooked || null;
  }
  return null;
}

function hasInspectorPath(objectExpression) {
  return objectExpression.properties.some((property) => {
    if (property.type !== 'ObjectProperty') return false;
    if (property.key.type === 'StringLiteral') return property.key.value === 'data-insp-path';
    return property.key.type === 'Identifier' && property.key.name === 'data-insp-path';
  });
}

function walk(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (typeof node.type === 'string') visit(node);
    for (const [key, value] of Object.entries(node)) {
      if (
        key === 'loc' ||
        key === 'start' ||
        key === 'end' ||
        key.endsWith('Comments') ||
        key === 'errors'
      ) {
        continue;
      }
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index -= 1) {
          stack.push(value[index]);
        }
      } else if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }
}

export function instrumentProductionCode(code, id) {
  const cleanId = id.split('?', 1)[0];
  if (!cleanId.endsWith('.js') || !/\.(?:jsx|jsxs)\)\(/.test(code)) {
    return { code, count: 0 };
  }

  let ast;
  try {
    ast = parse(code, {
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      errorRecovery: true,
      plugins: ['importAttributes', 'topLevelAwait'],
    });
  } catch {
    return { code, count: 0 };
  }

  const output = new MagicString(code);
  let count = 0;
  walk(ast, (node) => {
    if (node.type !== 'CallExpression' || node.arguments.length < 2) return;
    const callee = unwrapCallee(node.callee);
    const name = memberName(callee);
    if (name !== 'jsx' && name !== 'jsxs') return;

    const tag = domTag(node.arguments[0]);
    const props = node.arguments[1];
    if (!tag || !/^[a-z][\w:.-]*$/.test(tag)) return;
    if (props?.type !== 'ObjectExpression' || hasInspectorPath(props)) return;
    if (!node.loc || typeof props.start !== 'number') return;

    const location = `${cleanId}:${node.loc.start.line}:${node.loc.start.column + 1}:${tag}`;
    output.appendLeft(
      props.start + 1,
      `${JSON.stringify('data-insp-path')}:${JSON.stringify(location)},`,
    );
    count += 1;
  });

  return { code: count > 0 ? output.toString() : code, count };
}

export function productionBundleSourcePlugin() {
  let transformedFiles = 0;
  let instrumentedNodes = 0;
  return {
    name: 'codex-production-bundle-source-locations',
    enforce: 'pre',
    buildStart() {
      transformedFiles = 0;
      instrumentedNodes = 0;
    },
    transform(code, id) {
      const { code: transformed, count } = instrumentProductionCode(code, id);
      if (count === 0) return null;
      transformedFiles += 1;
      instrumentedNodes += count;
      return { code: transformed, map: null };
    },
    buildEnd(error) {
      if (!error) {
        console.log(
          `✓ Lovinsp source metadata injected into ${instrumentedNodes} DOM nodes across ${transformedFiles} production chunks`,
        );
      }
    },
  };
}
