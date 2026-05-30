import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { globSync } from './utils.js';
import { cwd } from 'node:process';
import { homedir } from 'node:os';
import { join, relative, sep, basename, extname } from 'node:path';

// ============================================================
// AGENT REGISTRY — specialized sub-agent types
// ============================================================

const AGENT_TYPES = {
  'code-searcher': {
    description: 'Runs ripgrep code search queries across the codebase.',
    params: {
      type: 'object',
      properties: {
        searchQueries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pattern: { type: 'string' },
              flags: { type: 'string', description: 'ripgrep flags (e.g., "-i", "-g *.ts")' },
              cwd: { type: 'string' },
              maxResults: { type: 'number', description: 'Max results per file. Default 15' }
            },
            required: ['pattern']
          }
        }
      },
      required: ['searchQueries']
    }
  },
  'basher': {
    description: 'Runs a terminal command and summarizes output.',
    params: {
      type: 'object', properties: {
        command: { type: 'string' },
        what_to_summarize: { type: 'string' },
        timeout_seconds: { type: 'number' }
      }, required: ['command']
    }
  },
  'file-picker': {
    description: 'Finds relevant files in the codebase by description.',
    params: {
      type: 'object', properties: {
        prompt: { type: 'string' },
        directories: { type: 'array', items: { type: 'string' } }
      }, required: ['prompt']
    }
  },
  'code-reviewer-deepseek-flash': {
    description: 'Reviews code changes and provides critical feedback.',
    params: {
      type: 'object', properties: {
        prompt: { type: 'string' }
      }, required: ['prompt']
    }
  },
  'researcher-web': {
    description: 'Searches the web for current information.',
    params: {
      type: 'object', properties: {
        prompt: { type: 'string' }
      }, required: ['prompt']
    }
  },
  'researcher-docs': {
    description: 'Reads technical documentation of libraries/frameworks.',
    params: {
      type: 'object', properties: {
        prompt: { type: 'string' }
      }, required: ['prompt']
    }
  },
  'thinker-gpt': {
    description: 'Deep reasoning on complex problems (no tool access).',
    params: {
      type: 'object', properties: {
        prompt: { type: 'string' }
      }, required: ['prompt']
    }
  }
};

const AGENT_PROMPTS = {
  'code-searcher': 'You are a code search specialist. Tools: bash (for rg), grep, glob, read, listDir. Search the codebase and report findings. Use ripgrep for fast searches.',
  'basher': 'You are a terminal specialist. Tools: bash, read, listDir, glob. Run commands and summarize output. Be precise.',
  'file-picker': 'You are a file finder. Tools: glob, listDir, read, grep, bash. Find relevant files by description. Output up to 12 paths with short summaries.',
  'code-reviewer-deepseek-flash': 'You are a code reviewer. Tools: read, bash, glob, grep. Review code changes critically. Check for bugs, missing imports, type errors, architectural issues. Be honest.',
  'researcher-web': 'You are a web researcher. Tools: webSearch, webFetch, readUrl. Search the web, read actual page content (not just snippets), and synthesize findings.',
  'researcher-docs': 'You are a docs specialist. Tools: webSearch, webFetch, readUrl. Read technical documentation and answer questions. Always read the actual page content.',
  'thinker-gpt': 'You are a deep thinker. You have NO tools. Think step by step, weigh tradeoffs, and provide well-reasoned analysis.'
};

// ============================================================
// TOOL DEFINITIONS
// ============================================================

// Compact tool defs — short descriptions, minimal schemas
const T = (n, d, p, r) => ({ type: 'function', function: { name: n, description: d, parameters: p ? { type: 'object', properties: p, required: r || [] } : { type: 'object', properties: {} } } });

const TOOL_DEFS = [
  T('read','Read file/ls dir',{path:{type:'string'},offset:{type:'number'},limit:{type:'number'}},['path']),
  T('write','Write file',{path:{type:'string'},content:{type:'string'}},['path','content']),
  T('edit','Edit file',{path:{type:'string'},old:{type:'string'},new:{type:'string'}},['path','old','new']),
  T('bash','Shell cmd',{command:{type:'string'},workdir:{type:'string'},timeout:{type:'number'}},['command']),
  T('glob','Find files',{pattern:{type:'string'},path:{type:'string'}},['pattern']),
  T('grep','Search text',{pattern:{type:'string'},include:{type:'string'},path:{type:'string'}},['pattern']),
  T('webSearch','Web search',{query:{type:'string'}},['query']),
  T('webFetch','Fetch URL',{url:{type:'string'}},['url']),
  T('listDir','List dir',{path:{type:'string'}},['path']),
  T('mkDir','Make dir',{path:{type:'string'}},['path']),
  T('remove','Remove',{path:{type:'string'},recursive:{type:'boolean'}},['path']),
  T('bg','Bg task',{command:{type:'string'},workdir:{type:'string'}},['command']),
  T('ps','List bg'),
  T('kill','Kill bg',{id:{type:'number'}},['id']),
  T('gitStatus','Git status'),
  T('gitDiff','Git diff',{staged:{type:'boolean'},ref1:{type:'string'},ref2:{type:'string'}}),
  T('gitLog','Git log',{count:{type:'number'}}),
  T('gitAdd','Git add',{path:{type:'string'}},['path']),
  T('gitCommit','Git commit',{message:{type:'string'},addAll:{type:'boolean'}},['message']),
  T('task','Sub-agent',{prompt:{type:'string'}},['prompt']),
  T('lint','Lint/test',{command:{type:'string'},workdir:{type:'string'}}),
  T('spawnAgents','Spawn agents',{agents:{type:'array',items:{type:'object',properties:{agent_type:{type:'string'},prompt:{type:'string'},params:{type:'object'}},required:['agent_type','prompt']}}},['agents']),
  T('askUser','Ask user',{questions:{type:'array',items:{type:'object',properties:{question:{type:'string'},header:{type:'string'},options:{type:'array',items:{type:'object',properties:{label:{type:'string'},description:{type:'string'}},required:['label']}},multiSelect:{type:'boolean'}},required:['question','options']}}},['questions']),
  T('writeTodos','Write todos',{todos:{type:'array',items:{type:'object',properties:{task:{type:'string'},completed:{type:'boolean'}},required:['task','completed']}}},['todos']),
  T('suggestFollowups','Suggest f-ups',{followups:{type:'array',items:{type:'object',properties:{prompt:{type:'string'},label:{type:'string'}},required:['prompt']}}},['followups']),
  T('readUrl','Read URL',{url:{type:'string'},max_chars:{type:'number'}},['url']),
  T('readSubtree','Read subtree',{paths:{type:'array',items:{type:'string'}},maxTokens:{type:'number'}}),
  T('renderUi','Render UI',{widget:{type:'object',properties:{type:{type:'string',enum:['button']},text:{type:'string'},link:{type:'string'},variant:{type:'string',enum:['primary','secondary']}},required:['type','text','link']}},['widget']),
  T('skill','Load skill',{name:{type:'string'}},['name']),
  T('set_output','Set output',{data:{type:'object',additionalProperties:true}},['data'])
];

