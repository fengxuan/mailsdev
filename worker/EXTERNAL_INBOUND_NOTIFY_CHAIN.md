# External Inbound Email Notify Chain

Last updated: 2026-06-16

This document describes the current external inbound email -> user notification chain.
It is meant to help future AI or human changes stay fast, safe, and consistent.

## Scope

The path covered here is:

1. an external email arrives at `mailsdev/worker`
2. the email is parsed and persisted
3. direct/group mail state is updated
4. realtime events are emitted to `mails-realtime-notify`
5. websocket fanout happens
6. APNS fallback may happen if no active websocket received the event

This path does not use `mails-chat-api` as a runtime hop, but it must remain compatible with:

- realtime event shapes expected by iOS
- conversation/message HTTP truth served by `mails-chat-api`
- shared auth and env contracts such as `REALTIME_INTERNAL_TOKEN`

## Repos and responsibilities

- `mailsdev/worker`
  - inbound mail entrypoint
  - persistence into D1
  - direct thread and group index updates
  - realtime envelope construction
  - producer transport to realtime notify
- `mails-realtime-notify`
  - internal notify validation
  - dedupe and target-user grouping
  - durable object websocket fanout
  - APNS fallback when websocket delivery misses
- `mails-chat-ios`
  - consumes websocket events
  - may apply incremental updates immediately
  - still reconciles against HTTP truth
- `mails-chat-api`
  - not on this hot path
  - remains the source of HTTP-visible truth and shared event-field expectations

## Key invariants

- Persist before notify.
  Realtime is an overlay, not the source of truth.
- Duplicate inbound mail must not double-notify.
  Current dedupe is based on normalized `message_id`.
- `fast_chat` groups are intentionally excluded from this path.
- Service binding is preferred over public/internal HTTP when available.
- `REALTIME_INTERNAL_TOKEN` must stay in sync across:
  - `mailsdev/worker`
  - `mails-chat-api`
  - `mails-realtime-notify`
- Do not casually change projection truncation limits.
  Current realtime projection builder truncates to:
  - `bodyText.slice(0, 50_000)`
  - `bodyHtml.slice(0, 100_000)`

## Current end-to-end flow

### 1. Inbound email entry

Entrypoint:

- `mailsdev/worker/src/index.ts`
- `export default { async email(...) }`

Current behavior:

- normalize mailbox and sender
- short-circuit if mailbox is deleted
- look up active chat group by mailbox
- ignore inbound mail for `fast_chat` groups

Important note:

- `fast_chat` mailboxes use a different message insertion strategy and are not handled by this external inbound mail notify path

### 2. MIME parsing

Parsing happens in:

- `mailsdev/worker/src/mime.ts`
- `parseIncomingEmail(...)`

Current hot-path behavior:

- MIME parsing still happens synchronously
- attachment text extraction is deferred with `deferAttachmentTextExtraction: true`
- `bodyText` prefers parsed plain text
- `bodyHtmlText` is only computed when plain text is missing
- `chatProjection` is no longer built inside MIME parsing

Why this matters:

- earlier versions always paid for `htmlToText(bodyHtml)` and projection work even when later stages did not need it
- the current version keeps MIME parsing focused on the minimum needed to persist and route the message

### 3. Verification-code extraction

Code extraction currently happens immediately after parsing.

Implementation:

- `mailsdev/worker/src/extract-code.ts`
- `extractEmailCode(...)`

Current behavior:

- check normalized `bodyText` first
- only fall back to HTML cleanup if the body text path did not find a code
- use precomputed `bodyHtmlText` when available

This means:

- HTML cleanup is now lazy for the common case where plain text already contains the verification code

### 4. Persistence

Primary write target:

- `emails`
- `attachments`

Current behavior:

- dedupe by normalized inbound `message_id`
- if the email already exists:
  - reuse existing email id
  - skip insert
  - skip realtime scheduling
- if the email is new:
  - insert email row
  - insert attachment rows
  - queue deferred attachment text backfill

Important invariant:

