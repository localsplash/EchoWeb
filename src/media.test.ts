import express from 'express';
import request from 'supertest';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type mysql from 'mysql2/promise';
import { registerMediaRoute } from './media';
import type { AppConfig } from './config';
import type { PlatformSession } from './platformSession';

let session: PlatformSession | null;
let query: ReturnType<typeof vi.fn>;
let fetchMedia: ReturnType<typeof vi.fn>;
const own = '/7145550001/7145550009/photo.png';
const other = '/7145550002/7145550009/photo.png';
function app() {
  const server = express();
  registerMediaRoute(
    server,
    { query } as unknown as mysql.Pool,
    () =>
      ({ MEDIA_INTERNAL_BASE_URL: 'http://echo-media:8082' }) as AppConfig,
    async () => session,
  );
  return server;
}
beforeEach(() => {
  session = { iBusinessNumber: 7145550001 } as PlatformSession;
  query = vi.fn(async (_sql: string, args: unknown[]) => [
    args[0] === 7145550001 &&
    [own, '/7145550001/7145550009/thumb.png'].includes(String(args[1]))
      ? [{ id: 'stored' }]
      : [],
  ]);
  fetchMedia = vi.fn(
    async () =>
      new Response('image bytes', {
        headers: { 'Content-Type': 'image/png', 'Content-Length': '11' },
      }),
  );
  vi.stubGlobal('fetch', fetchMedia);
});
afterEach(() => vi.unstubAllGlobals());
describe('business-authorized private media', () => {
  it('requires a current session and an authorized selected business', async () => {
    session = null;
    expect((await request(app()).get('/api/media' + own)).status).toBe(
      401,
    );
    session = {
      iBusinessNumber: null,
      bIsSuperAdmin: true,
    } as PlatformSession;
    expect((await request(app()).get('/api/media' + own)).status).toBe(
      403,
    );
    expect(query).not.toHaveBeenCalled();
    expect(fetchMedia).not.toHaveBeenCalled();
  });
  it('denies media belonging to a different business before any upstream request', async () => {
    expect((await request(app()).get('/api/media' + other)).status).toBe(
      404,
    );
    expect(query.mock.calls[0][1]).toEqual([
      7145550001,
      other,
      other,
      7145550001,
      other,
      other,
    ]);
    expect(fetchMedia).not.toHaveBeenCalled();
  });
  it.each([own, '/7145550001/7145550009/thumb.png'])(
    'streams an owned stored path or thumbnail: %s',
    async (storedPath) => {
      const result = await request(app()).get('/api/media' + storedPath);
      expect(result.status).toBe(200);
      expect(result.body.toString()).toBe('image bytes');
      expect(result.headers['cache-control']).toBe('private, no-store');
      expect(result.headers['x-content-type-options']).toBe('nosniff');
      expect(String(fetchMedia.mock.calls[0][0])).toBe(
        'http://echo-media:8082' + storedPath,
      );
      expect(fetchMedia.mock.calls[0][1]).toMatchObject({
        redirect: 'error',
      });
    },
  );
  it.each([
    '/../secret',
    '/%252e%252e/secret',
    '/%5csecret',
    '//evil.tld/file',
    '/file?url=https://evil.tld',
    '/a/%00',
  ])('rejects ambiguous and unsafe paths: %s', async (bad) => {
    const response = await request(app()).get('/api/media' + bad);
    expect([400, 404]).toContain(response.status);
    expect(fetchMedia).not.toHaveBeenCalled();
  });
  it('supports a single byte range and rejects malformed or multipart ranges', async () => {
    fetchMedia.mockImplementation(
      async () =>
        new Response('abc', {
          status: 206,
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Range': 'bytes 0-2/99',
          },
        }),
    );
    const result = await request(app())
      .get('/api/media' + own)
      .set('Range', 'bytes=0-2');
    expect(result.status).toBe(206);
    expect(result.headers['content-range']).toBe('bytes 0-2/99');
    expect(fetchMedia.mock.calls[0][1]).toMatchObject({
      headers: { Range: 'bytes=0-2' },
    });
    fetchMedia.mockClear();
    expect(
      (
        await request(app())
          .get('/api/media' + own)
          .set('Range', 'bytes=0-2,9-10')
      ).status,
    ).toBe(400);
    expect(fetchMedia).not.toHaveBeenCalled();
  });
  it('downloads active content without same-origin execution', async () => {
    fetchMedia.mockImplementation(
      async () =>
        new Response('<script>bad()</script>', {
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    const result = await request(app()).get('/api/media' + own);
    expect(result.headers['content-type']).toBe(
      'application/octet-stream',
    );
    expect(result.headers['content-disposition']).toBe('attachment');
    expect(result.headers['content-security-policy']).toContain('sandbox');
  });
  it('does not follow upstream redirects or expose upstream errors', async () => {
    fetchMedia.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: 'http://secret.invalid' },
        }),
    );
    const result = await request(app()).get('/api/media' + own);
    expect(result.status).toBe(502);
    expect(result.headers.location).toBeUndefined();
    expect(result.text).not.toContain('secret.invalid');
  });
});
