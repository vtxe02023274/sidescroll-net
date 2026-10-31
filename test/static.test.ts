import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveStatic } from '../src/server/static.js';

const dir = resolve('/srv/app/public');

describe('resolveStatic', () => {
  it('serves index.html for the root', () => {
    expect(resolveStatic(dir, '/')).toEqual({
      status: 200,
      path: '/index.html',
      file: join(dir, 'index.html'),
    });
  });

  it('answers 400 for targets that are not a valid URL instead of throwing', () => {
    expect(resolveStatic(dir, '//[')).toEqual({ status: 400 });
    expect(resolveStatic(dir, '//a:b@')).toEqual({ status: 400 });
    expect(resolveStatic(dir, '/%')).toEqual({ status: 400 });
    expect(resolveStatic(dir, '/a%00b')).toEqual({ status: 400 });
  });

  it('rejects paths that decode to somewhere outside the directory', () => {
    expect(resolveStatic(dir, '/..%2fsecret')).toEqual({ status: 403 });
    expect(resolveStatic(dir, '/..%2f..%2fetc%2fpasswd')).toEqual({ status: 403 });
  });

  it('does not treat a sibling directory with the same prefix as inside', () => {
    expect(resolveStatic(dir, '/..%2fpublic-private%2fkey')).toEqual({ status: 403 });
  });

  it('decodes percent-encoded names', () => {
    const r = resolveStatic(dir, '/a%20b.js');
    expect(r).toEqual({ status: 200, path: '/a b.js', file: join(dir, 'a b.js') });
  });
});
