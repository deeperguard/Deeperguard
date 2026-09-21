# AI over encrypted notes (design recommendations)

Deeperguard is zero-knowledge: note bodies and OCR text are encrypted on the client. **Sending plaintext to a cloud LLM breaks that guarantee.** Any AI feature must be designed around local decryption and explicit user consent.

## Recommended architecture

### 1. On-device AI first (privacy-preserving)

Run a small model locally (Apple Intelligence APIs, WebGPU llama.cpp, or a future desktop helper) after vault unlock:

- User selects notes or the open document
- Client decrypts only the chosen content in memory
- Model answers in a side panel; nothing is uploaded

**Best for:** summarization, “find mentions of X”, rewriting a paragraph, Q&A on one document.

### 2. Opt-in “AI session” with scoped export

When the user asks a question that needs a bigger model:

1. Show exactly which notes/attachments will be included (titles + byte size)
2. Require explicit **Send to AI** per session
3. Decrypt → send to a **user-chosen endpoint** (OpenAI, local Ollama, etc.) over TLS
4. Do not persist prompts or responses on the Deeperguard server
5. Clear session state on lock

**Best for:** cross-note research, long document analysis, users who accept trade-offs.

### 3. Metadata-only server assist (no content)

The server can help **without** reading notes:

- Suggest tags from filename/date (already partially done)
- Rank search results, fix OCR index staleness
- Reminder scheduling from `warn_at` fields

Never send ciphertext to an LLM hoping it can “figure it out”.

## Product principles

| Principle | Why |
|-----------|-----|
| Default = local only | Matches ZK brand; Standard Notes users care about this |
| Per-action consent | “Talk about this note” not “enable AI forever” |
| Show the boundary | UI label: “Processed on this device” vs “Sent to your AI provider” |
| Document-aware | OCR text is the moat — highlight which PDF pages informed the answer |
| Audit for self-hosters | Log AI provider hostname + byte count, not content |

## Suggested MVP (implementation order)

1. **“Ask about this document”** — client-only: pass OCR text + visible page to on-device or user-configured Ollama URL in Settings → Advanced
2. **Multi-note picker** — checkbox list, char budget, one-shot export to clipboard or provider
3. **Citation UI** — link answers back to note ID + attachment page from OCR boxes (reuse search hit navigation)

## What not to do

- Server-side RAG over user vaults (requires decryption or stored plaintext)
- Silent background summarization on sync
- Training on user content without separate legal consent
- Bundling a single vendor API key into the homelab image

## API sketch (future)

```
POST /api/ai/session   # not on server — client calls provider directly
Settings:
  ai_provider: off | ollama | openai | apple
  ai_endpoint: http://127.0.0.1:11434
  ai_max_chars: 12000
```

Server role: optional **proxy config** storage (encrypted with vault) for provider keys, never note content.
