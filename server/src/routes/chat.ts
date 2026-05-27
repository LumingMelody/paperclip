/**
 * POST /chat — entry point for the DingTalk bot's Concierge flow.
 *
 * Body (zod-validated):
 *   - companyId: uuid-ish string
 *   - projectId: uuid-ish string
 *   - senderKey: DingTalk sender_staff_id
 *   - conversationKey?: explicit override for "which conversation"
 *   - text: user message (≤ 4000 chars)
 *
 * On success (201):
 *   { issueId: string, created: boolean }
 *
 * On validation failure: 400 via the shared errorHandler (ZodError → 400).
 * On chatService failure: 500 with error string.
 */
import { Router } from "express";
import { z } from "zod";

import { validate } from "../middleware/validate.js";
import type { chatService } from "../services/chat.js";

const chatRequestSchema = z.object({
  companyId: z.string().min(1),
  projectId: z.string().min(1),
  senderKey: z.string().min(1),
  conversationKey: z.string().optional(),
  targetAgentId: z.string().uuid().optional(),
  text: z.string().min(1).max(4000),
});

export interface ChatRoutesDeps {
  chatService: ReturnType<typeof chatService>;
}

export function chatRoutes(deps: ChatRoutesDeps) {
  const router = Router();

  router.post("/chat", validate(chatRequestSchema), async (req, res) => {
    try {
      const result = await deps.chatService.handleIncoming(req.body);
      res.status(201).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "chat service failure";
      res.status(500).json({ error: message });
    }
  });

  return router;
}
