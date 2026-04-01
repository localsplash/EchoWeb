import { z } from 'zod';

export const inboundEventSchema = z.object({
  message: z.object({
    id: z.string().min(1)
  })
}).passthrough();

export const inboundPayloadSchema = z.array(inboundEventSchema);

export const sendMessageSchema = z.object({
  text: z.string().min(1).max(2048)
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
