# C1 Phase 6.0 Spike — Multi-Agent DingTalk Channels — Verification Spec

**Status:** ✅ All 4 unknowns validated; **Phase 6.0 main architecture is GO**.
**Date:** 2026-05-27
**Plan:** [2026-05-27-c1-phase6-spike-multi-agent-channels.md](../plans/2026-05-27-c1-phase6-spike-multi-agent-channels.md)
**Design discussion:** Codex review in conversation 2026-05-27 (see decisions.log)

## Outcome

Every technical unknown identified in Codex's Phase 6 design review is resolved:

| Unknown | Result | Implication |
|---|---|---|
| Can app credentials actively push markdown to a DingTalk group (not just reply)? | ✅ HTTP 200 from `POST /v1.0/robot/groupMessages/send` | Phase 6.0 主架构可行 — bot 不需要靠用户 @ 触发就能广播 |
| Can `/api/chat` be extended for per-channel agent routing without breaking Concierge default? | ✅ `targetAgentId` optional field works; default still Concierge | Phase 5 behavior preserved; Phase 6.0 bot 直接传 UUID 即可 |
| Does composite `dingtalk:<robot>:<conv>:<staff>` conversationKey isolate cross-app threads? | ✅ Different keys → different issues; same key reuses within 24h | 6 个 DingTalk app 之间不会撞 issue |
| Does the full chain (bot @ → /api/chat → Finance answer → Open API push) work without Concierge? | ✅ 150s e2e | "用户直接 @ Finance bot 拿财务视角答" 是可工作 UX |

## Phase 1 — DingTalk 主动推送 API

### Endpoint

```
POST https://api.dingtalk.com/v1.0/robot/groupMessages/send
Header: x-acs-dingtalk-access-token: <token>
Body: {
  "robotCode": "<bot's robotCode>",
  "openConversationId": "<group cid>",
  "msgKey": "sampleMarkdown",
  "msgParam": JSON.stringify({"title": "...", "text": "..."})
}
Response: {"processQueryKey": "<async-delivery-key>"}
```

### access_token

```
POST https://api.dingtalk.com/v1.0/oauth2/accessToken
Body: {"appKey": "...", "appSecret": "..."}
Response: {"accessToken": "...", "expireIn": 7200}
```

TTL 2 hours. Bot processes should cache + refresh on 401 or near expiry.

### Where Phase 6.0 bots get the inputs

