import crypto from 'crypto';
import mysql from 'mysql2/promise';

/**
 * Receiver for the id integration standard (see id's README).
 *
 * Echo's session is its own row behind its own cookie, independent of the
 * id session that created it. That is deliberate — it keeps every request
 * local — but it means a revocation at id is invisible here unless id tells
 * us. This module is that ear.
 *
 * Registration happens on boot and returns the signing secret, so no extra
 * configuration is involved: if EchoWeb is running, it is integrated.
 */

export interface IdEvent {
  id: number;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

/**
 * Verify a delivery. Mirrors id's `verifySignature` exactly: HMAC over
 * `${timestamp}.${rawBody}` against the RAW body, constant-time, with a
 * 300s window — the timestamp is inside the MAC, so this window is what
 * makes a captured delivery useless later.
 */
export function verifyIdSignature(
  secret: string,
  rawBody: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!secret || !signatureHeader) return false;
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > 300) return false;

  const provided = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(expected, 'hex');
    b = Buffer.from(provided, 'hex');
  } catch {
    return false;
  }
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * End every Echo session belonging to an id user.
 *
 * Deleting by the id user id rather than by Echo's own session id is what
 * makes this work for `scope: 'all'`, and it is idempotent — a redelivered
 * event simply deletes nothing the second time.
 */
export async function revokeSessionsForIdUser(
  pool: mysql.Pool,
  iIdUserId: number
): Promise<number> {
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `DELETE s FROM auth_tbl_Session s
       JOIN auth_tbl_User u ON u.iUserId = s.iUserId
      WHERE u.iIdUserId = ?`,
    [iIdUserId]
  );
  return result.affectedRows;
}

/**
 * Repoint the local user at the surviving id user.
 *
 * If Echo happens to hold *both* id users as separate local users, the
 * retired one's sessions are dropped and its mapping cleared rather than
 * colliding with the unique index on iIdUserId — Echo keeps its own user
 * row and its org membership, which is the part that matters here.
 */
export async function remapIdUser(
  pool: mysql.Pool,
  fromUserId: number,
  toUserId: number
): Promise<{ remapped: number; revoked: number }> {
  const revoked = await revokeSessionsForIdUser(pool, fromUserId);

  const [existingTarget] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT iUserId FROM auth_tbl_User WHERE iIdUserId = ?`,
    [toUserId]
  );

  if (existingTarget.length) {
    // The surviving id user is already known here; just detach the retired
    // mapping so nothing points at a user id that no longer exists.
    const [cleared] = await pool.query<mysql.ResultSetHeader>(
      `UPDATE auth_tbl_User SET iIdUserId = NULL WHERE iIdUserId = ?`,
      [fromUserId]
    );
    return { remapped: cleared.affectedRows, revoked };
  }

  const [moved] = await pool.query<mysql.ResultSetHeader>(
    `UPDATE auth_tbl_User SET iIdUserId = ? WHERE iIdUserId = ?`,
    [toUserId, fromUserId]
  );
  return { remapped: moved.affectedRows, revoked };
}

/**
 * Apply one event. Idempotent by construction — every handler is a delete
 * or an update keyed on current state, so a redelivery is a no-op.
 */
export async function applyIdEvent(
  pool: mysql.Pool,
  event: IdEvent,
  log: (msg: string) => void
): Promise<void> {
  switch (event.type) {
    case 'ping':
      return;

    case 'session.revoked': {
      const iIdUserId = Number(event.data.iUserId);
      if (!Number.isInteger(iIdUserId)) return;
      const n = await revokeSessionsForIdUser(pool, iIdUserId);
      log(`[id-events] revoked ${n} Echo session(s) for id user ${iIdUserId}`);
      return;
    }

    case 'user.merged': {
      const from = Number(event.data.fromUserId);
      const to = Number(event.data.toUserId);
      if (!Number.isInteger(from) || !Number.isInteger(to)) return;
      const { remapped, revoked } = await remapIdUser(pool, from, to);
      log(`[id-events] remapped ${remapped} user(s) ${from}→${to}, revoked ${revoked} session(s)`);
      return;
    }

    case 'identity.linked':
    case 'identity.unlinked':
      // Echo binds orgs at login time from the CRM, not from the identity
      // list, so nothing to do — acknowledged so id stops retrying.
      return;

    default:
      // Unknown type from a newer id: acknowledge rather than fail forever.
      log(`[id-events] ignoring unknown event type ${event.type}`);
  }
}

// ─── Registration & catch-up ──────────────────────────────────────────────────

/**
 * The signing secret id handed us at registration. Module-scoped for the
 * same reason the connection pool is: it is process-wide infrastructure,
 * established once at boot.
 */
let webhookSecret: string | null = null;

export function getWebhookSecret(): string | null {
  return webhookSecret;
}

export function setWebhookSecret(secret: string): void {
  webhookSecret = secret;
}

/** Last event id we have durably applied; 0 when we have never seen one. */
export async function readCursor(pool: mysql.Pool): Promise<number> {
  try {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT iLastEventId FROM auth_tbl_IdCursor WHERE iCursorId = 1`
    );
    return rows.length ? Number(rows[0].iLastEventId ?? 0) : 0;
  } catch {
    // Table not migrated yet — start from the beginning rather than crash.
    return 0;
  }
}

export async function writeCursor(pool: mysql.Pool, iLastEventId: number): Promise<void> {
  await pool
    .query(
      `INSERT INTO auth_tbl_IdCursor (iCursorId, iLastEventId) VALUES (1, ?)
       ON DUPLICATE KEY UPDATE iLastEventId = GREATEST(iLastEventId, VALUES(iLastEventId))`,
      [iLastEventId]
    )
    .catch(() => undefined);
}
