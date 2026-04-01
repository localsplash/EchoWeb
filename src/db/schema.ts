import { bigint, boolean, datetime, int, mysqlTable, text, uniqueIndex, varchar, index } from 'drizzle-orm/mysql-core';

export const smsLkpMessageEvent = mysqlTable('sms_lkp_MessageEvent', {
  eMessageEventTypeID: int('eMessageEventTypeID').primaryKey(),
  messageEvent: varchar('messageEvent', { length: 32 }).notNull(),
  description: varchar('description', { length: 255 })
});

export const smsTblMessage = mysqlTable('sms_tbl_Message', {
  iMessageId: bigint('iMessageId', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  sMessageId: varchar('sMessageId', { length: 64 }).notNull(),
  bInbound: boolean('bInbound').notNull().default(false),
  iBusinessNumber: bigint('iBusinessNumber', { mode: 'number' }).notNull(),
  iCustomerNumber: bigint('iCustomerNumber', { mode: 'number' }).notNull(),
  text: text('text'),
  dtCreated: datetime('dtCreated', { fsp: 3, mode: 'string' }).notNull(),
  eMessageEventTypeID: int('eMessageEventTypeID').notNull(),
  bIsRead: boolean('bIsRead').notNull().default(false)
}, (t) => ({
  idxMessageId: uniqueIndex('idx_messageId').on(t.sMessageId),
  idxCustomer: index('idx_customer').on(t.iCustomerNumber)
}));

export const smsTblMessageEvent = mysqlTable('sms_tbl_MessageEvent', {
  iEventId: bigint('iEventId', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  iMessageId: bigint('iMessageId', { mode: 'number', unsigned: true }).notNull(),
  eMessageEventTypeID: int('eMessageEventTypeID').notNull(),
  dtEvent: datetime('dtEvent', { fsp: 3, mode: 'string' }).notNull(),
  iErrorCode: int('iErrorCode'),
  description: text('description')
}, (t) => ({
  idxMsgEvent: uniqueIndex('idx_msg_event').on(t.iMessageId, t.eMessageEventTypeID)
}));
