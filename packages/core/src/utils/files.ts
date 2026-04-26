import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(p: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(p, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeJson(p: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(p));
  await fsp.writeFile(p, JSON.stringify(value, null, 2), 'utf8');
}

/** Recursively walk `root`, yielding file paths that match any include glob
 *  and match no exclude glob. Globs are minimatch-style (very small subset). */
export async function* walkFiles(
  root: string,
  include: (rel: string) => boolean,
  exclude: (rel: string) => boolean,
): AsyncGenerator<string> {
  async function* rec(dir: string): AsyncGenerator<string> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs);
      if (exclude(rel)) continue;
      if (ent.isDirectory()) {
        yield* rec(abs);
      } else if (ent.isFile() && include(rel)) {
        yield abs;
      }
    }
  }
  yield* rec(root);
}

export function matchSuffix(globs: string[]): (rel: string) => boolean {
  // Supports `**/X`, `**/*.ext`, `X` — simple but sufficient for our use case.
  const patterns = globs.map((g) => {
    const normalised = g.replace(/\\/g, '/');
    if (normalised.startsWith('**/')) return normalised.slice(3);
    return normalised;
  });
  return (rel: string) => {
    const n = rel.replace(/\\/g, '/');
    return patterns.some((p) => {
      if (p.startsWith('*.')) return n.endsWith(p.slice(1));
      if (p.includes('*')) {
        const regex = new RegExp(
          '^' + p.split('*').map(escapeRegex).join('.*') + '$',
        );
        return regex.test(n) || regex.test(path.basename(n));
      }
      return n === p || n.endsWith('/' + p) || path.basename(n) === p;
    });
  };
}

export function matchAnyPrefix(globs: string[]): (rel: string) => boolean {
  const patterns = globs.map((g) => g.replace(/\\/g, '/'));
  return (rel: string) => {
    const n = rel.replace(/\\/g, '/');
    return patterns.some((p) => {
      if (p.includes('**')) {
        const parts = p.split('**');
        return parts.every((x) => n.includes(x.replace(/^\/|\/$/g, '')));
      }
      return n.includes(p);
    });
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