- `appKey` / `appSecret` — from per-bot `.env` (one set per DingTalk app, separate from current bot's set)
- `robotCode` + `openConversationId` — already auto-populated by Stream SDK callbacks into `conversation_registry.py` writing `~/.paperclip/dingtalk_conversations.json`. Phase 6.0 reuses this exact pattern per-bot
- `msgKey` valid values for Open API: see [DingTalk Open Doc — 群消息类型](https://open.dingtalk.com/document/orgapp/robot-overview); `sampleMarkdown` confirmed working

### Permission grant required from user

**None** — existing "EverPretty 智能助手" app already has `chatBotSendMsg` permission enabled. When user creates 6 new apps for Phase 6.0, the checklist must include enabling this permission on each new app.

## Phase 2 — `/api/chat` `targetAgentId` extension

### Schema diff (committed)

`server/src/routes/chat.ts`:
```typescript
const chatRequestSchema = z.object({
  companyId: z.string().min(1),
  projectId: z.string().min(1),
  senderKey: z.string().min(1),
  conversationKey: z.string().optional(),
  targetAgentId: z.string().uuid().optional(),  // ← new
  text: z.string().min(1).max(4000),
});
```

`server/src/services/chat.ts`:
- `ChatHandleInput` interface: `targetAgentId?: string` added
- `handleIncoming`: when creating new issue uses `input.targetAgentId ?? deps.conciergeAgentId`. For existing-issue reuse, tracks `effectiveAgentId = existing.assigneeAgentId ?? deps.conciergeAgentId` so the wakeup correctly fires the original assignee (improvement caught during spike — Phase 5 always woke Concierge for follow-ups, even when issue was assigned elsewhere).

### Behavior verification

```
POST /api/chat {... targetAgentId=Finance UUID ...}
  → issue created, assigneeAgentId == Finance UUID         ✅
POST /api/chat {... no targetAgentId ...}
  → issue created, assigneeAgentId == Concierge UUID       ✅
POST /api/chat (repeat same composite key within 24h)
  → existing issue reused, created=false                   ✅
```

### Backward compatibility

- Old bot clients that don't send `targetAgentId` are unaffected (default Concierge routing intact)
- The follow-up wakeup fix (`effectiveAgentId = existing.assigneeAgentId`) is a behavior improvement that aligns with Phase 5's multi-agent dispatch — same-issue follow-up comments now correctly target the original assignee, not blanket Concierge

## Phase 3 — Composite conversationKey isolation

Tested 3 scenarios in sequence (same `senderKey="staff-A"` to stress-test isolation):

| convKey | Result |
|---|---|
| `dingtalk:finance-app:cid-finance-group:staff-A` | new issue `413c7604` (Finance) |
| `dingtalk:supply-app:cid-supply-group:staff-A` | new issue `beee7013` (Supply) — **distinct from A** ✅ |
| `dingtalk:finance-app:cid-finance-group:staff-A` (repeat) | reuses `413c7604`, created=false ✅ |

Phase 5's 24-hour reuse window logic works correctly with composite keys. Phase 6.0 bot processes will construct keys per `<botIdentity>:<conversationId>:<staffId>` shape recommended in Codex's review.

## Phase 4 — End-to-end Finance bot simulation

Steps:
1. POST `/api/chat` with `targetAgentId=Finance`, composite key, real Q: "EE02559 的退货率是多少？给我 1 句话财务视角的快速判断。"
2. Main issue `69674565` created, assigned Finance
3. T+150s: Finance status=done; comment written (517 字, chat-sub-issue 简答模式)
4. Read Finance's last comment from `/api/issues/.../comments`
5. POST `https://api.dingtalk.com/v1.0/robot/groupMessages/send` with the answer wrapped in a Phase 6 banner; HTTP 200 + processQueryKey

The DingTalk test group received the message — confirmed visually by user (sanity check: HTTP 200 ack means DingTalk's queue accepted the markdown).

This is the **minimum viable "Finance bot" workflow** without any Concierge involvement.

## Files changed

- `server/src/routes/chat.ts` — schema +1 field
- `server/src/services/chat.ts` — interface +1 field, handleIncoming routes via targetAgentId, follow-up wakeup uses existing assignee
- `docs/superpowers/plans/2026-05-27-c1-phase6-spike-multi-agent-channels.md` — plan with all 14 checkboxes ticked
- `docs/superpowers/specs/2026-05-27-c1-phase6-spike-spec.md` — this doc

Temporary spike artifacts (NOT committed):
- `/tmp/spike-push.py` — bare DingTalk Open API push test
- `/tmp/spike-push-answer.py` — full Finance answer relay to DingTalk
- `/tmp/phase4-answer.md` — Finance's actual 517-char answer

## Phase 6.0 GO decision + recommended next steps

**GO.** All risk gates cleared. Recommended Phase 6.0 plan structure (will be written separately):

1. **Phase 6.0a (1 day)**: User creates 6 new DingTalk apps in 钉钉开放平台:
   - Per-app: app name, app key + secret, robotCode, permission grants (`chatBotSendMsg`, Stream subscription)
   - User adds each new bot into its dedicated DingTalk group
   - Output: `.env.<channel>` files (or single `.env` with `BOT_CHANNEL=<name>`-keyed sections) for 6 new bots

2. **Phase 6.0b (1-2 days)**: `paperclip-dingtalk-bot` refactor:
   - Read `BOT_CHANNEL` env to select which agent UUID to send as `targetAgentId`
   - `concierge_client.post_chat` adds `targetAgentId` param (already optional)
   - On done, push answer back via Open API instead of reply_markdown (or both, with fallback)
   - `conversation_registry` already populates correctly per-bot

3. **Phase 6.0c (half day)**: systemd / launchd / pm2 supervisor for 7 bot processes (Concierge + 6 业务). One `.plist` per process or a single supervisor like pm2.

4. **Phase 6.0d (half day)**: end-to-end smoke test all 7 bots with simple queries; verify group isolation, no cross-app message leaks, all answers route to right group.

**Total Phase 6.0 estimate: 3-4 days** of work (down from Codex's 4-day high-end estimate for 6.0 alone, because the spike already validated the hardest parts).

Phase 6.1 (live event broadcast for Concierge-dispatched sub-issues) remains scoped separately and is NOT required for the user's initial use case ("用户直接 @ 各 agent 问问题").

## Known limitations / risks for Phase 6.0

1. **DingTalk app creation is manual**. User must do 6 portal actions: create app, enable bot, grant `chatBotSendMsg`, configure Stream subscription, install into group. Build a checklist before this; auto-onboarding via DingTalk Open API is out of scope for 6.0.

2. **Token refresh discipline**. 2-hour TTL. Each bot needs cache + refresh-on-401 logic. Reference implementation: `/tmp/spike-push.py` (currently fetches fresh per call — bot version must cache).

3. **DingTalk Open API rate limits unknown**. The push endpoint likely has per-app QPS limits — if Phase 6 traffic gets heavy, must add backoff. Not a 6.0 risk for the expected use case (interactive chat, single-digit qps per channel).

4. **Concierge keeps the existing single bot**. The current "EverPretty 智能助手" app continues to host Concierge; Phase 6.0 adds 6 sibling apps. Users will need to know which group to ask in (no auto-routing across apps in 6.0).

5. **No live event yet for sub-issue progress broadcasts**. Phase 6.0 only handles "user → agent → answer" round-trip. Concierge's sub-issue dispatch (Phase 5) won't broadcast intermediate Finance/Supply/etc. progress into their dedicated bot groups until Phase 6.1.

## Spike commits

- (this session) `feat(c1/phase6-spike): /api/chat supports targetAgentId routing (Phase 2)`
- (this session) `docs(c1/phase6-spike): Phase 1 PASS — DingTalk 主动推送验证通过`
- (next) `docs(c1/phase6-spike): spec — all 4 unknowns validated, Phase 6.0 GO`
