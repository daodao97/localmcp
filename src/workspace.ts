import { constants } from 'node:fs';
import { lstat, open, readdir, mkdir, rm, rename, stat as fsStat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, relative, isAbsolute, sep, dirname, basename } from 'node:path';

const MAX_TEXT_BYTES = 1024 * 1024;
const DEFAULT_IGNORES = new Set(['.git', 'node_modules']);

export interface LineEdit { startLine: number; endLine: number; replacement: string }

function globToRegExp(glob: string) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

export class Workspace {
  constructor(readonly root:string) {}

  async path(input: string, createParents = false): Promise<string> {
    const target = resolve(this.root, input);
    const rel = relative(this.root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Path is outside workspace');
    const parts = rel.split(sep).filter(Boolean);
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = resolve(current, parts[i]);
      try {
        const s = await lstat(current);
        if (s.isSymbolicLink()) throw new Error('Symbolic links are not allowed');
        if (i < parts.length - 1 && !s.isDirectory()) throw new Error('Parent is not a directory');
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        if (i < parts.length - 1) {
          if (!createParents) throw error;
          await mkdir(current);
        }
      }
    }
    return target;
  }

  async read(path: string) {
    const file = await open(await this.path(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_TEXT_BYTES) throw new Error('Only regular text files up to 1 MiB are supported');
      return await file.readFile('utf8');
    } finally { await file.close(); }
  }

  async readLines(path: string, startLine = 1, endLine?: number) {
    if (startLine < 1 || (endLine !== undefined && endLine < startLine)) throw new Error('Invalid line range');
    const content = await this.read(path);
    const lines = content.split('\n');
    const last = Math.min(endLine ?? lines.length, lines.length);
    return {
      path,
      startLine,
      endLine: last,
      totalLines: lines.length,
      content: lines.slice(startLine - 1, last).join('\n'),
      hasMore: last < lines.length,
    };
  }

  async write(path: string, content: string, overwrite: boolean) {
    if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new Error('Content exceeds 1 MiB');
    const target = await this.path(path, true);
    if (!overwrite) {
      const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(content, 'utf8'); }
      finally { await file.close(); }
      return {path: relative(this.root, target), bytes: Buffer.byteLength(content)};
    }

    try {
      const current = await lstat(target);
      if (current.isSymbolicLink() || !current.isFile() || current.nlink > 1) throw new Error('Only regular files with one hard link can be overwritten');
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }

