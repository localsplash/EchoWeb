import { sql } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';

const eventTypeMap: Record<string, number> = {
  'message-received': 1,
  'message-sending': 2,
  'message-delivered': 4,
  'message-failed': 8
};

export function resolveEventTypeId(eventType: string): number | null {
  return eventTypeMap[eventType] ?? null;
}

export type MessageInsertInput = {
  sMessageId: string;
  bInbound: boolean;
  iBusinessNumber: number;
  iCustomerNumber: number;
  text: string | null;
  dtCreated: string;
  eMessageEventTypeID: number;
};

export class MessageRepository {
  constructor(private readonly db: MySql2Database<Record<string, never>>) {}

  async insertMessage(input: MessageInsertInput): Promise<number | null> {
    const [rows] = await this.db.execute(sql`
      CALL sms_usp_Message_INS(
        ${input.sMessageId},
        ${input.bInbound ? 1 : 0},
        ${input.iBusinessNumber},
        ${input.iCustomerNumber},
        ${input.text},
        ${input.dtCreated},
        ${input.eMessageEventTypeID}
      )
    `);

    const nested = rows as any;
    const resultRow = nested?.[0]?.[0];
    return resultRow?.iMessageId ?? null;
  }

  async setMessageEventByExternalMessageId(params: {
    sMessageId: string;
    eMessageEventTypeID: number;
    dtEvent: string;
    iErrorCode?: number | null;
    description?: string | null;
  }): Promise<boolean> {
    const [rows] = await this.db.execute(sql`
      CALL sms_usp_MessageEvent_SET(
        ${params.sMessageId},
        ${params.eMessageEventTypeID},
        ${params.dtEvent},
        ${params.iErrorCode ?? null},
        ${params.description ?? null}
      )
    `);

    const nested = rows as any;
    const resultRow = nested?.[0]?.[0];
    return Boolean(resultRow?.updated);
  }

  async setMessageRead(iMessageId: number, bIsRead: boolean): Promise<void> {
    await this.db.execute(sql`CALL sms_usp_MessageRead_SET(${iMessageId}, ${bIsRead ? 1 : 0})`);
  }

  async getMessagesByBusiness(iBusinessNumber: number): Promise<unknown[]> {
    const [rows] = await this.db.execute(sql`CALL sms_usp_Message_GET(${iBusinessNumber})`);
    const nested = rows as any;
    return nested?.[0] ?? [];
  }

  async listConversations(iBusinessNumber: number): Promise<unknown[]> {
    const [rows] = await this.db.execute(sql`
      SELECT
        m.iCustomerNumber,
        MAX(m.dtCreated) AS lastAt,
        SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(m.text, '') ORDER BY m.dtCreated DESC SEPARATOR '\n'), '\n', 1) AS lastText,
        CAST(SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(m.eMessageEventTypeID, 0) ORDER BY m.dtCreated DESC SEPARATOR ','), ',', 1) AS UNSIGNED) AS lastEventType,
        SUM(CASE WHEN m.bInbound = 1 AND m.bIsRead = 0 THEN 1 ELSE 0 END) AS unreadCount
      FROM sms_tbl_Message m
      WHERE m.iBusinessNumber = ${iBusinessNumber}
      GROUP BY m.iCustomerNumber
      ORDER BY lastAt DESC
    `);

    return (rows as unknown as any[]) ?? [];
  }

  async getConversationMessages(iBusinessNumber: number, iCustomerNumber: number): Promise<unknown[]> {
    const [rows] = await this.db.execute(sql`
      SELECT
        iMessageId,
        sMessageId,
        bInbound,
        iBusinessNumber,
        iCustomerNumber,
        text,
        dtCreated,
        eMessageEventTypeID,
        bIsRead
      FROM sms_tbl_Message
      WHERE iBusinessNumber = ${iBusinessNumber}
        AND iCustomerNumber = ${iCustomerNumber}
      ORDER BY dtCreated ASC, iMessageId ASC
    `);

    return (rows as unknown as any[]) ?? [];
  }

  async markConversationRead(iBusinessNumber: number, iCustomerNumber: number): Promise<void> {
    await this.db.execute(sql`
      UPDATE sms_tbl_Message
      SET bIsRead = 1
      WHERE iBusinessNumber = ${iBusinessNumber}
        AND iCustomerNumber = ${iCustomerNumber}
        AND bInbound = 1
        AND bIsRead = 0
    `);
  }

  async markLatestConversationUnread(iBusinessNumber: number, iCustomerNumber: number): Promise<void> {
    await this.db.execute(sql`CALL sms_usp_MessageReadLatest_SET(${iBusinessNumber}, ${iCustomerNumber}, 0)`);
  }

  async deleteMessage(iMessageId: number): Promise<void> {
    await this.db.execute(sql`CALL sms_usp_Message_DEL(${iMessageId})`);
  }

  async deleteCustomer(iBusinessNumber: number, iCustomerNumber: number): Promise<void> {
    await this.db.execute(sql`CALL sms_usp_Customer_DEL(${iBusinessNumber}, ${iCustomerNumber})`);
  }
}
