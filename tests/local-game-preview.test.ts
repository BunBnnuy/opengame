import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startLocalGamePreview } from '../gateway/local-game-preview.ts';
import { isLocalGamePreviewUrl } from '../shared/local-game-preview.ts';

test('local game previews expose only the game mapped to the isolated origin', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'isolated-game-preview-'));
  const preview = await startLocalGamePreview(workspace);
  t.after(async () => { preview.close(); await rm(workspace, { recursive: true, force: true }); });
  const url = new URL(preview.url('tidebreaker'));
  assert.equal(isLocalGamePreviewUrl(url.href), true);
  assert.notEqual(new URL(preview.url('stack-the-moon')).origin, url.origin);
  const read = (target: string, method = 'GET', host = url.host) => new Promise<{ status?: number; csp?: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: url.port, path: target, method, headers: { Host: host } }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, csp: res.headers['content-security-policy'] }));
    });
    req.on('error', reject).end();
  });
  const entry = await read(url.pathname);
  assert.equal(entry.status, 200);
  assert.match(entry.csp ?? '', /sandbox [^;]*\ballow-same-origin\b/);
  assert.equal((await read(url.pathname.replace(/index\.html$/, 'assets/archipelago.webp'))).status, 200);
  for (const prohibited of ['/mcp', '/api/assets', '/api/games/tidebreaker', '/api/games/stack-the-moon/play/index.html']) {
    assert.equal((await read(prohibited)).status, 404, prohibited);
  }
  assert.equal((await read(url.pathname, 'POST')).status, 404);
  assert.equal((await read(url.pathname, 'GET', `localhost:${url.port}`)).status, 404);
});
