// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Sections 3, 5, 6, 7 and 8: a file as lines, matching at three tiers, and the unified,
// SEARCH/REPLACE and V4A readers. Each reader turns the patch text into edits (section 10's
// closures) without looking at the tree, so a parse error is reported before any file is read.

interface FileLines {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const parts = text.split(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

type Tier = 0 | 1 | 2;

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => stripTrail(s.replace(/^[ \t]+/, ''));

function lineEq(a: string, b: string, tier: Tier): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function leadWs(s: string): string {
  return /^[ \t]*/.exec(s)![0];
}

/** Every start position at or after `from` where o occurs in lines at `tier` (with eofOnly, only ones ending at the last line). */
function occurrences(lines: string[], o: string[], tier: Tier, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    if (eofOnly && i + o.length !== lines.length) continue;
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which o occurs, and its positions there; null when it occurs at no tier (section 5). */
function findMatch(lines: string[], o: string[], strict: boolean, from = 0, eofOnly = false): { tier: Tier; positions: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(lines, o, tier, from, eofOnly);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a replacement: a context line (fromO is its index in O) or a line the patch adds. */
interface NEnt {
  fromO: number | null;
  text: string;
  noNl: boolean;
}

/** The lines a match writes: context lines are the file's own, added lines are as written (re-indented at tier 2). */
function buildN(fileLines: string[], pos: number, o: string[], n: NEnt[], tier: Tier): string[] {
  const f = leadWs(fileLines[pos] ?? '');
  const p = leadWs(o[0] ?? '');
  return n.map((e) => {
    if (e.fromO !== null) return fileLines[pos + e.fromO]!;
    if (tier !== 2 || e.text.trim() === '') return e.text;
    return e.text.startsWith(p) ? f + e.text.slice(p.length) : e.text;
  });
}

/** A body line of a unified hunk or a V4A chunk. rawEmpty: the patch line itself was empty. */
interface BEnt {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNl: boolean;
  rawEmpty: boolean;
}

/** Splits body entries into O (context and old lines) and N (context and new lines), in body order. */
function bodyON(entries: BEnt[]): { o: string[]; n: NEnt[] } {
  const o: string[] = [];
  const n: NEnt[] = [];
  for (const e of entries) {
    if (e.kind === 'ctx') {
      n.push({ fromO: o.length, text: e.text, noNl: e.noNl });
      o.push(e.text);
    } else if (e.kind === 'old') o.push(e.text);
    else n.push({ fromO: null, text: e.text, noNl: e.noNl });
  }
  return { o, n };
}

// ---- Unified diffs (section 6).

interface Hunk {
  a: number;
  entries: BEnt[];
}

interface USection {
  oldPath: string | null; // null stands for /dev/null
  newPath: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The path a --- or +++ line names: text after the four characters, to the first tab, spaces removed. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  return raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
}

/** The two paths of a `diff --git a/<X> b/<Y>` line; a line not of that form is a parse error at its line. */
function gitPaths(line: string, lineNo: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  const k = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
  if (k < 0 || rest.slice(2, k) === '' || rest.slice(k + 3) === '') throw new Exit2(`error: parse ${lineNo}`);
  return [rest.slice(2, k), rest.slice(k + 3)];
}

function applyHunks(text: string, path: string, hunks: Hunk[], strict: boolean): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = bodyON(h.entries);
    if (o.length > 0) {
      const found = findMatch(f.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      for (const p of found.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      const repl = buildN(f.lines, pos, o, n, found.tier);
      const runsEnd = pos + o.length === f.lines.length;
      f.lines.splice(pos, o.length, ...repl);
      if (runsEnd) f.finalBreak = n.length > 0 ? !n[n.length - 1]!.noNl : true;
      d += n.length - o.length;
    } else if (n.length > 0) {
      const at = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...n.map((e) => e.text));
      if (atEnd) f.finalBreak = !n[n.length - 1]!.noNl;
      d += n.length;
    }
  }
  return joinFile(f);
}

function unifiedEdit(sec: USection, strict: boolean, moves: [string, string][]): Edit {
  const { oldPath, newPath, hunks } = sec;
  if (oldPath === null || (sec.newFile && newPath !== null)) {
    const target = newPath ?? '';
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const texts: string[] = [];
      let lastNoNl = false;
      for (const h of hunks)
        for (const e of h.entries)
          if (e.kind === 'new') {
            texts.push(e.text);
            lastNoNl = e.noNl;
          }
      tree.now.set(target, joinFile({ lines: texts, br: '\n', finalBreak: !lastNoNl }));
    };
  }
  if (newPath === null || sec.delFile) {
    const target = oldPath ?? '';
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }
  if (oldPath !== newPath) {
    const from = oldPath!;
    const to = newPath!;
    return (tree) => {
      if (!safe(from)) throw new Fail('unsafe', from);
      if (!safe(to)) throw new Fail('unsafe', to);
      const t = tree.get(from);
      if (t === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      tree.now.set(to, applyHunks(t, from, hunks, strict));
      tree.now.set(from, null);
      moves.push([from, to]);
    };
  }
  const target = oldPath!;
  return (tree) => {
    if (!safe(target)) throw new Fail('unsafe', target);
    const t = tree.get(target);
    if (t === null) throw new Fail('missing', target);
    tree.now.set(target, applyHunks(t, target, hunks, strict));
  };
}

function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  const pairAt = (j: number): boolean => (lines[j] ?? '').startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    let gitOld: string | undefined;
    let gitNew: string | undefined;
    if (line.startsWith('diff --git ')) {
      [gitOld, gitNew] = gitPaths(line, i + 1);
      i += 1;
    } else if (!pairAt(i)) {
      i += 1;
      continue;
    }
    // The section's header: the lines before its first hunk.
    let oldP: string | null | undefined;
    let newP: string | null | undefined;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    let newFile = false;
    let delFile = false;
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        oldP = headerPath(l);
        newP = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (l.startsWith('+++ ')) {
        newP = headerPath(l);
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        renameFrom = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        renameTo = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        newFile = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        delFile = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) break;
      i += 1; // any other header line is ignored (index, old mode, and the like)
    }
    // The section's hunks.
    const hunks: Hunk[] = [];
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ') || pairAt(i)) break;
      if (!l.startsWith('@@')) break;
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i += 1;
      const entries: BEnt[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ') || pairAt(i) || b.startsWith('@@')) break;
        if (b === '') {
          entries.push({ kind: 'ctx', text: '', noNl: false, rawEmpty: true });
          i += 1;
          continue;
        }
        const c = b[0]!;
        if (c === ' ') entries.push({ kind: 'ctx', text: b.slice(1), noNl: false, rawEmpty: false });
        else if (c === '-') entries.push({ kind: 'old', text: b.slice(1), noNl: false, rawEmpty: false });
        else if (c === '+') entries.push({ kind: 'new', text: b.slice(1), noNl: false, rawEmpty: false });
        else if (c === '\\') {
          const last = entries[entries.length - 1];
          if (last !== undefined) last.noNl = true;
          i += 1;
          continue;
        } else break;
        i += 1;
      }
      while (entries.length > 0 && entries[entries.length - 1]!.rawEmpty) entries.pop();
      hunks.push({ a, entries });
    }
    const oldPath = oldP !== undefined ? oldP : renameFrom !== undefined ? renameFrom : gitOld ?? null;
    const newPath = newP !== undefined ? newP : renameTo !== undefined ? renameTo : gitNew ?? null;
    edits.push(unifiedEdit({ oldPath, newPath, newFile, delFile, hunks }, strict, moves));
  }
  return edits;
}