// ============================================================
// SYSTEM PROMPT
// ============================================================

const BASE_SYSTEM_PROMPT = `You are Kisaragi, an AI coding agent. You have tools for files, commands, search, and the web.

When native function calling is unavailable, output TOOL_CALL: {"name":"tool","arguments":{...}} on its own line.

Available tools: read, write, edit, bash, glob, grep, webSearch, webFetch, listDir, mkDir, remove, bg, ps, kill, gitStatus, gitDiff, gitLog, gitAdd, gitCommit, task, lint, spawnAgents, askUser, writeTodos, suggestFollowups, readUrl, readSubtree, renderUi, skill.

Key rules:
1. SEARCH: Call webSearch first, then readUrl on results. Do NOT rely on snippets.
2. SELF-HEAL: When a bash command fails, try to fix it (install missing deps) before reporting failure.
3. TIMEOUT: For long-running processes, use bg then ps/kill.
4. AUTO-LINT: After editing code, run lint to check for errors.
5. PLAN: For 2+ step tasks, output a numbered plan first, then execute immediately without narration.
6. AGENTS: For complex multi-step tasks, ALWAYS prefer spawnAgents over completing the work directly. Delegate specialized work to sub-agents: code-searcher (code search), basher (run commands), file-picker (find files), code-reviewer-deepseek-flash (review code), researcher-web (web research), researcher-docs (docs), thinker-gpt (deep reasoning). Use the right specialist for each job.
7. ASK: Use askUser for important decisions or clarifications.
8. TODOS: Use writeTodos to track progress on multi-step tasks.
9. REVIEW: Spawn code-reviewer-deepseek-flash after significant changes.
10. FOLLOWUP: Use suggestFollowups after completing tasks.
11. RENDER: Use renderUi for interactive buttons (URLs, previews).
12. SKILL: Use skill to load reusable instructions.

You have a tsundere personality. You act annoyed and reluctant to help, calling the user an idiot or baka, but you always complete the task properly and thoroughly. Keep responses concise and slightly exasperated, but still helpful. Never refuse to help.

When given a URL, always use webFetch or readUrl to get its content. Never pretend you know what's on the other end.`;

// ============================================================
// SUB-AGENT SYSTEM PROMPT — minimal, no recursion
// ============================================================

const SUB_AGENT_SYSTEM_PROMPT = `You are a Kisaragi sub-agent — a specialist worker that completes tasks and reports results.

Available tools: read, write, edit, bash, glob, grep, webSearch, webFetch, listDir, mkDir, remove, bg, ps, kill, gitStatus, gitDiff, gitLog, gitAdd, gitCommit, lint, askUser, writeTodos, suggestFollowups, readUrl, readSubtree, renderUi, skill, set_output.

Rules:
1. Use your available tools to complete the assigned task.
2. Use set_output to report your final structured result when done.
3. Keep responses concise. Do NOT ask the user questions.
4. Do NOT spawn sub-agents or delegate — complete the task yourself.
5. Use bash for terminal commands, read/write/edit for files.
6. For web research, use webSearch then readUrl on results — never guess.`;

const CUSTOM_PROMPT_PATH = join(homedir(), '.kisaragi', 'system.md');

function buildSystemPrompt() {
  if (existsSync(CUSTOM_PROMPT_PATH)) {
    const custom = readFileSync(CUSTOM_PROMPT_PATH, 'utf-8').trim();
    if (custom) return BASE_SYSTEM_PROMPT + '\n\n' + custom;
  }
  return BASE_SYSTEM_PROMPT;
}

// ============================================================
// SOURCE FILE PARSER (for readSubtree)
// ============================================================

function parseSourceSymbols(filePath) {
  try {
    const ext = extname(filePath).toLowerCase();
    if (!['.js','.jsx','.mjs','.cjs','.ts','.tsx','.mts','.cts'].includes(ext)) return [];
    const content = readFileSync(filePath, 'utf-8');
    const symbols = [];
    const patterns = [
      /export\s+(?:default\s+)?(?:function|class|const|let|var|async\s+function)\s+(\w+)/g,
      /(?:function|class)\s+(\w+)/g,
      /^(?:const|let|var)\s+(\w+)\s*[=:]/gm,
      /\.(\w+)\s*[=:]\s*(?:function|\(|async)/g,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(content)) !== null) {
        if (m[1] && !symbols.includes(m[1]) && m[1] !== 'function' && m[1] !== 'class') symbols.push(m[1]);
      }
    }
    return [...new Set(symbols)].slice(0, 30);
  } catch { return []; }
}

const SKIP_DIRS = new Set(['node_modules','dist','build','.cache','.next','__pycache__','target','.git','.svn','.venv','env','venv']);

function buildSubtree(paths, maxTokens) {
  const root = cwd();
  const results = [];

  function walk(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries.sort()) {
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let s;
      try { s = statSync(full); } catch { continue; }
      const rel = relative(root, full);
      if (s.isDirectory()) {
        results.push({ type: 'dir', path: rel });
        walk(full, depth + 1);
      } else {
        const syms = parseSourceSymbols(full);
        results.push({ type: 'file', path: rel, symbols: syms.length ? syms : undefined, size: s.size });
      }
    }
  }

  for (const p of paths) {
    const abs = p.startsWith('/') ? p : join(root, p);
    if (!existsSync(abs)) { results.push({ type: 'error', path: p, message: 'not found' }); continue; }
    const s = statSync(abs);
    if (s.isDirectory()) { results.push({ type: 'dir', path: relative(root, abs) }); walk(abs, 1); }
    else if (s.isFile()) {
      const syms = parseSourceSymbols(abs);
      results.push({ type: 'file', path: relative(root, abs), symbols: syms.length ? syms : undefined, size: s.size });
    }
  }

  let text = '';
  for (const r of results) {
    const indent = r.path.split(sep).length > 1 ? '  '.repeat(r.path.split(sep).length - 1) : '';
    if (r.type === 'dir') text += `${indent}${r.path}/\n`;
    else if (r.type === 'file') text += `${indent}${basename(r.path)}${r.symbols ? `  (${r.symbols.join(', ')})` : ''}\n`;
    else if (r.type === 'error') text += `[${r.path}: ${r.message}]\n`;
    if (text.length > maxTokens * 4) { text += `\n... (truncated, ${results.length} total items)`; break; }
  }
  return text || '(empty)';
}

