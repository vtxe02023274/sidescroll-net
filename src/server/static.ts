import { resolve, sep } from 'node:path';

export type StaticTarget = { status: 400 | 403 } | { status: 200; path: string; file: string };

/**
 * Maps a request target to a file inside publicDir. Anything that cannot be
 * parsed is a 400, anything that decodes to a path outside publicDir is a 403.
 */
export function resolveStatic(publicDir: string, target: string | undefined): StaticTarget {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(target ?? '/', 'http://localhost').pathname);
  } catch {
    return { status: 400 };
  }
  if (pathname.includes('\0')) return { status: 400 };
  const path = pathname === '/' ? '/index.html' : pathname;
  const root = resolve(publicDir);
  const file = resolve(root, `.${path}`);
  if (file !== root && !file.startsWith(root + sep)) return { status: 403 };
  return { status: 200, path, file };
}
