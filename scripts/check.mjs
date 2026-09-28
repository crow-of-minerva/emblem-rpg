/**
 * Load every system module in plain Node and fail on errors that would stop Foundry from loading the system:
 * syntax errors, imports of names a file doesn't export, and imports of files that don't exist.
 * Errors from Foundry globals (game, CONFIG, foundry...) that don't exist outside Foundry are expected and ignored.
 * Run with: node scripts/check.mjs
 */
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'packs', 'scripts']);

function* moduleFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* moduleFiles(join(dir, entry.name));
    } else if (entry.name.endsWith('.mjs')) yield join(dir, entry.name);
  }
}

/** Errors that mean the module graph itself is broken, not that Foundry is missing. */
function isLoadFailure(error) {
  return error instanceof SyntaxError || error?.code === 'ERR_MODULE_NOT_FOUND';
}

const failures = new Map();
let checked = 0;
for (const file of moduleFiles(ROOT)) {
  checked++;
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    if (!isLoadFailure(error)) continue;
    // One broken file fails every file that imports it; report each distinct error once.
    const message = String(error.message).split('\n')[0];
    if (!failures.has(message)) failures.set(message, relative(ROOT, file));
  }
}

for (const [message, file] of failures) console.error(`✗ ${file}\n    ${message}`);
console.log(`${checked} modules checked, ${failures.size} load error(s).`);
process.exitCode = failures.size ? 1 : 0;