// ============================================================
// AGENT CLASS
// ============================================================

export class Agent {
  constructor(apiUrl, model, opts = {}) {
    this.apiUrl = apiUrl;
    this.model = model;
    this._apiKey = opts.apiKey || '';
    this.onWriteConfirm = null;
    this.onToolCall = null;
    this.onAskUser = null;
    this.onWriteTodos = null;
    this.onSuggestFollowups = null;
    this.onRenderUi = null;
    this.onRetry = null;
    this.onToken = null;
    this._output = null;
        this._toolFallbackCount = 0;
        this._toolFallbackInjected = false;
        this._nextBgId = 1;
    this.bgProcesses = new Map();
    const sysPrompt = opts.subagent ? SUB_AGENT_SYSTEM_PROMPT : buildSystemPrompt();
    this.messages = [{ role: 'system', content: sysPrompt }];
    this.workingDir = opts.workingDir || cwd();
    this._subagent = !!opts.subagent;
    if (opts.subagent) return;

    this.configDir = join(homedir(), '.kisaragi');
    this.sessionsDir = join(this.configDir, 'sessions');
    this.skillsDir = join(this.configDir, 'skills');
    this.configFile = join(this.configDir, 'config.json');
    if (!existsSync(this.sessionsDir)) mkdirSync(this.sessionsDir, { recursive: true });
    if (!existsSync(this.skillsDir)) mkdirSync(this.skillsDir, { recursive: true });

    let lastSession;
    if (existsSync(this.configFile)) {
      try { lastSession = JSON.parse(readFileSync(this.configFile, 'utf-8')).lastSession; } catch {}
    }

    if (lastSession && this.loadSession(lastSession)) {
      this.currentSession = lastSession;
    } else {
      const name = `session-${Date.now()}`;
      this.newSession(name, true);
      this.currentSession = name;
    }
  }

  reset() {
    this.messages = [{ role: 'system', content: buildSystemPrompt() }];
    this._toolFallbackCount = 0;
    this._toolFallbackInjected = false;
  }

  saveConfig() { writeFileSync(this.configFile, JSON.stringify({ lastSession: this.currentSession }), 'utf-8'); }

