#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { stdin, stdout, env } from 'node:process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pick } from './menu.js';
import { Agent } from './agent.js';

const API_BASE = env.KISARAGI_API_BASE || 'https://oreo.gleeze.com';
const PROVIDERS = {
  openrouter: '/api/openrouter',
  openai: '/api/openai',
  groq: '/api/groq',
  workers: '/api/workers',
  puter: '/api/puter',
  opencode: 'direct:https://opencode.ai/zen/v1/chat/completions',
};
const PROVIDER_NAMES = Object.keys(PROVIDERS);

let provider = env.KISARAGI_PROVIDER || 'openrouter';
let MODEL = env.KISARAGI_MODEL || 'openrouter/free';

let OPENCODE_API_KEY = env.KISARAGI_OPENCODE_API_KEY || '';

function apiUrl() {
  const p = PROVIDERS[provider];
  if (p && p.startsWith('direct:')) return p.slice(7);
  return API_BASE + p;
}

const agent = new Agent(apiUrl(), MODEL, { apiKey: OPENCODE_API_KEY });

agent.onWriteConfirm = async (path, oldContent, newContent) => {
  if (!stdin.isTTY) return true;
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const max = Math.min(Math.max(oldLines.length, newLines.length), 20);
  process.stdout.write(`  ${C.yellow}Overwrite ${path}?${C.reset}\n`);
  for (let i = 0; i < max; i++) {
    if (i < oldLines.length && i < newLines.length && oldLines[i] !== newLines[i]) {
      process.stdout.write(`  ${C.red}−${C.reset} ${oldLines[i]}\n`);
      process.stdout.write(`  ${C.green}+${C.reset} ${newLines[i]}\n`);
    } else if (i < oldLines.length) {
      process.stdout.write(`  ${C.red}−${C.reset} ${oldLines[i]}\n`);
    } else if (i < newLines.length) {
      process.stdout.write(`  ${C.green}+${C.reset} ${newLines[i]}\n`);
    }
  }
  if (oldLines.length > 20 || newLines.length > 20) {
    process.stdout.write(`  ${C.gray}... (${oldLines.length} → ${newLines.length} lines)${C.reset}\n`);
  }
  return new Promise(resolve => {
    process.stdout.write(`  ${C.yellow}Overwrite?${C.reset} ${C.gray}(y/N)${C.reset} `);
    const wasRaw = stdin.isRaw;
    try { stdin.setRawMode(true); stdin.resume(); } catch {}
    const onData = (chunk) => {
      const ch = chunk.toString()[0];
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(!!wasRaw); } catch {}
      if (ch === 'y' || ch === 'Y') {
        process.stdout.write('y\n');
        resolve(true);
      } else {
        process.stdout.write('n\n');
        resolve(false);
      }
      if (ch === '\x03') process.exit(0);
    };
    stdin.on('data', onData);
  });
};

// ── askUser: interactive prompt for AI questions ──
// Uses currentRL.question() to avoid stdin conflicts.
// question() sets _questionCallback which intercepts input BEFORE the
// 'line' event fires, preventing duplicate concurrent agent.send() calls.
agent.onAskUser = async (questions) => {
  if (!stdin.isTTY) {
    return { answers: questions.map(() => null) };
  }
  const answers = [];
  const rl = currentRL;

  for (const q of questions) {
    const multi = q.multiSelect;

    // Print question & options
    console.log(`  ${C.yellow}?${C.reset} ${C.bold}${q.question}${C.reset}`);
    q.options.forEach((o, i) => {
      // Strip leading numbers from AI-generated labels to avoid double-numbering
      const label = o.label.replace(/^\d+[\.\)]?\s*-?\s*/, '').trim() || o.label;
      console.log(`  ${C.cyan}${i + 1}.${C.reset} ${label}${o.description ? C.gray + ' - ' + o.description + C.reset : ''}`);
    });

    const promptLabel = multi
      ? `  ${C.gray}Enter numbers (comma/space separated, empty to skip):${C.reset} `
      : `  ${C.gray}Enter number or custom answer (empty to skip):${C.reset} `;

    // Use currentRL.question() if available — prevents 'line' event from firing
    let input = '';
    if (rl && !rl.closed) {
      input = await new Promise(resolve => {
        rl.question(promptLabel, answer => resolve(answer || ''));
      });
    } else {
      // Fallback: use raw mode (shouldn't normally happen)
      input = await new Promise(resolve => {
        const wasRaw = stdin.isRaw;
        try { stdin.setRawMode(true); stdin.resume(); } catch {}
        process.stdout.write(promptLabel);
        let buf = '';
        const onData = (chunk) => {
          const s = chunk.toString();
          for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch === '\x03') process.exit(0);
            if (ch === '\r' || ch === '\n') {
              stdin.removeListener('data', onData);
              try { stdin.setRawMode(!!wasRaw); } catch {}
              process.stdout.write('\n');
              resolve(buf);
              return;
            }
            if (ch === '\x7f' || ch === '\b') {
              if (buf.length > 0) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
              continue;
            }
            if (ch === '\x1b') {
              if (i + 1 < s.length && s[i + 1] === '[') { i += 2; while (i < s.length) { const c = s.charCodeAt(i); if (c >= 0x40 && c <= 0x7E) break; i++; } }
              else if (i + 1 < s.length && s[i + 1] === 'O') { i += 2; }
              else { stdin.removeListener('data', onData); try { stdin.setRawMode(!!wasRaw); } catch {} process.stdout.write('\n'); resolve(''); return; }
              continue;
            }
            if (ch.length === 1 && ch >= ' ') { buf += ch; process.stdout.write(ch); }
          }
        };
        stdin.on('data', onData);
      });
    }

    if (!input.trim()) {
      answers.push(null);
      console.log(`  ${C.gray}→ skipped${C.reset}`);
      continue;
    }

    if (multi) {
      const nums = input.split(/[\s,]+/).map(s => parseInt(s, 10)).filter(n => n >= 1 && n <= q.options.length);
      const chosen = [...new Set(nums)].sort((a,b)=>a-b).map(i => q.options[i-1].label);
      if (chosen.length > 0) {
        answers.push(chosen);
        console.log(`  ${C.gray}→ ${chosen.join(', ')}${C.reset}`);
      } else {
        answers.push(null);
        console.log(`  ${C.gray}→ skipped${C.reset}`);
      }
    } else {
      const num = parseInt(input.trim(), 10);
      if (num >= 1 && num <= q.options.length) {
        answers.push(q.options[num - 1].label);
        console.log(`  ${C.gray}→ ${q.options[num - 1].label}${C.reset}`);
      } else {
        answers.push(input.trim());
        console.log(`  ${C.gray}→ ${input.trim()}${C.reset}`);
      }
    }
  }

  return { answers };
};

