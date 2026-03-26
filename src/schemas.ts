import { z } from 'zod';

export const inboundEventSchema = z.object({
  message: z.object({
    id: z.string().min(1)
  })
}).passthrough();

export const inboundPayloadSchema = z.array(inboundEventSchema);

export const sendMessageSchema = z.object({
  from: z.string().regex(/^\+[1-9]\d{7,14}$/),
  to: z.string().regex(/^\+[1-9]\d{7,14}$/),
  text: z.string().min(1).max(2048)
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