- notify must happen after persistence, not before
- the client may reconcile over HTTP immediately after realtime, so DB truth must already exist

### 5. Direct-thread and group index updates

After persistence handling:

- direct external thread bookkeeping runs via `maybeUpsertDirectExternalEmailThreadFromInbound(...)`
- group mail indexing runs via `maybeUpsertChatGroupMessageIndex(...)`

Group index behavior:

- active mail groups store a normalized message index row
- current inbound path can reuse a prebuilt projection instead of rebuilding the preview multiple times

### 6. Decide whether message projection work is needed

Projection builder:

- `mailsdev/worker/src/index.ts`
- `buildRealtimeMessageProjection(...)`
- internally uses `buildMailChatProjection(...)`

Heavy helpers live in:

- `mailsdev/worker/src/mail-chat-projection.ts`
- `extractChatTextFromSources(...)`
- `extractRenderableHTMLFromSources(...)`

Current behavior:

- projection is built only when needed
- current inbound entry builds it only if:
  - the mailbox belongs to a mail group, or
  - the email is new and realtime notify is configured

This avoids reply-stripping and render-text work for inbound mail that will not produce realtime or group-index output.

### 7. Realtime event resolution

Realtime scheduling entry:

- `scheduleRealtimeNotifyForIncomingMailbox(...)`

Resolution logic:

- `resolveRealtimeEventsForIncomingMailbox(...)`

There are two main branches.

#### Group mail branch

If the target mailbox is an active group mailbox:

- list active realtime members
- build one event per target user
- mark direction as:
  - `outbound` for the member whose mailbox matches the sender mailbox
  - `inbound` for everyone else
- prefer the just-indexed current group message when available
- otherwise fall back to reading the latest stored group index row

The current path usually emits rich `conversation_updated` events, not bare dirty events.

#### Direct mail branch

If the target mailbox is not a group mailbox:

- resolve the owning direct user id
- derive external thread topic when applicable
- build a single inbound direct event

The current path also prefers rich `conversation_updated` payloads so the client can update faster before HTTP reconcile.

### 8. Envelope building and transport

Envelope builder:

- `buildRealtimeNotifyEnvelope(...)`

Current behavior:

- if `event.conversation` exists, emit `type: "conversation_updated"`
- otherwise emit `type: "conversations_dirty"`

Producer send path:

- `sendRealtimeNotifyEvents(...)`
- `sendRealtimeNotifyRequest(...)`

Transport behavior:

- single event -> `POST /internal/notify`
- multiple events -> `POST /internal/notify-batch`
- prefer `REALTIME_NOTIFY_SERVICE.fetch(...)`
- fall back to `fetch(REALTIME_NOTIFY_BASE_URL + path)`
- always authenticate with `Authorization: Bearer <REALTIME_INTERNAL_TOKEN>`

Configuration in this repo:

- `wrangler.toml`
- `[[services]] binding = "REALTIME_NOTIFY_SERVICE"`
- `[vars] REALTIME_NOTIFY_BASE_URL = "https://mails-realtime-internal.canyin.uk"`

The service binding is the preferred production path because it removes an external HTTP hop.

### 9. Realtime relay and websocket fanout

`mails-realtime-notify` receives internal notify requests at:

- `POST /internal/notify`
- `POST /internal/notify-batch`

Relevant files:

- `mails-realtime-notify/src/index.ts`
- `mails-realtime-notify/docs/protocol.md`

Current relay behavior:

- validate `REALTIME_INTERNAL_TOKEN`
- parse and validate envelope shape
- suppress redundant `conversations_dirty` events when a richer `conversation_updated` for the same user/conversation is present
- group events by target user
- broadcast through the `USER_CHANNELS` durable object for that user
- log per-event and per-batch delivery counts

### 10. APNS fallback

APNS fallback is handled in `mails-realtime-notify`.

Current behavior:

- only considered when websocket `delivered_count == 0`
- only considered for inbound `conversation_updated`
- direct conversations may send alert pushes
- group conversations use background-style pushes
- APNS sends are throttled per device registration