    const temp = resolve(dirname(target), `.${basename(target)}.localmcp-${randomBytes(8).toString('hex')}`);
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally { await file.close(); }
    try { await rename(temp, target); }
    catch (error) { await rm(temp, {force: true}); throw error; }
    return {path: relative(this.root, target), bytes: Buffer.byteLength(content)};
  }

  async list(path: string, offset: number, limit: number) {
    const entries = (await readdir(await this.path(path), {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name));
    return {entries: entries.slice(offset, offset + limit).map(e => ({name: e.name, type: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file'})), total: entries.length, nextOffset: offset + limit < entries.length ? offset + limit : null};
  }

  async stat(path: string) {
    const target = await this.path(path);
    const info = await lstat(target);
    return {
      path: relative(this.root, target) || '.',
      type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
      size: info.size,
      mtime: info.mtime.toISOString(),
      mode: (info.mode & 0o777).toString(8).padStart(3, '0'),
    };
  }

  private async walk(path: string, maxDepth: number, maxEntries: number) {
    const root = await this.path(path);
    const results: Array<{path: string; type: 'file'|'directory'}> = [];
    const visit = async (dir: string, depth: number) => {
      if (results.length >= maxEntries || depth > maxDepth) return;
      const entries = (await readdir(dir, {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (results.length >= maxEntries) break;
        if (DEFAULT_IGNORES.has(entry.name) || entry.isSymbolicLink()) continue;
        const full = resolve(dir, entry.name);
        const rel = relative(this.root, full).split(sep).join('/');
        if (entry.isDirectory()) {
          results.push({path: rel + '/', type: 'directory'});
          if (depth < maxDepth) await visit(full, depth + 1);
        } else if (entry.isFile()) results.push({path: rel, type: 'file'});
      }
    };
    await visit(root, 1);
    return results;
  }

  async tree(path = '.', maxDepth = 3, maxEntries = 1000) {
    const entries = await this.walk(path, maxDepth, maxEntries);
    return {entries, truncated: entries.length >= maxEntries};
  }

  async findFiles(path: string, pattern: string, maxResults: number) {
    const entries = await this.walk(path, 50, Math.max(maxResults * 20, 1000));
    const matcher = globToRegExp(pattern.replaceAll('\\', '/'));
    const matches = entries.filter(e => e.type === 'file' && (matcher.test(e.path) || matcher.test(basename(e.path)))).slice(0, maxResults).map(e => e.path);
    return {matches, truncated: matches.length >= maxResults};
  }

  async search(path: string, query: string, regex: boolean, caseSensitive: boolean, maxResults: number, contextLines: number) {
    const entries = await this.walk(path, 50, 10000);
    const flags = caseSensitive ? 'g' : 'gi';
    let re: RegExp;
    try { re = regex ? new RegExp(query, flags) : new RegExp(query.split('').map(c => '\\^$.*+?()[]{}|'.includes(c) ? '\\' + c : c).join(''), flags); }
    catch { throw new Error('Invalid regular expression'); }
    const matches: Array<{path: string; line: number; column: number; text: string; before: string[]; after: string[]}> = [];
    for (const entry of entries) {
      if (matches.length >= maxResults) break;
      if (entry.type !== 'file') continue;
      const target = await this.path(entry.path);
      const info = await fsStat(target);
      if (info.size > MAX_TEXT_BYTES) continue;
      let content: string;
      try { content = await this.read(entry.path); } catch { continue; }
      if (content.includes('\0')) continue;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (!m) continue;
        matches.push({
          path: entry.path,
          line: i + 1,
          column: m.index + 1,
          text: lines[i],
          before: lines.slice(Math.max(0, i - contextLines), i),
          after: lines.slice(i + 1, i + 1 + contextLines),
        });
      }
    }
    return {matches, truncated: matches.length >= maxResults};
  }

  async applyEdits(path: string, edits: LineEdit[], expectedSha256?: string) {
    const old = await this.read(path);
    const beforeHash = createHash('sha256').update(old).digest('hex');
    if (expectedSha256 && expectedSha256 !== beforeHash) throw new Error('File changed since it was read (sha256 mismatch)');
    const lines = old.split('\n');
    const sorted = [...edits].sort((a,b) => b.startLine - a.startLine);
    let previousStart = Number.POSITIVE_INFINITY;
    for (const edit of sorted) {
      if (edit.startLine < 1 || edit.endLine < edit.startLine || edit.endLine > lines.length) throw new Error('Invalid edit line range');
      if (edit.endLine >= previousStart) throw new Error('Edits overlap');
      lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...edit.replacement.split('\n'));
      previousStart = edit.startLine;
    }
    const content = lines.join('\n');
    await this.write(path, content, true);
    return {path, beforeSha256: beforeHash, afterSha256: createHash('sha256').update(content).digest('hex'), edits: edits.length, bytes: Buffer.byteLength(content)};
  }

  async createDirectory(path: string) {
    const target = await this.path(path, true);
    await mkdir(target, {recursive: false});
    return {path: relative(this.root, target)};
  }

  async delete(path: string, recursive: boolean) {
    const target = await this.path(path);
    if (target === this.root) throw new Error('Cannot delete workspace root');
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error('Symbolic links are not allowed');
    if (info.isDirectory() && !recursive) await rm(target, {recursive: false});
    else await rm(target, {recursive, force: false});
    return {path: relative(this.root, target)};
  }

  async move(from: string, to: string, overwrite: boolean) {
    const source = await this.path(from);
    const sourceInfo = await lstat(source);
    if (sourceInfo.isSymbolicLink()) throw new Error('Symbolic links are not allowed');
    const target = await this.path(to, true);
    if (!overwrite) {
      try { await lstat(target); throw new Error('Destination already exists'); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    await rename(source, target);
    return {from: relative(this.root, source), to: relative(this.root, target)};
  }
}