// ---- SEARCH/REPLACE blocks (section 7).

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile({ lines: [...newLines], br: '\n', finalBreak: true }));
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const f = splitFile(t);
    const found = findMatch(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const repl = buildN(f.lines, pos, oldLines, newLines.map((text) => ({ fromO: null, text, noNl: false })), found.tier);
    f.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(f));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const isSearch = (l: string): boolean => l.trimEnd() === '<<<<<<< SEARCH';
  const isDiv = (l: string): boolean => l.trimEnd() === '=======';
  const isRep = (l: string): boolean => l.trimEnd() === '>>>>>>> REPLACE';
  const edits: Edit[] = [];
  let regionStart = 0;
  let lastPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!isSearch(lines[i]!)) {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= regionStart; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (lastPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = lastPath;
    }
    let div = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (isDiv(lines[j]!)) {
        div = j;
        break;
      }
      if (isRep(lines[j]!) || isSearch(lines[j]!)) break;
    }
    if (div < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = div + 1; j < lines.length; j += 1) {
      if (isRep(lines[j]!)) {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, div), lines.slice(div + 1, rep), strict));
    lastPath = path;
    regionStart = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (section 8).

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: BEnt[];
}

function applyChunks(text: string, path: string, chunks: VChunk[], strict: boolean): string {
  const f = splitFile(text);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let at = -1;
      const tiers: Tier[] = strict ? [0] : [0, 1, 2];
      for (const tier of tiers) {
        for (let k = cursor; k < f.lines.length; k += 1) {
          if (lineEq(f.lines[k]!, ch.anchor, tier)) {
            at = k;
            break;
          }
        }
        if (at >= 0) break;
      }
      if (at < 0) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const { o, n } = bodyON(ch.entries);
    if (o.length > 0) {
      const found = findMatch(f.lines, o, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.positions[0]!;
      const repl = buildN(f.lines, pos, o, n, found.tier);
      f.lines.splice(pos, o.length, ...repl);
      cursor = pos + repl.length;
    } else if (n.length > 0) {
      const at = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
      f.lines.splice(at, 0, ...n.map((e) => e.text));
      cursor = at + n.length;
    } else if (ch.eof) {
      cursor = f.lines.length;
    }
  }
  return joinFile(f);
}

