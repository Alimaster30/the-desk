# Order confirmation MVP

## Increment 1: shared text agent

The optional LangChain/Gemini text agent handles English, Urdu and Roman Urdu messages from phone numbers with existing registered orders, on WhatsApp and signed Telnyx SMS. It reads only that sender's orders, answers order-status questions, extracts a name/address/delivery note, and proposes confirmation, cancellation or a Telnyx callback. Catalogue lookup and creation of new orders are later increments because no product catalogue exists here. See [VOICE-AGENT.md](VOICE-AGENT.md) for the subsequent conversational callback increment.

Model output is schema-validated. Customer details must be literal substrings of the latest incoming message; the model cannot change prices, products, phone numbers or another customer's orders. Changes are shown in a preview, then committed only after a matching YES/haan/Urdu approval on the same channel, received after the provider acknowledged the preview and before its ten-minute expiry. NO withdraws the proposal. A bare yes is accepted only when one proposal exists on that channel. Exact referenced commands retain their existing behaviour.

Input is durably queued without blocking the webhook. The model worker and call-action worker run separately, with one active job each. Model runs have a 60-second deadline, no provider retries and a bounded graph. A per-phone limit allows six agent requests per minute. Proposals and approved customer details live on the order; bounded conversation history and inbound text live in order_jobs. On model/schema failure no business change is made and the customer receives exact-command instructions. No model text is used as a claim of completed business action.

Both ORDER_AUTOMATION_ENABLED and TEXT_AGENT_ENABLED are required for natural-language handling. The real .env remains unchanged. Synthetic checks cover the real LangChain tool loop with a fake Gemini HTTP response, WhatsApp/SMS routing, approvals, expiry, sender isolation, duplicates, rate limits and a stalled-model/call-action overlap. After updating the Gemini key, seven live-model synthetic scenarios passed across English, Urdu and Roman Urdu with local approval/receipt checks. Earlier quota and deadline failures are retained in the verification history; low thinking effort and a 60-second model deadline resolved the observed timeout. General language accuracy remains unqualified. No real WhatsApp/SMS/call was sent.

## Original IVR scope

Baseline scope: an admin registers an existing order, sends its details by WhatsApp or SMS, and the customer replies CONFIRM, CANCEL or CALL followed by the reference. CALL requests one Telnyx phone call. The IVR accepts 1 to confirm, 2 to cancel, and 9 to repeat. A final receipt goes to the order's original message channel.

Admins can manage all orders in this installation and can grant regular accounts access to manage their own orders. Save an order for review or use **Save and start confirmation** to queue the first message. Calls require the customer's request. Exact commands match the registered customer's E.164 number and order reference. Staff supply the order details.

MongoDB stores orders, deduplicated inbound events, and a small durable action queue. Terminal order decisions are immutable. Calls are limited to one attempt per order; repeat/delivery events cannot create another call. Unanswered calls leave the order pending. Interrupted or ambiguous external actions require review rather than automatic redial or duplicate messaging. Existing call accounting and signed Telnyx webhook verification remain in use.

The IVR uses a cached English or Urdu menu prepared before calling. Order details are in the preceding message, allowing a generic prompt without a hosted TTS dependency during a call. Public audio contains no customer or order details. Live actions require ORDER_AUTOMATION_ENABLED=true plus the documented connection, public HTTPS address and audio files. This implementation does not enable that flag or place a live test call.

Implementation order: validate inputs and decisions; persist orders and queued actions; connect WhatsApp/SMS and signed call events; add the admin page; verify the complete flow with fake provider responses and isolated data, then browser-check desktop and mobile.

Checks: `npm test`, `npm run check`, `npm run build`. Tests belong beside server modules and use Node's test runner. Keep existing TypeScript/React conventions, validate external inputs and provider responses, never expose credentials or send real messages in automated tests. Acceptance includes duplicate CALL suppression, cross-channel confirmation before dial, keypad decisions/repeats/timeouts, stale or reordered webhooks, signed SMS sender checks, admin authorization, provider failures and durable queue recovery. No production records are deleted or rewritten.
