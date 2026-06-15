export const CONCIERGE_ANSWER_TIMEOUT_FALLBACK_MARKER = "⏱ Concierge answer timeout fallback";

// Must stay slightly below the DingTalk bot CONCIERGE_POLL_TIMEOUT (default 900s).
// Once the bot has likely abandoned polling, an answer that completes shortly after
// still needs a server-side late broadcast. The lower threshold intentionally risks
// a rare duplicate final answer over allowing an answer black hole.
export const CONCIERGE_LATE_ANSWER_DELIVERY_THRESHOLD_MS = 870_000;