function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const fb = lines.findIndex((l) => !blank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = lines.length - 1;
  while (lb >= 0 && blank(lines[lb]!)) lb -= 1;
  if (lb < 0 || lines[lb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const startKind = (l: string): 'add' | 'del' | 'upd' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : l.startsWith('*** Update File: ') ? 'upd' : null;
  const startPath = (l: string): string => l.slice(l.indexOf('File: ') + 'File: '.length).trim();
  let i = fb + 1;
  while (i < lb) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const kind = startKind(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = startPath(l);
    const sectionLine = i + 1;
    i += 1;
    if (kind === 'add') {
      const span: { line: string; no: number }[] = [];
      while (i < lb && startKind(lines[i]!) === null) {
        span.push({ line: lines[i]!, no: i + 1 });
        i += 1;
      }
      while (span.length > 0 && blank(span[span.length - 1]!.line)) span.pop();
      const content: string[] = [];
      for (const { line: b, no } of span) {
        if (b.startsWith('+')) content.push(b.slice(1));
        else if (b === '') content.push('');
        else throw new Exit2(`error: parse ${no}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile({ lines: content, br: '\n', finalBreak: true }));
      });
    } else if (kind === 'del') {
      while (i < lb && startKind(lines[i]!) === null) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      if (i < lb && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const raw: { line: string; no: number }[] = [];
      while (i < lb && startKind(lines[i]!) === null) {
        raw.push({ line: lines[i]!, no: i + 1 });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let closed = false;
      for (const { line: b, no } of raw) {
        if (b.startsWith('@@')) {
          cur = { anchor: b.slice(2).trim() === '' ? null : b.slice(2).trim(), eof: false, entries: [] };
          chunks.push(cur);
          closed = false;
          continue;
        }
        if (b === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${no}`);
          cur.eof = true;
          cur = null;
          closed = true;
          continue;
        }
        const c = b === '' ? ' ' : b[0]!;
        if (c !== ' ' && c !== '-' && c !== '+') throw new Exit2(`error: parse ${no}`);
        if (cur === null) {
          if (closed) throw new Exit2(`error: parse ${no}`);
          cur = { anchor: null, eof: false, entries: [] };
          chunks.push(cur);
        }
        if (b === '') cur.entries.push({ kind: 'ctx', text: '', noNl: false, rawEmpty: true });
        else if (c === ' ') cur.entries.push({ kind: 'ctx', text: b.slice(1), noNl: false, rawEmpty: false });
        else if (c === '-') cur.entries.push({ kind: 'old', text: b.slice(1), noNl: false, rawEmpty: false });
        else cur.entries.push({ kind: 'new', text: b.slice(1), noNl: false, rawEmpty: false });
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
      const to = moveTo;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (to !== null && !safe(to)) throw new Fail('unsafe', to);
        const t = tree.get(path);
        if (t === null) throw new Fail('missing', path);
        if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
        const out = applyChunks(t, path, chunks, strict);
        if (to !== null) {
          tree.now.set(to, out);
          tree.now.set(path, null);
          moves.push([path, to]);
        } else tree.now.set(path, out);
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // The listing is computed in full before anything is written, so every original is read from the untouched tree.
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rByNew = new Map<string, string>();
  for (const [from, to] of moves) {
    if (tree.original(from) !== null && finalOf(from) === null && tree.original(to) === null && finalOf(to) !== null) rByNew.set(to, from);
  }
  const rOlds = new Set(rByNew.values());
  const listed: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    if (rByNew.has(p)) {
      listed.push({ key: p, line: `R ${rByNew.get(p)!} -> ${p}` });
      continue;
    }
    if (rOlds.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    listed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  listed.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows = listed.map((r) => r.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
