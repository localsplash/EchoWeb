import type express from 'express';
import type mysql from 'mysql2/promise';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppConfig } from './config';
import type { PlatformSession } from './platformSession';

/** Only stored, canonical file paths are eligible; the request cannot choose an origin. */
function mediaPath(raw: string): string | null {
  try {
    const value = decodeURIComponent(raw);
    if (
      !value.startsWith('/') ||
      value.length > 512 ||
      /[\\%?#\x00-\x1f\x7f]/.test(value)
    )
      return null;
    if (
      value
        .slice(1)
        .split('/')
        .some((part) => !part || part === '.' || part === '..')
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function registerMediaRoute(
  app: express.Express,
  db: mysql.Pool,
  config: () => AppConfig,
  resolveSession: (
    req: express.Request,
  ) => Promise<PlatformSession | null>,
): void {
  app.get(/^\/api\/media\/(.+)$/, async (req, res) => {
    // The current central membership and selected business are resolved on every
    // file request, including thumbnails and byte-range requests.
    const session = await resolveSession(req);
    if (!session)
      return void res.status(401).json({ error: 'Not logged in' });
    if (!session.iBusinessNumber)
      return void res
        .status(403)
        .json({ error: 'Choose an authorized business' });
    const storedPath = mediaPath(
      req.originalUrl.slice('/api/media'.length),
    );
    if (!storedPath)
      return void res.status(400).json({ error: 'Invalid media path' });
    const internal = config().MEDIA_INTERNAL_BASE_URL;
    if (!internal)
      return void res
        .status(503)
        .json({ error: 'Media service is not configured' });
    const [rows] = await db.query<mysql.RowDataPacket[]>(
      `SELECT media.uidMediaId AS id FROM sms_tbl_Media media
       JOIN sms_tbl_Message message ON message.iMessageId=media.iMessageId
       WHERE message.iBusinessNumber=? AND
         (BINARY media.storagePath=? OR BINARY media.thumbnailPath=?)
       UNION ALL
       SELECT uidDraftMediaId AS id FROM sms_tbl_DraftMedia
       WHERE iBusinessNumber=? AND (BINARY storagePath=? OR BINARY thumbnailPath=?)
       LIMIT 1`,
      [
        session.iBusinessNumber,
        storedPath,
        storedPath,
        session.iBusinessNumber,
        storedPath,
        storedPath,
      ],
    );
    if (!rows.length)
      return void res.status(404).json({ error: 'Media not found' });
    const range = req.get('Range');
    if (range && !/^bytes=(?:\d{1,15}-\d{0,15}|-\d{1,15})$/.test(range))
      return void res.status(400).json({ error: 'Invalid byte range' });
    const abort = new AbortController();
    const stop = () => abort.abort();
    res.once('close', stop);
    try {
      const url = new URL(
        storedPath.split('/').map(encodeURIComponent).join('/'),
        internal,
      );
      const upstream = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.any([
          abort.signal,
          AbortSignal.timeout(120_000),
        ]),
        headers: range ? { Range: range } : {},
      });
      if (![200, 206].includes(upstream.status) || !upstream.body) {
        await upstream.body?.cancel();
        return void res
          .status(
            upstream.status === 404
              ? 404
              : upstream.status === 416
                ? 416
                : 502,
          )
          .json({ error: 'Media could not be retrieved' });
      }
      const mime = (upstream.headers.get('Content-Type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      const inline =
        /^(?:image\/(?:png|jpeg|gif|webp|avif)|audio\/(?:mpeg|ogg|wav|mp4|webm)|video\/(?:mp4|webm|ogg))$/.test(
          mime,
        );
      res.status(upstream.status).set({
        'Content-Type': inline ? mime : 'application/octet-stream',
        'Content-Disposition': inline ? 'inline' : 'attachment',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      for (const header of [
        'Content-Length',
        'Content-Range',
        'Accept-Ranges',
      ]) {
        const value = upstream.headers.get(header);
        if (value) res.set(header, value);
      }
      await pipeline(
        Readable.fromWeb(
          upstream.body as Parameters<typeof Readable.fromWeb>[0],
        ),
        res,
      );
    } catch {
      if (!res.headersSent && !res.destroyed)
        res.status(502).json({ error: 'Media could not be retrieved' });
      else if (!res.destroyed) res.destroy();
    } finally {
      res.off('close', stop);
    }
  });
}