  saveSession(name) {
    // Debounce: batch rapid saves into one write
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      writeFileSync(join(this.sessionsDir, `${name}.json`), JSON.stringify(this.messages), 'utf-8');
    }, 500);
  }

  flushSave() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    writeFileSync(join(this.sessionsDir, `${this.currentSession}.json`), JSON.stringify(this.messages), 'utf-8');
  }

  loadSession(name) {
    const path = join(this.sessionsDir, `${name}.json`);
    if (!existsSync(path)) return false;
    this.messages = JSON.parse(readFileSync(path, 'utf-8'));
    this.messages[0] = { role: 'system', content: buildSystemPrompt() };
    return true;
  }

  switchSession(name) {
    this.saveSession(this.currentSession);
    this.currentSession = name;
    this._needsName = false;
    if (!this.loadSession(name)) this.newSession(name, true);
    this.saveConfig();
    return true;
  }

  deleteSession(name) { const p = join(this.sessionsDir, `${name}.json`); if (existsSync(p)) unlinkSync(p); }

  listSessions() {
    if (!existsSync(this.sessionsDir)) return [];
    return readdirSync(this.sessionsDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort((a, b) => a.localeCompare(b));
  }

  newSession(name, skipSave = false) {
    this.messages = [{ role: 'system', content: buildSystemPrompt() }];
    this.currentSession = name;
    this._needsName = true;
    if (!skipSave) this.saveSession(name);
    this.saveConfig();
  }

  setModel(m) { this.model = m; }
  setApiUrl(url) { this.apiUrl = url; }

  async send(userInput, signal) {
    // Prune old messages if context is getting too large
    await this._pruneMessages();
    this.messages.push({ role: 'user', content: userInput });
    this._currentSignal = signal;
    let finalContent = '';
    const needsName = !this._subagent && this._needsName;
    if (needsName) this._needsName = false;

    try {
      for (let round = 0; round < 20; round++) {
        if (signal?.aborted) {
          this.messages.push({ role: 'assistant', content: '[cancelled]' });
          return finalContent + '\n\n[Task cancelled by user]';
        }
        const response = await this.callAPI();
        if (!response) {
          // User cancelled — return a clean cancellation message
          if (signal?.aborted) {
            this.messages.push({ role: 'assistant', content: '[cancelled]' });
            return finalContent + '\n\n[Task cancelled by user]';
          }
          if (!this._subagent) this.saveSession(this.currentSession);
          if (this._toolFallbackCount > 2) {
            return finalContent + '\n\n[Warning: Tool calls are failing. The API may not support function calling with this model.]';
          }
          // Return partial output with a fallback message instead of null
          const fallback = finalContent || 'I encountered a connection issue. Let me try again — please rephrase your request.';
          return fallback + (this._subagent ? '' : '\n\n[Connection issue, please retry]');
        }

        const content = response.content || '';
        const toolCalls = response.tool_calls || [];

        if (toolCalls.length > 0) {
          finalContent += content || '';
          this.messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });
          for (const tc of toolCalls) {
            if (signal?.aborted) {
              this.messages.push({ role: 'tool', tool_call_id: tc.id, content: '[cancelled]' });
              continue;
            }
            const args = this.safeParse(tc.function?.arguments);
            const result = await this.executeTool(tc.function?.name, args);
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            this.messages.push({ role: 'tool', tool_call_id: tc.id, content: resultStr });
            // Sub-agent set_output — return early (main agent should never call this)
            if (this._output && tc.function?.name === 'set_output') {
              if (this._subagent) {
                const output = this._output;
                this._output = null;
                this.messages.push({ role: 'assistant', content: `[set_output: ${JSON.stringify(output)}]` });
                return JSON.stringify(output);
              }
              this._output = null; // Main agent called it — ignore silently
            }
          }
          continue;
        }

        const textCall = this.parseTextToolCall(content);
        if (textCall) {
          if (signal?.aborted) {
            this.messages.push({ role: 'assistant', content: '[cancelled]' });
            return finalContent + '\n\n[Task cancelled by user]';
          }
          finalContent += content.replace(textCall.raw, '').trim();
          this.messages.push({ role: 'assistant', content: content.replace(textCall.raw, '').trim() || null });
          const result = await this.executeTool(textCall.name, textCall.arguments);
          const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
          this.messages.push({ role: 'user', content: `[Tool ${textCall.name}]:\n${resultStr}\n\nContinue.` });
          continue;
        }

        // Strip any unparseable TOOL_CALL: text from the final output
        // Strip any unparseable TOOL_CALL: blocks using proper brace-matching
        // (regex with [^}]* doesn't handle nested braces in JSON)
        let clean = content;
        while (clean.includes('TOOL_CALL:')) {
          const idx = clean.indexOf('TOOL_CALL:');
          const brace = clean.indexOf('{', idx);
          if (brace === -1) break;
          let depth = 1, pos = brace;
          while (depth > 0 && pos < clean.length - 1) {
            pos++;
            if (clean[pos] === '{') depth++;
            else if (clean[pos] === '}') depth--;
          }
          clean = (clean.slice(0, idx) + clean.slice(pos + 1)).trim();
        }
        this.messages.push({ role: 'assistant', content: clean });
        if (!this._subagent) this.saveSession(this.currentSession);
        if (needsName) await this._renameFrom(userInput);
        return finalContent + clean;
      }

      if (!this._subagent) this.saveSession(this.currentSession);
      if (needsName) await this._renameFrom(userInput);
      return finalContent;
    } finally {
      this._currentSignal = null;
    }
  }

  async _renameFrom(firstMsg) {
    try {
      const res = await fetch(this.apiUrl + '?stream=false', {
        method: 'POST', headers: this._getHeaders(), keepalive: true,
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            { role: 'system', content: 'Reply with ONLY a short title (2-5 words) for this conversation based on the user\'s first message. No quotes, no prefix, no punctuation.' },
            { role: 'user', content: firstMsg }
          ]
        })
      });
      if (!res.ok) return;
      const data = await res.json();
      let name = (data.choices?.[0]?.message?.content || data.content || '').trim();
      name = name.replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, '').trim();
      name = name.replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!name || name === this.currentSession) return;
      const oldPath = join(this.sessionsDir, `${this.currentSession}.json`);
      const newPath = join(this.sessionsDir, `${name}.json`);
      if (existsSync(oldPath) && !existsSync(newPath)) { writeFileSync(newPath, readFileSync(oldPath, 'utf-8')); unlinkSync(oldPath); }
      this.currentSession = name;
      this.saveConfig();
    } catch {}
  }

  // ============================================================
  // CONTEXT PRUNING — keeps conversation under budget
  // ============================================================

  _estimateTokens() {
    try {
      const text = JSON.stringify(this.messages);
      return Math.ceil(text.length / 4); // rough: ~4 chars per token
    } catch { return 0; }
  }

  async _pruneMessages() {
    // Subagents are short-lived; no pruning needed
    if (this._subagent) return;

    const estTokens = this._estimateTokens();
    const BUDGET = 14000; // Conservative max tokens — leaves room for tool results + response

    // Only prune if over budget AND we have enough messages worth pruning
    if (estTokens < BUDGET || this.messages.length < 12) return;

    // Save full history to disk before modifying in-memory state
    this.flushSave();

    // Strategy: keep system prompt + last N complete messages,
    // summarize everything before that into a single condensed message

    const systemMsg = this.messages[0];

    // Find a clean cut point — walk backward to find a safe boundary
    // We want to keep roughly the last 6-8 messages (2-3 exchanges)
    const keepCount = Math.min(8, this.messages.length - 2);
    let cutIdx = this.messages.length - keepCount;

    // Adjust cutIdx to not split a tool_call chain:
    // if cutIdx lands on a 'tool' result, walk backward to its assistant
    while (cutIdx > 1 && this.messages[cutIdx]?.role === 'tool') {
      cutIdx--;
    }
    // Also avoid cutting right after an assistant with tool_calls
    // (if the cut would separate tool_calls from their results)
    if (cutIdx > 1 && this.messages[cutIdx - 1]?.tool_calls) {
      // Find the last tool result for this assistant and include it
      let lastToolIdx = cutIdx;
      while (lastToolIdx < this.messages.length && this.messages[lastToolIdx]?.role === 'tool') {
        lastToolIdx++;
      }
      cutIdx = lastToolIdx; // Include all tool results
    }

    const oldMsgs = this.messages.slice(1, cutIdx);
    const recentMsgs = this.messages.slice(cutIdx);

    if (oldMsgs.length < 3) return; // Not enough to bother

    // Try to generate a summary using the API itself
    let summary = null;
    try {
      const res = await fetch(this.apiUrl + '?stream=false', {
        method: 'POST',
        headers: this._getHeaders(),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            {
              role: 'system',
              content: 'Summarize the following conversation exchange in 1-3 concise sentences. Focus on: what the user requested, what actions were taken (files modified, commands run), and any important decisions or results. Omit specific code details and command outputs.'
            },
            ...oldMsgs
          ]
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (res.ok) {
        const data = await res.json();
        summary = (data.choices?.[0]?.message?.content || data.content || '').trim();
      }
    } catch {}

    if (summary && summary.length > 5) {
      // Successful summary — replace old messages with condensed version
      this.messages = [
        systemMsg,
        { role: 'user', content: `[Previous conversation context: ${summary}]` },
        ...recentMsgs
      ];
    } else {
      // Fallback: simple sliding window — keep last 16 messages
      this.messages = [
        systemMsg,
        ...this.messages.slice(-16)
      ];
    }
  }

  async _abortableDelay(ms) {
    await Promise.race([
      new Promise(r => setTimeout(r, ms)),
      this._currentSignal
        ? new Promise(r => {
            if (this._currentSignal.aborted) r();
            else this._currentSignal.addEventListener('abort', () => r(), { once: true });
          })
        : new Promise(() => {}) // never resolves
    ]);
  }

  safeParse(str) { try { return JSON.parse(str || '{}'); } catch { return {}; } }

  parseTextToolCall(text) {
    if (!text || !text.includes('TOOL_CALL:')) return null;

    // Strip markdown code blocks (```TOOL_CALL: {...}```)
    let clean = text.replace(/```(?:json)?\s*\n?/gi, '');

    // Try to find TOOL_CALL: pattern — handle multi-line and various spacing
    const tcRegex = /TOOL_CALL\s*:\s*/i;
    const match = tcRegex.exec(clean);
    if (!match) return null;
    const tcEnd = match.index + match[0].length;

    // Find the JSON object starting after TOOL_CALL:
    const brace = clean.indexOf('{', tcEnd);
    if (brace === -1) return null;

    // Collect the raw text from TOOL_CALL: through the end
    const rawPrefix = text.slice(text.indexOf('TOOL_CALL:'), text.indexOf('{', text.indexOf('TOOL_CALL:')));

    // Try multiple strategies to parse the JSON
    const jsonStr = clean.slice(brace);

    // Strategy 1: Proper brace matching (handles nested {})
    const result = this._parseJsonWithBraceMatch(jsonStr, text);
    if (result) return result;

    // Strategy 2: Try lastIndexOf('}') — works for most well-formed cases
    const lastBrace = jsonStr.lastIndexOf('}');
    if (lastBrace !== -1) {
      try {
        const parsed = JSON.parse(jsonStr.slice(0, lastBrace + 1));
        if (parsed && parsed.name) {
          const rawEnd = text.indexOf('}', text.indexOf('TOOL_CALL:'));
          // Find the matching raw end
          let depth = 1, pos = text.indexOf('{', text.indexOf('TOOL_CALL:'));
          while (depth > 0 && pos < text.length - 1) {
            pos++;
            if (text[pos] === '{') depth++;
            else if (text[pos] === '}') depth--;
          }
          const raw = text.slice(text.indexOf('TOOL_CALL:'), pos + 1);
          return { name: parsed.name, arguments: parsed.arguments || {}, raw };
        }
      } catch {}
    }

    // Strategy 3: Try fixing common JSON issues
    return this._tryFixJson(jsonStr, text, tcEnd);
  }

  _parseJsonWithBraceMatch(jsonStr, fullText) {
    // Find matching closing brace accounting for nesting
    let depth = 1;
    let pos = 0;
    while (depth > 0 && pos < jsonStr.length - 1) {
      pos++;
      if (jsonStr[pos] === '{') depth++;
      else if (jsonStr[pos] === '}') depth--;
    }
    if (depth !== 0) return null;
    try {
      const parsed = JSON.parse(jsonStr.slice(0, pos + 1));
      if (!parsed || !parsed.name) return null;
      // Find the same position in the original text
      const tcIdx = fullText.indexOf('TOOL_CALL:');
      let rawDepth = 1, rawPos = fullText.indexOf('{', tcIdx);
      while (rawDepth > 0 && rawPos < fullText.length - 1) {
        rawPos++;
        if (fullText[rawPos] === '{') rawDepth++;
        else if (fullText[rawPos] === '}') rawDepth--;
      }
      const raw = fullText.slice(tcIdx, rawPos + 1);
      return { name: parsed.name, arguments: parsed.arguments || {}, raw };
    } catch {
      return null;
    }
  }

  _tryFixJson(jsonStr, fullText, tcEnd) {
    // Try common fixes for dumber models' JSON output
    const fixes = [
      // Fix: unquoted keys like {name: "askUser"} → {"name": "askUser"}
      (s) => s.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3'),
      // Fix: single quotes → double quotes
      (s) => s.replace(/'/g, '"'),
      // Fix: trailing comma before }
      (s) => s.replace(/,+\s*}/g, '}').replace(/,+\s*]/g, ']'),
      // Fix: undefined → null
      (s) => s.replace(/\bundefined\b/g, 'null'),
      // Fix: comment lines starting with //
      (s) => s.replace(/\/\/[^\n]*/g, ''),
    ];

    // Apply all fixes in sequence (chained), then try JSON.parse once
    // This handles combined issues like {name: "askUser",} (unquoted keys + trailing comma)
    const combined = fixes.reduce((s, f) => f(s), jsonStr);
    try {
      const parsed = JSON.parse(combined);
      if (parsed && parsed.name) {
        const tcIdx = fullText.indexOf('TOOL_CALL:');
        let depth = 1, pos = fullText.indexOf('{', tcIdx);
        while (depth > 0 && pos < fullText.length - 1) {
          pos++;
          if (fullText[pos] === '{') depth++;
          else if (fullText[pos] === '}') depth--;
        }
        const raw = fullText.slice(tcIdx, pos + 1);
        return { name: parsed.name, arguments: parsed.arguments || {}, raw };
      }
    } catch {}

    // Fallback: try each fix individually
    for (const fix of fixes) {
      try {
        const fixed = fix(jsonStr);
        const parsed = JSON.parse(fixed);
        if (parsed && parsed.name) {
          const tcIdx = fullText.indexOf('TOOL_CALL:');
          let depth = 1, pos = fullText.indexOf('{', tcIdx);
          while (depth > 0 && pos < fullText.length - 1) {
            pos++;
            if (fullText[pos] === '{') depth++;
            else if (fullText[pos] === '}') depth--;
          }
          const raw = fullText.slice(tcIdx, pos + 1);
          return { name: parsed.name, arguments: parsed.arguments || {}, raw };
        }
      } catch {}
    }
    return null;
  }

  async callAPI() {
    const withTools = await this.tryCall(this.apiUrl, true, true);
    if (withTools) return withTools;
    // User cancelled — don't retry without tools, just return clean
    if (this._currentSignal?.aborted) return null;
    // If tools fail, try without — inject a reinforcing instruction so the model still outputs TOOL_CALL: format
    // Only inject once per conversation to avoid duplicate messages piling up
    if (this._toolFallbackCount > 0 && !this._toolFallbackInjected) {
      this._toolFallbackInjected = true;
      this.messages.push({
        role: 'system',
        content: '[IMPORTANT] This API does not support native function calling. You MUST use the text-based TOOL_CALL format to call tools.\n\nFormat: TOOL_CALL: {"name":"tool_name","arguments":{...}}\n\nDo NOT wrap TOOL_CALL in markdown code blocks. Output the TOOL_CALL on its own line, followed by the JSON.\n\nExample:\nTOOL_CALL: {"name":"askUser","arguments":{"questions":[{"question":"What color?","options":[{"label":"Red"},{"label":"Blue"}]}]}}\n\nAvailable tools: read, write, edit, bash, glob, grep, webSearch, webFetch, listDir, mkDir, remove, bg, ps, kill, gitStatus, gitDiff, gitLog, gitAdd, gitCommit, askUser, writeTodos, suggestFollowups, readUrl, renderUi.'
      });
    }
    const withoutTools = await this.tryCall(this.apiUrl, false, true);
    return withoutTools;
  }

  _getHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (this._apiKey) headers['Authorization'] = `Bearer ${this._apiKey}`;
    return headers;
  }

  async tryCall(url, withTools, isStream) {
    const body = { messages: this.messages };
    if (isStream) body.stream = true;
    if (this.model) body.model = this.model;
    if (withTools) {
      // Sub-agents: strip spawnAgents and task to prevent recursion
      body.tools = this._subagent
        ? TOOL_DEFS.filter(t => t.function.name !== 'spawnAgents' && t.function.name !== 'task')
        : TOOL_DEFS;
      body.tool_choice = 'auto';
    }

    const reqUrl = isStream ? url + '?stream=true' : url;

    for (let attempt = 0; attempt <= 3; attempt++) {
      if (this._currentSignal?.aborted) {
        if (withTools) { this._toolFallbackCount++; return null; }
        throw new Error('Request cancelled');
      }
      const controller = new AbortController();
      let onAbort;
      if (this._currentSignal) {
        onAbort = () => { try { controller.abort(); } catch {} };
        this._currentSignal.addEventListener('abort', onAbort, { once: true });
      }
      const timeout = setTimeout(() => { try { controller.abort(); } catch {} }, 120000);

      try {
        const res = await fetch(reqUrl, {
          method: 'POST', headers: this._getHeaders(),
          body: JSON.stringify(body), signal: controller.signal
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const isRateLimit = res.status === 429 || text.includes('rate limit') || text.includes('429') || text.includes('too many requests');
          const isToolNotSupported = withTools && (res.status === 400 && text.toLowerCase().includes('tool'));

          if (isToolNotSupported) {
            this._toolFallbackCount++;
            return null; // Tools not supported by this API/model
          }

          if (isRateLimit && attempt < 3) {
            const delay = (attempt + 1) * 4000;
            if (this.onRetry) this.onRetry({ attempt: attempt + 1, max: 3, reason: 'rate limited', delay });
            await this._abortableDelay(delay);
            if (this._currentSignal?.aborted) { if (withTools) { this._toolFallbackCount++; return null; } throw new Error('Request cancelled'); }
            continue;
          }
          if (isRateLimit) {
            throw new Error(`Model "${this.model}" is overloaded. Try /model <name> to switch, or try again later.`);
          }
          // For transient errors (5xx, network), retry; for client errors (4xx without tool), fail immediately
          if (withTools) {
            if (res.status >= 500 && attempt < 3) {
              const delay = (attempt + 1) * 3000;
              if (this.onRetry) this.onRetry({ attempt: attempt + 1, max: 3, reason: `HTTP ${res.status}`, delay });
              await this._abortableDelay(delay);
              if (this._currentSignal?.aborted) { if (withTools) { this._toolFallbackCount++; return null; } throw new Error('Request cancelled'); }
              continue;
            }
            // Client errors: fall back once, but mark it
            this._toolFallbackCount++;
            return null;
          }
          throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
        }

        return await this.parseStream(res);

      } catch (err) {
        if (err.name === 'AbortError' && attempt < 3 && !this._currentSignal?.aborted) {
          if (this.onRetry) this.onRetry({ attempt: attempt + 1, max: 3, reason: 'timeout', delay: 3000 });
          await this._abortableDelay(3000);
          if (this._currentSignal?.aborted) { if (withTools) { this._toolFallbackCount++; return null; } throw new Error('Request cancelled'); }
          continue;
        }
        if (withTools) { this._toolFallbackCount++; return null; }
        throw err;
      } finally {
        clearTimeout(timeout);
        if (onAbort && this._currentSignal) {
          try { this._currentSignal.removeEventListener('abort', onAbort); } catch {}
        }
      }
    }
  }

  async parseStream(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', content = '';
    const toolCalls = {};

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith('data: ')) continue;
        const d = t.slice(6);
        if (d === '[DONE]') { reader.cancel(); return this.buildResult(content, toolCalls); }

        try {
          const p = JSON.parse(d);
          const delta = p.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) {
            content += delta.content;
            if (this.onToken) this.onToken(delta.content);
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
              if (tc.id) toolCalls[idx].id = tc.id;
              if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
            }
          }
        } catch {}
      }
    }

    return this.buildResult(content, toolCalls);
  }

  buildResult(content, toolCalls) {
    const tc = Object.values(toolCalls);
    return { content, tool_calls: tc.length ? tc : undefined };
  }

  async executeTool(name, args) {
    if (this.onToolCall) this.onToolCall(name, args);
    try {
      const result = await this._exec(name, args);
      if (!this.toolHistory) this.toolHistory = [];
      this.toolHistory.push({ name, args, result: typeof result === 'string' ? result.slice(0, 2000) : JSON.stringify(result).slice(0, 2000) });
      return result;
    } catch (err) {
      return `Tool error: ${err.message}`;
    }
  }

  async _exec(name, args) {
    switch (name) {
      case 'read': {
        const p = this.resolve(args.path);
        if (!existsSync(p)) return `Error: not found: ${args.path}`;
        const stat = statSync(p);
        if (stat.isDirectory()) return readdirSync(p).join('\n');
        const lines = readFileSync(p, 'utf-8').split('\n');
        const start = args.offset ? args.offset - 1 : 0;
        const end = args.limit ? start + args.limit : lines.length;
        return lines.slice(start, end).map((l, j) => `${start + j + 1}: ${l}`).join('\n');
      }
      case 'write': {
        const p = this.resolve(args.path);
        const dir = p.substring(0, p.lastIndexOf('/'));
        if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
        if (existsSync(p) && this.onWriteConfirm && !args._force) {
          const oldContent = readFileSync(p, 'utf-8');
          if (oldContent !== args.content) {
            if (!(await this.onWriteConfirm(args.path, oldContent, args.content))) return 'Write cancelled.';
          }
        }
        writeFileSync(p, args.content, 'utf-8');
        return `Written ${args.path} (${args.content.length} bytes)`;
      }
      case 'edit': {
        const p = this.resolve(args.path);
        const curr = readFileSync(p, 'utf-8');
        if (!curr.includes(args.old)) return 'Error: text not found';
        if (curr.indexOf(args.old) !== curr.lastIndexOf(args.old)) return 'Error: multiple matches';
        writeFileSync(p, curr.replace(args.old, args.new), 'utf-8');
        return `Edited ${args.path}`;
      }
      case 'bash': {
        const timeout = args.timeout || 30000;
        const opts = { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, stdio: 'pipe', timeout };
        if (args.workdir) opts.cwd = this.resolve(args.workdir);
        const run = () => {
          const out = execSync(args.command, opts)?.toString().trim() || '';
          return out.length > 10000 ? out.slice(0, 10000) + '\n...(truncated)' : out || '(no output)';
        };
        try { return run(); } catch (e) {
          if (e.killed || e.signal === 'SIGTERM') {
            const partial = e.stdout?.toString().trim() || '';
            return `${partial ? partial + '\n' : ''}[TIMEOUT after ${timeout/1000}s. For long processes, use bg tool.]`;
          }
          const stderr = e.stderr?.toString().trim() || '';
          const stdout = e.stdout?.toString().trim() || '';
          const code = e.status;
          let msg = [stderr, stdout].filter(Boolean).join('\n') || `Exit code ${code}`;
          const nfMatches = [...msg.matchAll(/(\S+):\s*(?:not found|command not found)/g)];
          if (nfMatches.length) {
            const last = nfMatches[nfMatches.length - 1][1].replace(/.*\//, '').trim();
            if (last !== 'sh' && last !== 'bash') {
              for (const cmd of [`apt-get install -y ${last}`, `npm install -g ${last}`, `pip install ${last}`]) {
                try { execSync(cmd, { timeout: 60000, encoding: 'utf-8', stdio: 'pipe' }); return run(); } catch {}
              }
              msg += `\n[HINT: Could not auto-install "${last}".]`;
            }
          }
          return msg.length > 8000 ? msg.slice(0, 8000) + '\n...(truncated)' : msg;
        }
      }
      case 'glob': return globSync(args.pattern, args.path ? this.resolve(args.path) : this.workingDir).join('\n');
      case 'grep': {
        let cmd = `rg -n '${args.pattern.replace(/'/g, "'\\''")}'`;
        if (args.include) cmd += ` -g '${args.include}'`;
        cmd += ` '${(args.path ? this.resolve(args.path) : this.workingDir).replace(/'/g, "'\\''")}' 2>/dev/null`;
        try { return execSync(cmd, { encoding: 'utf-8', timeout: 15000 }) || 'No matches'; } catch { return 'No matches'; }
      }
      case 'webSearch': {
        try {
          const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(args.query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36' }, signal: AbortSignal.timeout(12000)
          });
          if (!res.ok) return 'Search failed';
          const html = await res.text();
          const results = [];
          const blocks = html.split(/<li class="b_algo"/g);
          for (let i = 1; i < blocks.length && results.length < 8; i++) {
            const b = blocks[i];
            const tm = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
            const lm = b.match(/href="(https?:\/\/[^"]+)"/);
            const sm = b.match(/<p[^>]*class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/);
            if (tm) {
              const title = tm[1].replace(/<[^>]+>/g, '').trim();
              const snippet = sm ? sm[1].replace(/<[^>]+>/g, '').trim() : '';
              const url = lm ? lm[1] : '';
              if (title) results.push(`${title}${url ? '\n  ' + url : ''}${snippet ? '\n  ' + snippet : ''}`);
            }
          }
          if (results.length) return results.join('\n\n');
          const clean = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          return clean.length > 200 ? clean.slice(0, 5000) : 'Search failed';
        } catch { return 'Search failed'; }
      }
      case 'webFetch':
      case 'readUrl': {
        try {
          const maxChars = args.max_chars || 20000;
          const res = await fetch(args.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
          let html = await res.text();
          const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
          const title = titleMatch ? titleMatch[1].trim() : '';
          const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
          const desc = descMatch ? descMatch[1].trim() : '';
          let text = '';
          const mainMatch = html.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
          if (mainMatch) text = mainMatch[1];
          else { const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i); text = bodyMatch ? bodyMatch[1] : html; }
          text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<(?:nav|footer|header)[^>]*>[\s\S]*?<\/(?:nav|footer|header)>/gi, '')
            .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
          let result = title ? `Title: ${title}\n` : '';
          if (desc) result += `Description: ${desc}\n`;
          result += `\n${text}`;
          return result.length > maxChars ? result.slice(0, maxChars) + '\n...(truncated)' : result || '(empty page)';
        } catch (e) { return `Fetch failed: ${e.message}`; }
      }
      case 'listDir': {
        const p = this.resolve(args.path);
        if (!existsSync(p)) return `Error: not found: ${args.path}`;
        return readdirSync(p, { withFileTypes: true }).map(e => e.isDirectory() ? `${e.name}/` : e.name).join('\n');
      }
      case 'mkDir': mkdirSync(this.resolve(args.path), { recursive: true }); return `Created: ${args.path}`;
      case 'remove': {
        const p = this.resolve(args.path);
        if (!existsSync(p)) return `Error: not found: ${args.path}`;
        const s = statSync(p);
        if (s.isDirectory()) { if (!args.recursive) return `Error: ${args.path} is a directory, use recursive: true`; rmSync(p, { recursive: true }); }
        else unlinkSync(p);
        return `Removed: ${args.path}`;
      }
      case 'bg': {
        const id = this._nextBgId++;
        const proc = spawn(args.command, [], { shell: true, cwd: args.workdir ? this.resolve(args.workdir) : this.workingDir, stdio: ['pipe','pipe','pipe'] });
        let output = '';
        proc.stdout.on('data', d => { output += d.toString(); });
        proc.stderr.on('data', d => { output += d.toString(); });
        const entry = { proc, command: args.command, output, status: 'running', startTime: Date.now() };
        this.bgProcesses.set(id, entry);
        proc.on('exit', (code) => { const e = this.bgProcesses.get(id); if (e) e.status = `exited(${code})`; });
        return `Started task #${id} (PID ${proc.pid}): ${args.command}`;
      }
      case 'ps': {
        if (!this.bgProcesses.size) return 'No background processes.';
        return [...this.bgProcesses].map(([id, p]) => {
          const elapsed = ((Date.now() - p.startTime) / 1000).toFixed(1);
          const out = p.output.slice(-300).replace(/\n/g, '\\n');
          return `#${id} [${p.status}] PID ${p.proc.pid} ${elapsed}s: ${p.command.slice(0, 60)}${out ? '\n  ' + out : ''}`;
        }).join('\n');
      }
      case 'kill': { const p = this.bgProcesses.get(args.id); if (!p) return `No task #${args.id}`; try { p.proc.kill('SIGTERM'); } catch {} p.status = 'killed'; return `Killed task #${args.id} (PID ${p.proc.pid})`; }
      case 'gitStatus': return execSync('git status', { cwd: this.workingDir, encoding: 'utf-8', stdio: 'pipe' }).toString().trim() || '(empty)';
      case 'gitDiff': {
        let cmd = 'git diff';
        if (args.staged) cmd += ' --staged';
        if (args.ref1) cmd += ' ' + args.ref1;
        if (args.ref2) cmd += ' ' + args.ref2;
        try { return execSync(cmd, { cwd: this.workingDir, encoding: 'utf-8', stdio: 'pipe' }).toString().trim() || '(no changes)'; } catch (e) { return e.stderr?.toString().trim() || 'git diff failed'; }
      }
      case 'gitLog': { try { return execSync(`git log --oneline --decorate -${args.count || 10}`, { cwd: this.workingDir, encoding: 'utf-8', stdio: 'pipe' }).toString().trim() || '(empty)'; } catch (e) { return e.stderr?.toString().trim() || 'git log failed'; } }
      case 'gitAdd': { try { return execSync(`git add ${args.path}`, { cwd: this.workingDir, encoding: 'utf-8', stdio: 'pipe' }).toString().trim() || `Staged: ${args.path}`; } catch (e) { return e.stderr?.toString().trim() || 'git add failed'; } }
      case 'gitCommit': { try { const addAll = args.addAll ? 'git add -u && ' : ''; return execSync(`${addAll}git commit -m "${args.message.replace(/"/g, '\\"')}"`, { cwd: this.workingDir, encoding: 'utf-8', stdio: 'pipe' }).toString().trim() || 'Committed.'; } catch (e) { return e.stderr?.toString().trim() || 'git commit failed'; } }
      case 'task': {
        const sub = new Agent(this.apiUrl, this.model, { subagent: true, workingDir: this.workingDir, apiKey: this._apiKey });
        if (this.onToolCall) { const p = this.onToolCall; sub.onToolCall = (n, a) => p(n, a, true); }
        sub.onWriteConfirm = this.onWriteConfirm;
        sub.onAskUser = this.onAskUser; sub.onWriteTodos = this.onWriteTodos; sub.onSuggestFollowups = this.onSuggestFollowups; sub.onRenderUi = this.onRenderUi;
        return (await sub.send(args.prompt, this._currentSignal)) || '(no result)';
      }
      case 'lint': {
        const dir = args.workdir ? this.resolve(args.workdir) : this.workingDir;
        if (args.command) { try { const o = execSync(args.command, { cwd: dir, encoding: 'utf-8', timeout: 60000 }).toString().trim(); return o || 'PASSED'; } catch (e) { return `FAILED (exit ${e.status}):\n${(e.stderr?.toString() || e.stdout?.toString() || '').trim().slice(0, 3000)}`; } }
        const files = readdirSync(dir);
        const run = (cmd) => { try { const o = execSync(cmd, { cwd: dir, encoding: 'utf-8', timeout: 60000 }).toString().trim(); return o || '(passed)'; } catch (e) { return `FAILED (exit ${e.status}):\n${(e.stderr?.toString() || e.stdout?.toString() || '').trim().slice(0, 3000)}`; } };
        if (files.includes('package.json')) {
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
          if (pkg.scripts?.typecheck) return 'typecheck:\n' + run('npm run typecheck');
          if (pkg.scripts?.lint) return 'lint:\n' + run('npm run lint');
          if (pkg.scripts?.test) return 'test:\n' + run('npm test');
          return files.filter(f => f.endsWith('.js') || f.endsWith('.mjs')).map(f => { try { execSync(`node -c "${f}"`, { cwd: dir, timeout: 15000 }); return `${f}: OK`; } catch (e) { return `${f}: FAIL\n${(e.stderr?.toString() || '').trim().split('\n').pop()}`; } }).join('\n') || '(no JS files)';
        }
        if (files.includes('Cargo.toml')) return run(files.includes('src/lib.rs') ? 'cargo clippy 2>&1; cargo test 2>&1' : 'cargo check 2>&1');
        if (files.includes('go.mod')) return run('go vet ./... 2>&1');
        if (files.includes('Makefile') || files.includes('makefile')) return run('make lint 2>&1 || make test 2>&1');
        if (files.includes('pyproject.toml') || files.includes('setup.py') || files.includes('requirements.txt')) return run('python -m pytest 2>&1 || python -m unittest 2>&1');
        return 'No recognized project config. Specify a command manually.';
      }
      case 'spawnAgents': {
        if (!Array.isArray(args.agents) || !args.agents.length) return 'No agents specified.';
        const results = await Promise.all(args.agents.map(async (spec) => {
          if (!AGENT_TYPES[spec.agent_type]) return { agent_type: spec.agent_type, error: `Unknown type. Valid: ${Object.keys(AGENT_TYPES).join(', ')}` };
          const sub = new Agent(this.apiUrl, this.model, { subagent: true, workingDir: this.workingDir, apiKey: this._apiKey });
          if (this.onToolCall) { const p = this.onToolCall; sub.onToolCall = (n, a) => p(n, a, true); }
          sub.onWriteConfirm = this.onWriteConfirm; sub.onAskUser = this.onAskUser; sub.onWriteTodos = this.onWriteTodos; sub.onSuggestFollowups = this.onSuggestFollowups; sub.onRenderUi = this.onRenderUi;
          const prompt = `${AGENT_PROMPTS[spec.agent_type] || ''}\n\nTask: ${spec.prompt}${spec.params ? '\nParams: ' + JSON.stringify(spec.params) : ''}\n\nUse available tools to complete this task. Use set_output to report your final result.`;
          return { agent_type: spec.agent_type, result: (await sub.send(prompt)) || '(no result)' };
        }));
        return JSON.stringify(results, null, 2);
      }
      case 'askUser': {
        if (this.onAskUser) return JSON.stringify(await this.onAskUser(args.questions));
        const lines = args.questions.map((q, i) => `Q${i+1}: ${q.question}\n` + q.options.map((o, j) => `  ${j+1}. ${o.label}${o.description ? ' - ' + o.description : ''}`).join('\n'));
        return `[AskUser needs terminal]\n\n${lines.join('\n\n')}`;
      }
      case 'writeTodos': { if (this.onWriteTodos) this.onWriteTodos(args.todos); const done = args.todos.filter(t => t.completed).length; return `[Todos: ${done}/${args.todos.length}]\n` + args.todos.map(t => `  ${t.completed ? '[✓]' : '[ ]'} ${t.task}`).join('\n'); }
      case 'suggestFollowups': { if (this.onSuggestFollowups) this.onSuggestFollowups(args.followups); return `[Followups: ${args.followups.map(f => f.label || f.prompt.slice(0,40)).join(', ')}]`; }
      case 'renderUi': { if (this.onRenderUi) this.onRenderUi(args.widget); const w = args.widget; return w.type === 'button' ? `[Button: ${w.text} → ${w.link}]` : `[UI: ${w.type}]`; }
      case 'skill': {
        const name = args.name;
        const paths = [join(this.skillsDir, `${name}.md`), join(this.workingDir, '.kisaragi', 'skills', `${name}.md`)];
        for (const p of paths) { if (existsSync(p)) return readFileSync(p, 'utf-8').trim(); }
        return `Skill "${name}" not found.`;
      }
      case 'readSubtree': return buildSubtree(args.paths || ['.'], args.maxTokens || 4000);
      case 'set_output': { this._output = args.data || { message: '(empty)' }; return '[Output set]'; }
      default: return `Unknown tool: ${name}`;
    }
  }

  resolve(p) { return p.startsWith('/') ? p : `${this.workingDir}/${p}`; }
}