agent.onWriteTodos = (todos) => {
  if (todos.length === 0) return;
  statusClear();
  const done = todos.filter(t => t.completed).length;
  const total = todos.length;
  const header = `  ${C.cyan}${'='.repeat(3)} Todos (${done}/${total}) ${'='.repeat(3)}${C.reset}`;
  const footer = `  ${C.cyan}${'='.repeat(Math.max(10, header.length - 6))}${C.reset}`;
  console.log(`\n${header}`);
  for (const t of todos) {
    const icon = t.completed ? `${C.green}✓${C.reset}` : `${C.gray}○${C.reset}`;
    const text = t.completed ? `${C.dim}${t.task}${C.reset}` : t.task;
    console.log(`  ${icon} ${text}`);
  }
  console.log(`${footer}\n`);
};

agent.onSuggestFollowups = (followups) => {
  if (followups.length === 0) return;
  statusClear();
  console.log(`\n  ${C.gray}─${'─'.repeat(30)}${C.reset}`);
  console.log(`  ${C.dim}Next steps:${C.reset}`);
  for (const f of followups) {
    console.log(`  ${C.cyan}›${C.reset} ${C.gray}${f.label || f.prompt}${C.reset}`);
  }
  console.log();
};

agent.onRenderUi = (widget) => {
  if (widget.type === 'button') {
    statusClear();
    const variant = widget.variant === 'primary' ? C.cyan : C.gray;
    console.log(`\n  ${variant}┌─ ${widget.text} ${'─'.repeat(Math.max(0, 20 - widget.text.length))}┐${C.reset}`);
    console.log(`  ${variant}│ ${widget.link}${' '.repeat(Math.max(0, 22 - widget.link.length))}│${C.reset}`);
    console.log(`  ${variant}└${'─'.repeat(22)}┘${C.reset}\n`);
  }
};

const FREE_OPENCODE_MODELS = [
  'deepseek-v4-flash-free',
  'mimo-v2.5-free',
  'nemotron-3-super-free',
  'big-pickle',
];

async function fetchModels() {
  try {
    if (provider === 'opencode') {
      // Try fetching from models endpoint to verify connectivity
      try {
        const res = await fetch('https://opencode.ai/zen/v1/models', {
          headers: OPENCODE_API_KEY ? { 'Authorization': `Bearer ${OPENCODE_API_KEY}` } : {}
        });
        if (res.ok) {
          const data = await res.json();
          const all = data?.data || [];
          if (all.length > 0) {
          // Return known free models that the API recognizes
          // Filter: models ending with "-free" OR in our hardcoded list
          const apiFree = all
            .filter(m => m.id && (m.id.endsWith('-free') || FREE_OPENCODE_MODELS.includes(m.id)))
            .map(m => m.id);
          if (apiFree.length > 0) return apiFree;
          }
        }
      } catch {}
      // Fallback: hardcoded free model list
      return [...FREE_OPENCODE_MODELS];
    }
    const res = await fetch(apiUrl() + '?check_models=true');
    if (!res.ok) return null;
    const text = await res.text();
    try { return JSON.parse(text).supported_models; } catch { return null; }
  } catch { return null; }
}

let models = await fetchModels();

// ── Persisted config (provider/model survive restarts) ──
const CONFIG_PATH = join(homedir(), '.kisaragi', 'config.json');

function loadPersistedConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return;
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    if (!env.KISARAGI_PROVIDER && cfg.provider && PROVIDERS[cfg.provider]) provider = cfg.provider;
    if (!env.KISARAGI_MODEL && cfg.model) MODEL = cfg.model;
    // Load persisted API key only if env var not set
    if (!env.KISARAGI_OPENCODE_API_KEY && cfg.opencodeApiKey) OPENCODE_API_KEY = cfg.opencodeApiKey;
  } catch {}
}

function savePersistedConfig() {
  try {
    const dir = join(homedir(), '.kisaragi');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const cfg = existsSync(CONFIG_PATH)
      ? JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
      : {};
    cfg.provider = provider;
    cfg.model = MODEL;
    if (OPENCODE_API_KEY) cfg.opencodeApiKey = OPENCODE_API_KEY;
    else delete cfg.opencodeApiKey;
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg), 'utf-8');
  } catch {}
}

function deletePersistedKey() {
  try {
    if (!existsSync(CONFIG_PATH)) return;
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    delete cfg.opencodeApiKey;
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg), 'utf-8');
  } catch {}
}

