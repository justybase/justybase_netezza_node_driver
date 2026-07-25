/**
 * Post-build for dual ESM+CJS package:
 * - Write dist/esm/package.json with {"type":"module"}
 * - Rewrite relative import/export specifiers to include .js extensions
 * - Convert leftover require('debug') calls to ESM imports when needed
 */
const fs = require('fs');
const path = require('path');

const esmRoot = path.join(__dirname, '..', 'dist', 'esm');

fs.writeFileSync(
  path.join(esmRoot, 'package.json'),
  JSON.stringify({ type: 'module' }, null, 2) + '\n'
);

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  if (spec.endsWith('.js') || spec.endsWith('.json') || spec.endsWith('.node')) {
    return null;
  }
  const base = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(base + '.js')) return spec + '.js';
  if (fs.existsSync(path.join(base, 'index.js'))) return spec + '/index.js';
  return spec + '.js';
}

function rewriteFile(filePath) {
  let source = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  const rewritten = source.replace(
    /\b(from|import)\s*\(?\s*(['"])(\.[^'"]+)\2/g,
    (match, keyword, quote, spec) => {
      const next = resolveSpecifier(filePath, spec);
      if (!next) return match;
      changed = true;
      return match.replace(spec, next);
    }
  );
  source = rewritten;

  // export ... from './x'
  source = source.replace(
    /\bexport\s+[\s\S]*?\bfrom\s*(['"])(\.[^'"]+)\1/g,
    (match) => {
      return match.replace(/(['"])(\.[^'"]+)\1/g, (m, quote, spec) => {
        const next = resolveSpecifier(filePath, spec);
        if (!next) return m;
        changed = true;
        return `${quote}${next}${quote}`;
      });
    }
  );

  // Common leftover: const debug = require('debug')('ns');
  if (/\brequire\s*\(\s*['"]debug['"]\s*\)/.test(source)) {
    source = source.replace(
      /const\s+(\w+)\s*=\s*require\s*\(\s*['"]debug['"]\s*\)\s*\((['"])([^'"]+)\2\)\s*;?/g,
      (match, name, q, ns) => {
        changed = true;
        return `import createDebug from 'debug';\nconst ${name} = createDebug(${q}${ns}${q});`;
      }
    );
  }

  if (changed) {
    fs.writeFileSync(filePath, source);
  }
}

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.js')) rewriteFile(p);
  }
}

if (!fs.existsSync(esmRoot)) {
  console.error('dist/esm not found; run tsc -p tsconfig.esm.json first');
  process.exit(1);
}

walk(esmRoot);
console.log('Wrote dist/esm/package.json and rewrote ESM relative imports');
