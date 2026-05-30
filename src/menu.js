import { stdin, stdout } from 'node:process';

export async function pick(items, { title, startIn } = {}) {
  const termWidth = stdout.columns || 80;
  const termHeight = stdout.rows || 24;
  let tree = [{ label: title || 'Menu', children: items, back: false }];
  let cursor = 0;

  // Pre-navigate to a category if specified
  if (startIn) {
    const idx = items.findIndex(item =>
      typeof item === 'object' && item.label && item.label.toLowerCase() === startIn.toLowerCase()
    );
    if (idx !== -1) {
      cursor = idx;
      const item = items[idx];
      if (item.children) {
        // Find the "current" item (has ✓ or (current)) to set cursor on it
        const cur = item.children.findIndex(c => {
          const label = typeof c === 'string' ? c : c.label;
          return label.includes('(current)') || label.includes('\u2713');
        });
        tree.push({ label: item.label, children: item.children, back: true });
        cursor = cur !== -1 ? cur : 0;
      }
    }
  }
  let resolvePromise;
  const wasRaw = stdin.isRaw;
  let partial = '';
  let escapeTimer = null;
  let rawOk = false;
  let done = false;
  let dataHandler = null;

  try {
    stdin.setRawMode(true);
    stdin.resume();
    rawOk = true;
  } catch {}

  function current() { return tree[tree.length - 1]; }

  function render() {
    const items = current().children;
    const maxVisible = Math.min(items.length, termHeight - 5);
    const start = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), Math.max(0, items.length - maxVisible)));

    let out = '\x1b[0;0H\x1b[J';
    if (tree.length > 1) {
      out += `\x1b[90m╭─ ${tree.map(t => t.label).join(' / ')}\x1b[0m\n`;
    } else {
      out += `\x1b[36m╭─ ${title || 'Menu'}\x1b[0m\n`;
    }

    const visible = items.slice(start, start + maxVisible);
    for (let i = 0; i < maxVisible; i++) {
      const idx = start + i;
      if (idx >= items.length) break;
      const item = items[idx];
      const isSel = idx === cursor;
      const isCat = typeof item === 'object' && item !== null && item.children;
      const cursorChar = isSel ? '\x1b[36m❯' : ' ';
      const style = isSel ? '\x1b[7m' : '';
      const reset = isSel ? '\x1b[0m' : '';
      let label = typeof item === 'string' ? item : item.label;
      if (isCat && !isSel) label = `\x1b[90m${label}\x1b[0m`;
      const suffix = isCat ? `  \x1b[90m(${item.children.length})\x1b[0m` : '';
      const display = (label + suffix).length > termWidth - 4
        ? (label + suffix).slice(0, termWidth - 8) + '\u2026'
        : label + suffix;
      out += `${cursorChar} ${style}${display.padEnd(termWidth - 4)}${reset}\n`;
    }

    out += `\x1b[90m╰ ${tree.length > 1 ? '\u2190 Esc/BS back' : 'Esc/BS exit'}  \u2191\u2193 nav  \u23ce select\x1b[0m`;
    stdout.write(out);
  }

  function cleanup() {
    if (done) return;
    done = true;
    clearTimeout(escapeTimer);
    if (rawOk) {
      try { stdin.setRawMode(!!wasRaw); } catch {}
    }
    try { if (dataHandler) stdin.removeListener('data', dataHandler); } catch {}
    stdout.write('\x1b[0;0H\x1b[J');
  }

  function finish(val) {
    cleanup();
    resolvePromise(val);
  }

  function enter() {
    const items = current().children;
    if (cursor >= items.length) return;
    const item = items[cursor];
    if (typeof item === 'object' && item !== null && item.children) {
      tree.push({ label: item.label, children: item.children, back: true });
      cursor = 0;
      render();
    } else {
      finish(typeof item === 'string' ? item : item.value);
    }
  }

  function back() {
    if (tree.length > 1) {
      tree.pop();
      cursor = 0;
      render();
    } else {
      finish(null);
    }
  }

  function onData(chunk) {
    if (done) return;
    partial += chunk.toString();

    while (partial.length > 0) {
      const ch = partial[0];

      if (ch === '\x1b') {
        if (partial.length >= 3 && (partial[1] === '[' || partial[1] === 'O')) {
          clearTimeout(escapeTimer);
          const c = partial[2];
          partial = partial.slice(3);
          const items = current().children;
          if (c === 'A' && cursor > 0) cursor--;
          else if (c === 'B' && cursor < items.length - 1) cursor++;
          render();
          continue;
        }
        if (partial.length === 1 && !escapeTimer) {
          escapeTimer = setTimeout(() => {
            clearTimeout(escapeTimer);
            escapeTimer = null;
            partial = '';
            finish(null);
          }, 350);
          break;
        }
        clearTimeout(escapeTimer);
        partial = partial.slice(1);
        finish(null);
        return;
      }

      clearTimeout(escapeTimer);

      if (ch === '\r' || ch === '\n') {
        partial = partial.slice(1);
        enter();
        return;
      }

      if (ch === '\x7f' || ch === '\b') {
        partial = partial.slice(1);
        back();
        return;
      }

      if (ch === '\x03') process.exit(0);
      partial = partial.slice(1);
    }
  }

  if (rawOk) {
    dataHandler = onData;
    stdin.on('data', dataHandler);
  } else {
    dataHandler = function onDataCooked(chunk) {
      if (done) return;
      const s = chunk.toString().replace(/[\r\n]/g, '').trim();
      if (s === '') { enter(); return; }
      const num = parseInt(s, 10);
      if (!isNaN(num) && num >= 1 && num <= current().children.length) {
        const item = current().children[num - 1];
        if (typeof item === 'object' && item !== null && item.children) {
          tree.push({ label: item.label, children: item.children, back: true });
          cursor = 0;
          render();
        } else {
          finish(typeof item === 'string' ? item : item.value);
        }
      }
    };
    stdin.on('data', dataHandler);
  }

  render();

  return new Promise(resolve => { resolvePromise = resolve; });
}
