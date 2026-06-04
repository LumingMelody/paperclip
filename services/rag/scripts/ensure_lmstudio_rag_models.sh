#!/usr/bin/env bash
# Ensure LM Studio is serving the RAG models at the right context length.
#
# Why: LightRAG hybrid search calls the LLM to extract keywords; if the LLM is
# loaded at LM Studio's silent 4k default, /v1/chat/completions returns 400 on
# any non-trivial prompt and RAG search comes back empty (see skill
# lm-studio-default-4k-context-silent-400). LM Studio resets to its 4k default
# every time it (re)starts, so this script re-ensures the right state.
#
# Idempotent: if the LLM is already at >= CTX it does nothing. Safe to run at
# login (RunAtLoad) and on a timer (StartInterval) to self-heal mid-session
# LM Studio restarts. Paired with com.everpretty.paperclip-rag-service.
set -uo pipefail
export PATH="$HOME/.lmstudio/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

LLM="qwen/qwen3-30b-a3b-2507"
EMB="text-embedding-bge-m3"
CTX=32768
API="http://127.0.0.1:1234"

log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S')] $*"; }

# 1) Ensure the LM Studio local server is responding (start headlessly if not).
if ! curl -sf --max-time 4 "$API/v1/models" >/dev/null 2>&1; then
  log "LM Studio server not responding; lms server start…"
  lms server start </dev/null >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    curl -sf --max-time 3 "$API/v1/models" >/dev/null 2>&1 && break
    sleep 2
  done
fi
if ! curl -sf --max-time 4 "$API/v1/models" >/dev/null 2>&1; then
  log "LM Studio server still down after wait; abort (retry next interval)"
  exit 0
fi

# 2) Ensure the LLM is loaded at >= CTX (native /api/v0 exposes loaded ctx).
cur=$(curl -s --max-time 5 "$API/api/v0/models" \
  | python3 -c "import sys,json
d=json.load(sys.stdin)
print(next((m.get('loaded_context_length') or 0 for m in d.get('data',[]) if m['id']=='$LLM'),0))" 2>/dev/null || echo 0)
if [ "${cur:-0}" -ge "$CTX" ] 2>/dev/null; then
  log "LLM $LLM already at ctx=$cur (>= $CTX); skip"
else
  log "LLM ctx=${cur:-0} < $CTX; reloading at $CTX"
  lms unload "$LLM" </dev/null >/dev/null 2>&1 || true
  if lms load "$LLM" -c "$CTX" --gpu max -y </dev/null >/dev/null 2>&1; then
    log "LLM reloaded at $CTX"
  else
    log "WARN: lms load $LLM failed"
  fi
fi

# 3) Ensure the embedding model is loaded (RAG /index + /search need it).
if curl -s --max-time 5 "$API/v1/models" \
  | python3 -c "import sys,json;sys.exit(0 if any(m['id']=='$EMB' for m in json.load(sys.stdin).get('data',[])) else 1)" 2>/dev/null; then
  log "embedding $EMB already loaded"
else
  log "embedding $EMB not loaded; loading"
  lms load "$EMB" -y </dev/null >/dev/null 2>&1 || log "WARN: lms load $EMB failed"
fi

log "done"