Important implication:

- if you regress the worker from rich `conversation_updated` back to bare dirty events, offline APNS fallback quality will degrade

### 11. Client side

The iOS client currently treats realtime as a foreground overlay:

- websocket events can update local state immediately
- HTTP remains the reconciliation source
- missed websocket events are expected to be recoverable by HTTP fetch

That is why persistence-before-notify is a hard rule.

## Current hot-path optimizations already landed

These are important because future edits should not accidentally undo them.

1. Deferred attachment text extraction
2. Service binding support for realtime notify producer transport
3. Reuse of inbound projection across group index and realtime payload building
4. Lazy HTML cleanup for verification-code extraction
5. No eager chat projection construction inside `parseIncomingEmail(...)`
6. Realtime payload building can use the just-arrived current inbound message instead of always re-querying latest stored state

## Current hotspots worth optimizing next

These are the safest next places to improve latency without changing product behavior.

### 1. Split projection into cheap preview vs rich render

Today `buildMailChatProjection(...)` still does both:

- chat text cleanup and reply stripping
- optional renderable HTML selection

This is still one of the heaviest remaining hot-path steps.

The next likely win is:

- keep a cheap text preview path for immediate notify
- move richer `renderText` and more expensive reply/HTML cleanup behind an async or secondary path

### 2. Persist or cache richer projection outputs only if reuse is real

Do not add storage blindly.

Only consider persistence if repeated downstream reads justify it, for example:

- repeated direct latest-email projection rebuilds
- repeated group latest-index preview rebuilds outside the current inbound event path

### 3. Keep group fanout and APNS semantics intact

Any performance change must preserve:

- one event per target user
- sender-specific direction
- `conversation_updated` payload richness
- APNS eligibility for inbound direct mail

### 4. Do not move notify ahead of DB commit

This is the highest-risk "optimization" and should be avoided unless the whole consistency model changes.

## Files to read before modifying this chain

Within `mailsdev/worker`:

- `src/index.ts`
- `src/mime.ts`
- `src/extract-code.ts`
- `src/mail-chat-projection.ts`
- `wrangler.toml`

Cross-repo:

- `mails-realtime-notify/src/index.ts`
- `mails-realtime-notify/docs/protocol.md`
- `mails-chat-api/ENV_MATRIX.md`
- `mails-chat-api/MAIL_RENDER_PIPELINE.md`
- `mails-chat-api/TEST_MATRIX.md`

## Change checklist for future AI edits

If you change MIME parsing:

- verify plain-text-first behavior still works
- verify duplicate inbound mail still does not notify twice
- verify attachment text backfill still happens off the hot path

If you change projection logic:

- compare direct preview text, group preview text, and optional `render_text`
- verify APNS alert summaries still look reasonable

If you change realtime event shape:

- update `mails-realtime-notify` validation if needed
- verify iOS decoding assumptions
- verify APNS fallback still triggers for inbound direct mail

If you change transport:

- keep service binding as preferred path unless there is a strong reason not to
- keep `REALTIME_INTERNAL_TOKEN` contract aligned across all producers and consumers

If you change group membership or direction logic:

- verify sender sees `outbound`
- verify other group members see `inbound`

## Validation checklist

Minimum:

1. `cd mailsdev/worker && npm run check`

If event shape, transport, or APNS behavior changed:

1. `cd mails-realtime-notify && npm run check`
2. verify `REALTIME_INTERNAL_TOKEN` alignment across repos
3. smoke test:
   - external direct inbound mail
   - external group inbound mail
   - duplicate inbound mail replay
   - no-active-websocket case for APNS fallback

## Summary

The current chain is intentionally:

- persist-first
- projection-lazy where safe
- richer on realtime payloads than earlier dirty-only versions
- service-binding-first for producer transport
- APNS-capable only when the emitted event remains a rich inbound `conversation_updated`

Future optimization work should preserve those properties unless the product contract is deliberately changing.