// Restore last used provider/model (env vars take priority)
loadPersistedConfig();
// Re-fetch models for the persisted provider
models = await fetchModels();
// Ensure model is valid for the provider — for opencode, pick a free model if current is invalid
if (provider === 'opencode' && models && models.length > 0 && !models.includes(MODEL)) {
  MODEL = models[0];
  agent.setModel(MODEL);
  savePersistedConfig();
}
// Sync agent's apiKey from config (env var takes priority, config loaded above)
if (OPENCODE_API_KEY && !agent._apiKey) {
  agent._apiKey = OPENCODE_API_KEY;
}

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
  cyanBg: '\x1b[46;30m',
  magentaBg: '\x1b[45;30m',
};

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }
const pad = (s, w) => {
  const vis = stripAnsi(s);
  if (vis.length > w) return vis.slice(0, Math.max(0, w - 1)) + '\u2026';
  return s + ' '.repeat(w - vis.length);
};
const mid = (s, w) => {
  if (s.length > w) return s.slice(0, Math.max(0, w - 1)) + '\u2026';
  const r = w - s.length;
  return ' '.repeat(Math.floor(r/2)) + s + ' '.repeat(Math.ceil(r/2));
};

function fmt(text) {
  return text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const lines = code.trimEnd().split('\n');
    const langTag = lang ? ` ${C.cyan}${lang}${C.reset}` : '';
    const header = lines.length > 1 ? `  ${C.cyan}┌${langTag}${C.reset}` : '';
    const body = lines.map(l => `  ${C.gray}│${C.reset} ${l}`).join('\n');
    const footer = lines.length > 1 ? `\n  ${C.cyan}└${'─'.repeat(30)}${C.reset}` : '';
    return `${header}${header ? '\n' : ''}${body}${footer}`;
  }).replace(/`([^`]+)`/g, `${C.cyan}$1${C.reset}`);
}

function printHelp() {
  console.log(`\n  ${C.gray}Commands:${C.reset}`);
  console.log('  /exit             Exit');
  console.log('  /reset            Clear conversation & terminal');
  console.log('  /clear            Clear conversation & terminal');
  console.log(`  /menu  (\u2302+P)    Open menu`);
  console.log('  /model            Open model picker');
  console.log('  /provider         Open provider picker');
  console.log('  /providers        List providers');
  console.log('  /models           List models');
  console.log('  /sessions         List sessions');
  console.log('  /session          Open session picker');
  console.log('  /session new      Create new session');
  console.log('  /session delete   Pick session to delete\n');
}

function printBanner() {
  const termWidth = stdout.columns || 80;
  // Inner content width: total banner width = innerWidth + 6, must fit within termWidth
  // Cap at 60 for readability on wide terminals, no lower bound to guarantee it always fits
  const innerWidth = Math.min(termWidth - 6, 60);
  const bar = '-'.repeat(innerWidth + 2);

  console.log(`  ${C.cyan}+${bar}+${C.reset}`);
  console.log(`  ${C.cyan}|${C.reset} ${C.bold}${C.cyan}${mid('== Kisaragi ==', innerWidth)}${C.reset} ${C.cyan}|${C.reset}`);
  console.log(`  ${C.cyan}|${C.reset} ${C.dim}${pad('AI Coding Agent', innerWidth)}${C.reset} ${C.cyan}|${C.reset}`);
  console.log(`  ${C.cyan}|${C.reset} ${C.gray}${pad(`${provider} / ${MODEL}`, innerWidth)}${C.reset} ${C.cyan}|${C.reset}`);
  if (models) console.log(`  ${C.cyan}|${C.reset} ${C.gray}${pad(`${models.length} models available`, innerWidth)}${C.reset} ${C.cyan}|${C.reset}`);
  console.log(`  ${C.cyan}|${C.reset} ${C.gray}${pad(`session: ${agent.currentSession}`, innerWidth)}${C.reset} ${C.cyan}|${C.reset}`);
  console.log(`  ${C.cyan}|${C.reset} ${C.dim}${pad('Developed by Kenneth Panio', innerWidth)}${C.reset} ${C.cyan}|${C.reset}`);
  console.log(`  ${C.cyan}+${bar}+${C.reset}`);
}

// Clear terminal on startup
process.stdout.write('\x1b[2J\x1b[3J\x1b[H');

printBanner();

let pending = 0;
let cancelRequested = false;
let currentRL = null;
let menuActive = false;
let currentAbort = null;
let spinnerInterval = null;
let prevStatus = '';
const spinnerFrames = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u280f', '\u280e'];

function status(label) {
  if (spinnerInterval) clearInterval(spinnerInterval);
  if (prevStatus) process.stdout.write('\r\x1b[K');
  prevStatus = label;
  let i = 0;
  spinnerInterval = setInterval(() => {
    i = (i + 1) % spinnerFrames.length;
    process.stdout.write(`\r  ${C.magenta}${spinnerFrames[i]}${C.reset} ${C.gray}${label}${C.reset}`);
  }, 80);
  process.stdout.write(`  ${C.magenta}\u280b${C.reset} ${C.gray}${label}${C.reset}`);
}

function statusClear() {
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
  if (prevStatus) { process.stdout.write('\r\x1b[K'); prevStatus = ''; }
}

function promptStr() {
  return `${C.green}You${C.reset}${C.dim}:${C.reset} `;
}

async function startCLI() {
  if (!stdin.isTTY) {
    let buf = '';
    const rl = createInterface({ input: stdin, output: stdout });
    rl.on('line', (line) => { buf += line + '\n'; });
    rl.on('close', async () => {
      const lines = buf.trim().split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (line === '/exit') process.exit(0);
        if (line === '/reset' || line === '/clear') { agent.reset(); process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); printBanner(); continue; }
        if (line === '/help') { printHelp(); continue; }

        const modelMatch = line.match(/^\/(?:model|models)(?:\s+(.+))?$/);
        if (modelMatch) {
          if (modelMatch[1]) {
            const partial = modelMatch[1];
            const all = await fetchModels();
            const lower = partial.toLowerCase();
            const matches = all?.filter(x => x.toLowerCase().includes(lower));
            const match = matches?.length ? matches.sort((a, b) => a.indexOf(partial) - b.indexOf(partial) || a.length - b.length)[0] : partial;
            if (all && match !== partial) process.stdout.write(`(matched "${match}")\n`);
            MODEL = match; agent.setModel(MODEL); savePersistedConfig(); process.stdout.write(`Model: ${MODEL}\n`);
          } else process.stdout.write(`Current model: ${MODEL}\n`);
          continue;
        }

        const provMatch = line.match(/^\/(?:provider|providers)(?:\s+(.+))?$/);
        if (provMatch) {
          if (provMatch[1]) {
            const partial = provMatch[1];
            const match = PROVIDER_NAMES.find(x => x.toLowerCase().includes(partial.toLowerCase())) || partial;
            if (PROVIDERS[match]) {
              if (match !== partial) process.stdout.write(`(matched "${match}")\n`);
              provider = match; agent.setApiUrl(apiUrl()); models = await fetchModels(); savePersistedConfig();
              // Auto-select first free model for opencode
              if (provider === 'opencode' && models && models.length > 0) {
                MODEL = models[0]; agent.setModel(MODEL); savePersistedConfig();
              }
              process.stdout.write(`Provider: ${provider}${provider === 'opencode' ? ' (free models only)' : ''}\n`);
            } else process.stdout.write(`Providers: ${PROVIDER_NAMES.join(', ')}\n`);
          } else process.stdout.write(`Current provider: ${provider}\n`);
          continue;
        }

        const sessMatch = line.match(/^\/sessions?(\s+.*)?$/);
        if (sessMatch) {
          const rest = (sessMatch[1] || '').trim();
          if (line === '/sessions') {
            const all = agent.listSessions();
            process.stdout.write(`Sessions (${all.length}):\n`);
            for (const s of all) {
              const marker = s === agent.currentSession ? ' ←' : '';
              process.stdout.write(`  ${s}${marker}\n`);
            }
          } else if (line === '/session') {
            process.stdout.write(`Current session: ${agent.currentSession}\n`);
          } else if (rest === 'new') {
            const newName = `session-${Date.now()}`;
            agent.newSession(newName);
            process.stdout.write(`New session: ${newName}\n`);
          } else if (rest === 'delete' || rest === 'rm' || rest === 'remove') {
            process.stdout.write('Cannot delete sessions in non-TTY mode. Use interactive terminal.\n');
          } else {
            const all = agent.listSessions();
            const match = all.find(s => s.toLowerCase().includes(rest.toLowerCase()));
            if (match) {
              agent.switchSession(match);
              process.stdout.write(`Switched to session: ${match}\n`);
            } else {
              process.stdout.write(`Session not found: ${rest}\n`);
              process.stdout.write(`Available: ${all.join(', ') || 'none'}\n`);
            }
          }
          continue;
        }

        // Fuzzy match typos in non-TTY mode
        if (line.startsWith('/')) {
          const spaceIdx = line.indexOf(' ');
          const cmdPart = spaceIdx === -1 ? line.slice(1) : line.slice(1, spaceIdx);
          const rest = spaceIdx === -1 ? '' : line.slice(spaceIdx);
          const known = ['exit', 'reset', 'clear', 'menu', 'model', 'models', 'provider', 'providers', 'session', 'sessions', 'help'];
          const scored = known.map(cmd => {
            let score = 0, qi = 0;
            for (const ch of cmd) { if (qi < cmdPart.length && ch === cmdPart[qi]) { score++; qi++; } }
            return { cmd, score: score - Math.abs(cmd.length - cmdPart.length) };
          });
          const best = scored.reduce((a, b) => a.score > b.score ? a : b);
          if (best.score >= Math.floor(Math.min(cmdPart.length, best.cmd.length) * 0.6)) {
            const corrected = '/' + best.cmd + rest;
            if (process.stdout.isTTY) process.stdout.write(`(auto-corrected /${cmdPart} → /${best.cmd})\n`);
            // Re-route to the corrected command
            if (best.cmd === 'exit') process.exit(0);
            if (best.cmd === 'reset' || best.cmd === 'clear') { agent.reset(); process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); printBanner(); continue; }
            if (best.cmd === 'menu') { process.stdout.write('Interactive menu requires a terminal.\n'); continue; }
            const modelM = corrected.match(/^\/(?:model|models)(?:\s+(.+))?$/);
            if (modelM) {
              if (modelM[1]) {
                const partial = modelM[1];
                const all = await fetchModels();
                const lower = partial.toLowerCase();
                const matches = all?.filter(x => x.toLowerCase().includes(lower));
                const match = matches?.length ? matches.sort((a, b) => a.indexOf(partial) - b.indexOf(partial) || a.length - b.length)[0] : partial;
                if (all && match !== partial) process.stdout.write(`  (matched "${match}")\n`);
              MODEL = match; agent.setModel(MODEL); savePersistedConfig(); process.stdout.write(`Model: ${MODEL}\n`);
            } else process.stdout.write(`Current model: ${MODEL}\n`);
              continue;
            }
            const provM = corrected.match(/^\/(?:provider|providers)(?:\s+(.+))?$/);
            if (provM) {
              if (provM[1]) {
                const partial = provM[1];
                const match = PROVIDER_NAMES.find(x => x.toLowerCase().includes(partial.toLowerCase())) || partial;
                if (PROVIDERS[match]) {
                  if (match !== partial) process.stdout.write(`  (matched "${match}")\n`);
                  provider = match; agent.setApiUrl(apiUrl()); models = await fetchModels(); savePersistedConfig();
                  // Auto-select first free model for opencode
                  if (provider === 'opencode' && models && models.length > 0) {
                    MODEL = models[0]; agent.setModel(MODEL); savePersistedConfig();
                  }
                } else process.stdout.write(`Providers: ${PROVIDER_NAMES.join(', ')}\n`);
              } else process.stdout.write(`Current provider: ${provider}\n`);
              continue;
            }

            const sessM = corrected.match(/^\/sessions?(\s+.*)?$/);
            if (sessM) {
              const rest = (sessM[1] || '').trim();
              if (corrected === '/sessions') {
                const all = agent.listSessions();
                process.stdout.write(`Sessions (${all.length}):\n`);
                for (const s of all) {
                  const marker = s === agent.currentSession ? ' ←' : '';
                  process.stdout.write(`  ${s}${marker}\n`);
                }
              } else if (corrected === '/session') {
                process.stdout.write(`Current session: ${agent.currentSession}\n`);
              } else if (rest === 'new') {
                const newName = `session-${Date.now()}`;
                agent.newSession(newName);
                process.stdout.write(`New session: ${newName}\n`);
              } else if (rest === 'delete' || rest === 'rm' || rest === 'remove') {
                process.stdout.write('Cannot delete sessions in non-TTY mode. Use interactive terminal.\n');
              } else {
                const all = agent.listSessions();
                const match = all.find(s => s.toLowerCase().includes(rest.toLowerCase()));
                if (match) {
                  agent.switchSession(match);
                  process.stdout.write(`Switched to session: ${match}\n`);
                } else {
                  process.stdout.write(`Session not found: ${rest}\n`);
                  process.stdout.write(`Available: ${all.join(', ') || 'none'}\n`);
                }
              }
              continue;
            }
            continue;
          }
        }

        try {
          const response = await agent.send(line);
          if (response) process.stdout.write(response + '\n');
        } catch (err) {
          process.stderr.write(`Error: ${err.message}\n`);
        }
      }
    });
    return;
  }

  console.log(`  ${C.gray}/exit  /reset  /clear  /menu (Ctrl+P)  /model  /provider  /session${C.reset}\n`);

  const rl = createInterface({ input: stdin, output: stdout, prompt: promptStr(), terminal: true });
  currentRL = rl;

  rl.on('line', async (line) => {
    let input = line.trim();
    const rawInput = line; // Save original for re-display after response
    if (!input) { if (!rl.closed) rl.prompt(); return; }

    // Handle commands BEFORE fuzzy matching (exact matches only)
    if (input === '/exit') { rl.close(); process.exit(0); }

    // Fuzzy match typos before checking other commands
    if (input.startsWith('/')) {
      const spaceIdx = input.indexOf(' ');
      const cmdPart = spaceIdx === -1 ? input.slice(1) : input.slice(1, spaceIdx);
      const known = ['exit', 'reset', 'clear', 'menu', 'model', 'models', 'provider', 'providers', 'session', 'sessions', 'help'];
      const best = known.map(cmd => {
        let score = 0, qi = 0;
        for (const ch of cmd) { if (qi < cmdPart.length && ch === cmdPart[qi]) { score++; qi++; } }
        return { cmd, score: score - Math.abs(cmd.length - cmdPart.length) };
      }).reduce((a, b) => a.score > b.score ? a : b);
      if (best.score >= Math.floor(Math.min(cmdPart.length, best.cmd.length) * 0.6) && best.cmd !== cmdPart) {
        input = '/' + best.cmd + (spaceIdx === -1 ? '' : input.slice(spaceIdx));
        console.log(`  ${C.yellow}Did you mean${C.reset} ${C.cyan}/${best.cmd}${C.reset}${C.yellow}?${C.reset} ${C.gray}(auto-corrected)${C.reset}`);
      }
    }

    // Re-check after possible fuzzy correction
    if (input === '/exit') { rl.close(); process.exit(0); }
    if (input === '/reset' || input === '/clear') { agent.reset(); process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); printBanner(); if (!rl.closed) rl.prompt(); return; }
    if (input === '/help') { printHelp(); if (!rl.closed) rl.prompt(); return; }

    if (input === '/menu') {
      if (menuActive) return;
      menuActive = true;
      rl.close();
      await showInteractiveMenu();
      menuActive = false;
      printBanner();
      startCLI();
      return;
    }

    if (input === '/model' || input === '/models') {
      if (menuActive) return;
      menuActive = true;
      rl.close();
      await showInteractiveMenu('Models');
      menuActive = false;
      printBanner();
      startCLI();
      return;
    }
    if (input.startsWith('/model ') || input.startsWith('/models ')) {
      const m = input.startsWith('/model ') ? input.slice(7).trim() : input.slice(8).trim();
      if (m) {
        const all = await fetchModels();
        const lower = m.toLowerCase();
        const matches = all?.filter(x => x.toLowerCase().includes(lower));
        const match = matches?.length ? matches.sort((a, b) => a.indexOf(m) - b.indexOf(m) || a.length - b.length)[0] : m;
        if (all && match !== m) console.log(`  ${C.gray}(matched "${match}")${C.reset}`);
        MODEL = match; agent.setModel(MODEL); savePersistedConfig(); console.log(`Model: ${MODEL}`);
      }
      if (!rl.closed) rl.prompt();
      return;
    }

    if (input === '/provider' || input === '/providers') {
      if (menuActive) return;
      menuActive = true;
      rl.close();
      await showInteractiveMenu('Providers');
      menuActive = false;
      printBanner();
      startCLI();
      return;
    }
    if (input.startsWith('/provider ') || input.startsWith('/providers ')) {
      const p = (input.startsWith('/provider ') ? input.slice(10) : input.slice(11)).trim();
      if (p) {
        const match = PROVIDER_NAMES.find(x => x.toLowerCase().includes(p.toLowerCase())) || p;
        if (PROVIDERS[match]) {
          if (match !== p) console.log(`  ${C.gray}(matched "${match}")${C.reset}`);
    provider = match; agent.setApiUrl(apiUrl()); models = await fetchModels(); savePersistedConfig();
    // Auto-select first free model for opencode
    if (provider === 'opencode' && models && models.length > 0) {
      MODEL = models[0]; agent.setModel(MODEL); savePersistedConfig();
    }
    console.log(`Provider: ${provider}${provider === 'opencode' ? ' (free models only)' : ''} ${C.gray}(${models ? models.length + ' models' : 'none'})${C.reset}`);
        } else console.log(`Providers: ${PROVIDER_NAMES.join(', ')}`);
      }
      if (!rl.closed) rl.prompt();
      return;
    }

    if (input === '/sessions') {
      const all = agent.listSessions();
      console.log(`  ${C.gray}Sessions (${all.length}):${C.reset}`);
      for (const s of all) {
        const marker = s === agent.currentSession ? ` ${C.green}←${C.reset}` : '';
        console.log(`  ${C.cyan}${s}${C.reset}${marker}`);
      }
      if (!rl.closed) rl.prompt();
      return;
    }

    if (input === '/session') {
      if (menuActive) return;
      menuActive = true;
      rl.close();
      await showInteractiveMenu('Sessions');
      menuActive = false;
      printBanner();
      startCLI();
      return;
    }

    if (input === '/session delete' || input === '/session rm' || input === '/session remove') {
      if (menuActive) return;
      menuActive = true;
      rl.close();
      await showSessionDeletePicker();
      menuActive = false;
      printBanner();
      startCLI();
      return;
    }

    if (input.startsWith('/session ')) {
      const name = input.slice(9).trim();
      if (name === 'new') {
        const newName = `session-${Date.now()}`;
        agent.newSession(newName);
        console.log(`  ${C.green}→ New session: ${C.reset}${C.cyan}${newName}${C.reset}`);
      } else if (name === 'delete' || name === 'rm' || name === 'remove') {
        if (menuActive) return;
        menuActive = true;
        rl.close();
        await showSessionDeletePicker();
        menuActive = false;
        printBanner();
        startCLI();
        return;
      } else {
        const all = agent.listSessions();
        const match = all.find(s => s.toLowerCase().includes(name.toLowerCase()));
        if (match) {
          agent.switchSession(match);
          console.log(`  ${C.green}→ Switched to session: ${C.reset}${C.cyan}${match}${C.reset}`);
        } else {
          console.log(`  ${C.yellow}Session not found: ${C.reset}${name}`);
          console.log(`  ${C.gray}Available: ${all.join(', ') || 'none'}${C.reset}`);
        }
      }
      if (!rl.closed) rl.prompt();
      return;
    }

    // Clear the "You: <input>" prompt line (and any auto-correction message above it)
    // Use 2-line clear to handle both normal + auto-correction cursor positions
    process.stdout.write('\x1b[1A\x1b[K\x1b[1A\x1b[K');

    pending++;
    // status() and statusClear() are defined at module scope above
    // Start waiting spinner — shown until the first tool call or token arrives
    status('thinking...  (Esc to cancel)');
    agent.onRetry = (info) => {
      status(`retry ${info.attempt}/${info.max} (${info.reason})...`);
    };
    let streamedContent = '';
    let streamStarted = false;
    agent.onToken = (token) => {
      if (!streamStarted) {
        streamStarted = true;
        statusClear();
        // Re-display user message before Kisaragi's response
        process.stdout.write(`${promptStr()}${rawInput}\n`);
        process.stdout.write(`${C.magenta}Kisaragi${C.reset}${C.dim}:${C.reset} `);
      } else {
        statusClear();
      }
      streamedContent += token;
      process.stdout.write(token);
    };
    agent.onToolCall = (name, args, isSub) => {
      const prefix = isSub ? `${C.dim}[sub]${C.reset} ` : '';
      const info = name === 'bash'     ? `bash: ${(args.command || '').slice(0, 60)}` :
                   name === 'read'     ? `read: ${args.path}` :
                   name === 'write'    ? `write: ${args.path}` :
                   name === 'edit'     ? `edit: ${args.path}` :
                   name === 'grep'     ? `grep: ${args.pattern}` :
                   name === 'glob'     ? `glob: ${args.pattern}` :
                   name === 'webSearch'? `search: ${args.query}` :
                   name === 'webFetch' ? `fetch: ${args.url}` :
                   name === 'listDir'  ? `ls: ${args.path}` :
                   name === 'mkDir'    ? `mkdir: ${args.path}` :
                   name === 'remove'   ? `rm: ${args.path}` :
                   name === 'task'     ? `task: ${(args.prompt || '').slice(0, 60)}` :
                   name === 'lint'     ? `lint: ${args.command || 'auto'}` :
                   name;
      const toolLabel = name === 'bash'     ? (args.command || '').slice(0, 40) :
                        name === 'webSearch'? 'searching web...' :
                        name === 'webFetch' ? `fetching ${args.url}` :
                        name === 'read'     ? `reading ${args.path}` :
                        name === 'write'    ? `writing ${args.path}` :
                        name === 'edit'     ? `editing ${args.path}` :
                        name === 'grep'     ? `grepping ${args.pattern}` :
                        name === 'glob'     ? `globbing ${args.pattern}` :
                        name === 'listDir'  ? `listing ${args.path}` :
                        name === 'mkDir'    ? `creating ${args.path}` :
                        name === 'remove'   ? `removing ${args.path}` :
                        name === 'task'     ? `sub-agent working...` :
                        name === 'lint'     ? `linting...` :
                        name === 'gitStatus'? 'git status' :
                        name === 'gitDiff'  ? 'git diff' :
                        name === 'gitLog'   ? 'git log' :
                        name === 'gitAdd'   ? 'git add' :
                        name === 'gitCommit'? 'git commit' :
                        name === 'bg'       ? 'starting bg task...' :
                        name === 'ps'       ? 'listing processes' :
                        name === 'kill'     ? 'killing process' :
                        `${name}...`;
      statusClear();
      console.log(`${prefix} ${C.magenta}\u2192${C.reset} ${C.gray}${info}${C.reset}`);
      if (name === 'edit' && typeof args.old === 'string' && typeof args.new === 'string') {
        const oldL = args.old.split('\n');
        const newL = args.new.split('\n');
        const max = Math.min(Math.max(oldL.length, newL.length), 10);
        for (let i = 0; i < max; i++) {
          if (i < oldL.length && i < newL.length && oldL[i] !== newL[i]) {
            console.log(`  ${C.red}\u2212${C.reset} ${oldL[i]}`);
            console.log(`  ${C.green}+${C.reset} ${newL[i]}`);
          } else if (i < oldL.length) {
            console.log(`  ${C.red}\u2212${C.reset} ${oldL[i]}`);
          } else if (i < newL.length) {
            console.log(`  ${C.green}+${C.reset} ${newL[i]}`);
          }
        }
        if (oldL.length > 10 || newL.length > 10) console.log(`  ${C.gray}... (${oldL.length} \u2192 ${newL.length} lines)${C.reset}`);
      }
      status(toolLabel);
    };
    const ac = new AbortController();
    currentAbort = ac;
    cancelRequested = false;
    try {
      const response = await agent.send(input, ac.signal);
      statusClear();
      if (streamedContent) {
        process.stdout.write('\n');
        // User message was already shown in onToken
      }
      agent.onToolCall = null;
      agent.onToken = null;
      agent.onRetry = null;
      currentAbort = null;
      if (cancelRequested) {
        cancelRequested = false;
        if (!streamedContent) process.stdout.write(`${promptStr()}${rawInput}\n`);
        process.stdout.write(`  ${C.yellow}Chat interrupted${C.reset}\n`);
      } else if (response) {
        if (!streamedContent) {
          // Non-streamed: show user message first, then response
          process.stdout.write(`${promptStr()}${rawInput}\n`);
          process.stdout.write(`${C.magenta}Kisaragi${C.reset}${C.dim}:${C.reset} ${fmt(response)}\n`);
        }
      }
    } catch (err) {
      statusClear();
      if (streamedContent) {
        process.stdout.write('\n');
        // User message was already shown in onToken
      } else {
        // Show user message since it wasn't shown during streaming
        process.stdout.write(`${promptStr()}${rawInput}\n`);
      }
      agent.onToolCall = null;
      agent.onToken = null;
      agent.onRetry = null;
      currentAbort = null;
      cancelRequested = false;
      // If user cancelled, show clean interrupt message instead of error
      if (err.message === 'Request cancelled' || err.message.includes('cancelled')) {
        process.stdout.write(`  ${C.yellow}Chat interrupted${C.reset}\n`);
      } else if (err.message.includes('429') || err.message.includes('rate limit') || err.message.includes('too many requests') || err.message.includes('overloaded')) {
        process.stdout.write(`  ${C.yellow}Rate limited${C.reset}${C.dim}:${C.reset} ${C.gray}Model "${MODEL}" is overloaded on ${provider}. Try ${C.cyan}/model${C.reset}${C.gray} or ${C.cyan}/provider${C.reset}${C.gray} to switch.${C.reset}\n`);
      } else {
        process.stdout.write(`${C.yellow}error${C.reset}${C.dim}:${C.reset} ${err.message}\n`);
      }
    }
    pending--;
    if (!rl.closed) rl.prompt();
  });

  rl.on('close', () => {
    currentRL = null;
    console.log();
  });

  rl.on('SIGINT', () => {
    rl.close();
  });

  process.nextTick(() => { if (!rl.closed) rl.prompt(); });
}

async function showSessionDeletePicker() {
  const sessions = agent.listSessions();
  const items = sessions.map(s => ({
    label: s === agent.currentSession
      ? `\x1b[36m\u2713\x1b[0m ${s}  \x1b[90m(current)\x1b[0m`
      : `  ${s}`,
    value: s,
  }));

  const chosen = await pick(items, { title: 'Delete Session' });
  if (!chosen) return;

  if (chosen === agent.currentSession) {
    if (sessions.length <= 1) {
      agent.reset();
      agent.saveSession(agent.currentSession);
      console.log(`\x1b[36m\u2192 Only one session left, cleared instead\x1b[0m`);
      return;
    }
    const currentName = agent.currentSession;
    agent.deleteSession(currentName);
    const remaining = agent.listSessions();
    agent.switchSession(remaining[0]);
    console.log(`\x1b[36m\u2192 Deleted: ${currentName}, switched to ${remaining[0]}\x1b[0m`);
  } else {
    agent.deleteSession(chosen);
    console.log(`\x1b[36m\u2192 Deleted: ${chosen}\x1b[0m`);
  }
}

async function setOpenCodeKey() {
  return new Promise(resolve => {
    const wasRaw = stdin.isRaw;
    try { stdin.setRawMode(true); stdin.resume(); } catch {}
    statusClear();
    process.stdout.write(`  ${C.cyan}Paste your OpenCode API key${C.reset} ${C.gray}(or Esc to cancel)${C.reset}: `);
    let buf = '';
    const onData = (chunk) => {
      const s = chunk.toString();
      for (const ch of s) {
        if (ch === '\x1b') {
          stdin.removeListener('data', onData);
          try { stdin.setRawMode(!!wasRaw); } catch {}
          process.stdout.write('\n');
          resolve(null);
          return;
        }
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          try { stdin.setRawMode(!!wasRaw); } catch {}
          const trimmed = buf.trim();
          process.stdout.write('\n');
          if (trimmed) {
            OPENCODE_API_KEY = trimmed;
            agent._apiKey = trimmed;
            savePersistedConfig();
            console.log(`  ${C.green}→ OpenCode API key saved${C.reset}`);
          }
          resolve(trimmed || null);
          return;
        }
        if (ch === '\x7f' || ch === '\b') {
          if (buf.length > 0) buf = buf.slice(0, -1);
          process.stdout.write('\b \b');
        } else if (ch.length === 1 && ch >= ' ') {
          buf += ch;
          process.stdout.write('*'); // Mask the key
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function showInteractiveMenu(startIn) {
  const allModels = await fetchModels() || [];
  const sessions = agent.listSessions();

  const item = await pick([
    {
      label: 'Models',
      children: allModels.map(m => ({
        label: m === MODEL
          ? `\x1b[36m\u2713\x1b[0m ${m}  \x1b[90m(current)\x1b[0m`
          : `  ${m}`,
        value: m
      })),
    },
    {
      label: 'Providers',
      children: PROVIDER_NAMES.map(p => ({
        label: p === provider
          ? `\x1b[36m\u2713\x1b[0m ${p}  \x1b[90m(current)\x1b[0m`
          : `  ${p}`,
        value: p
      })),
    },
    {
      label: 'Commands',
      children: [
        `/reset  /clear  Clear conversation & terminal`,
        `/model   Open model picker`,
        `/session Open session picker`,
        `/help    Show command reference`,
      ],
    },
    ...(!env.KISARAGI_OPENCODE_API_KEY ? [{
      label: 'OpenCode API Key',
      children: OPENCODE_API_KEY
        ? [
            { label: `\x1b[33mKey set (${OPENCODE_API_KEY.slice(0, 8)}...)`, value: '_viewKey' },
            { label: `\x1b[31m- Clear Key\x1b[0m`, value: '_clearKey' },
          ]
        : [
            { label: `\x1b[32m+ Set API Key\x1b[0m`, value: '_setKey' },
          ],
    }] : []),
    {
      label: 'Sessions',
      children: [
        ...sessions.map(s => ({
          label: s === agent.currentSession
            ? `\x1b[36m\u2713\x1b[0m ${s}`
            : `  ${s}`,
          value: s,
        })),
        { label: `\x1b[32m+ New Session\x1b[0m`, value: '_newSession' },
        { label: `\x1b[31m- Delete Session...\x1b[0m`, value: '_deleteSession' },
      ],
    },
  ], { title: 'Kisaragi Menu', startIn });
  if (!item) return;

  if (item === '_setKey') {
    await setOpenCodeKey();
    return;
  }

  if (item === '_clearKey') {
    OPENCODE_API_KEY = '';
    agent._apiKey = '';
    deletePersistedKey();
    console.log(`\x1b[36m\u2192 OpenCode API key cleared\x1b[0m`);
    return;
  }

  if (item === '_viewKey') {
    const key = OPENCODE_API_KEY;
    console.log(`\x1b[90m  OpenCode API Key:\x1b[0m ${key.slice(0, 16)}...${key.slice(-4)}`);
    return;
  }

  if (item === '_newSession') {
    const name = `session-${Date.now()}`;
    agent.newSession(name);
    console.log(`\x1b[36m\u2192 New session created (will auto-name on first message)\x1b[0m`);
    return;
  }

  if (item === '_deleteSession') {
    await showSessionDeletePicker();
    return;
  }

  if (sessions.includes(item)) {
    agent.switchSession(item);
    console.log(`\x1b[36m\u2192 Session: ${item}\x1b[0m`);
    return;
  }

  if (allModels.includes(item)) {
    MODEL = item;
    agent.setModel(item);
    savePersistedConfig();
    console.log(`\x1b[36m\u2192 Model: ${item}\x1b[0m`);
    return;
  }

  if (PROVIDER_NAMES.includes(item)) {
    provider = item;
    agent.setApiUrl(apiUrl());
    models = await fetchModels();
    savePersistedConfig();
    // Auto-prompt to pick a model for this provider
    if (models && models.length > 0) {
      const modelItem = await pick(
        models.map(m => ({
          label: m === MODEL
            ? `\x1b[36m\u2713\x1b[0m ${m}  \x1b[90m(current)\x1b[0m`
            : `  ${m}`,
          value: m
        })),
        { title: `Pick a model for ${item}` }
      );
      if (modelItem && models.includes(modelItem)) {
        MODEL = modelItem;
        agent.setModel(modelItem);
        savePersistedConfig();
        console.log(`\x1b[36m\u2192 Provider: ${provider} | Model: ${MODEL}\x1b[0m`);
        return;
      }
    }
    console.log(`\x1b[36m\u2192 Provider: ${item} \x1b[90m(${models ? models.length + ' models' : 'none'})\x1b[0m`);
    return;
  }

  if (item.startsWith('/reset') || item.startsWith('/clear')) {
    agent.reset();
    console.log('\x1b[36m\u2192 Conversation cleared\x1b[0m');
    return;
  }

  if (item.startsWith('/models')) {
    const m = await fetchModels();
    if (m) m.forEach(x => console.log(`  ${x}`));
    else console.log('No models');
    return;
  }

  if (item.startsWith('/help')) {
    printHelp();
    return;
  }
}

if (stdin.isTTY && typeof stdin.listeners === 'function') {
  stdin.on('keypress', (str, key) => {
    if (key && key.ctrl && key.name === 'p' && !menuActive && !pending) {
      if (currentRL && !currentRL.closed) {
        menuActive = true;
        currentRL.close();
        showInteractiveMenu().then(() => {
          menuActive = false;
          printBanner();
          startCLI();
        });
      }
    }
    if (key && key.name === 'escape' && pending && currentAbort) {
      cancelRequested = true;
      statusClear();
      process.stdout.write(`  ${C.yellow}cancelling...${C.reset}\n`);
      currentAbort.abort();
    }
  });
}

startCLI();
