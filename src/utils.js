import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export function globSync(pattern, root = '.') {
  const parts = pattern.split('/');
  const hasRecursive = parts[0] === '**';
  const filePattern = parts[hasRecursive ? 1 : 0] || parts[0];
  const subPattern = parts.slice(hasRecursive ? 2 : 1).join('/');

  const results = [];

  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }

      const rel = relative(root, full);

      if (hasRecursive && stat.isDirectory()) {
        walk(full);
      }

      if (filePattern === '**') {
        results.push(rel);
        if (stat.isDirectory()) walk(full);
      } else if (filePattern.includes('*')) {
        const re = new RegExp('^' + filePattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        if (re.test(entry)) {
          results.push(rel);
        }
      } else if (entry === filePattern) {
        results.push(rel);
      }

      if (subPattern && stat.isDirectory()) {
        const subRoot = join(root, entry);
        const subResults = globSync(subPattern, subRoot);
        for (const r of subResults) {
          results.push(join(entry, r));
        }
      }
    }
  }

  walk(root);
  return results;
}
