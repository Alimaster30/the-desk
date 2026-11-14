# Conversational order callbacks

Desk supports outbound **Telnyx voice assistant**, **WhatsApp voice assistant**, and the existing **Telnyx keypad menu** for registered orders. The order's message channel is independent of the call channel. Admins can manage all orders and link devices. Staff with Orders access can request callbacks for their own orders.

1. The customer requests a callback, or the admin records the customer's consent for the selected channel.
2. Desk sends the order details before dialing. Only one call attempt is allowed across both call channels.
3. The voice assistant identifies itself and speaks English or Urdu. It can answer questions using that order's reference, item and price. It cannot access other orders or change prices, delivery details or payment information.
4. During a **WhatsApp call**, an explicit spoken confirmation or cancellation saves the decision immediately for that active order. The assistant announces success only after the database transaction completes. A receipt is sent on the original order message channel; no further text approval is required. Duplicate or stale call decisions cannot change a finalized order. **Telnyx conversational calls** still queue an original-channel text preview, approved with `YES ORD-123` within ten minutes after delivery. The existing exact `CONFIRM` and `CANCEL` messages still work.

## Enable for a test order

The real `.env` was left unchanged. Set these only when you are ready to test using a number you control:

```dotenv
ORDER_AUTOMATION_ENABLED=true
TEXT_AGENT_ENABLED=true
VOICE_AGENT_ENABLED=true
GEMINI_LIVE_MODEL=gemini-3.8-live
```

Keep your existing `GEMINI_API_KEY` on the server. A synthetic Live API request returned audio with the configured key during development. Account limits apply; check [Gemini Live pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-live) for free and paid tiers. Audio and minimal order facts are sent to Gemini; Desk stores neither raw audio nor transcripts for these calls.

Admins can manage these preferences under **Orders → Live actions**. The master switch pauses order automation without erasing Text assistant and Voice assistant preferences. Text assistant and Voice assistant switches are independent. Voice-only operation retains deterministic approval via the referenced reply on the original message channel without enabling the text model. These saved organization settings take precedence over the initial environment defaults after restart. Staff can view their status but cannot change them. Enabling Live actions allows queued order jobs to resume.

**Telnyx:** complete the existing [Call Control and IVR setup](README.md#order-confirmation-ivr). Your public HTTPS origin must forward WebSocket upgrades as well as signed webhooks to Fastify. Desk verifies Telnyx's [signed media connection](https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming#verify-the-websocket-connection), the one-use stream path and the call identifier. A failed voice stream switches the same call to the keypad menu without redialing. Keep both language WAV files available for fallback.

**WhatsApp:** messaging and calling share one Hypermeow/meowcaller gateway and one linked device. Baileys is no longer used for the active text login. Its utility functions and legacy-device logout support remain during migration. No Atlas credentials are copied to the gateway. On Windows the gateway is built at `data/whatsapp-voice/gateway.exe`. With Go 1.27 or later:

```powershell
New-Item -ItemType Directory -Force data/whatsapp-voice | Out-Null
go -C services/whatsapp-voice build -trimpath -o ../../data/whatsapp-voice/gateway.exe .
```

On Linux, omit `.exe`. Run `npm run dev` and open **Admin workspace > WhatsApp > Connect to WhatsApp**. Scan the single QR under Linked devices. Scanning the QR enables both messaging and calling for that account. There is no separate voice connection switch. The single **Disconnect** button logs out both features. Auto-reply and order voice-assistant switches control automation only. A random local `WHATSAPP_VOICE_TOKEN` is created in `.env` if needed.

**Disconnect is logout:** Desk revokes the shared device and attempts to revoke any old Baileys device, stops calls, clears its cached chats/messages/attachments/summaries, removes local authentication and learned writing style, and pauses auto-reply and voice. Messages on the phone and business order records remain. Pending WhatsApp actions are skipped so they cannot resume under a different account. If remote revocation fails, the UI asks you to remove Desk from the phone's Linked devices; local keys are invalidated before reconnecting. The next connection requires QR pairing. Logging out from the phone also clears the app cache.

The gateway stores authentication and a durable message-event journal in `data/whatsapp-voice/session.db` on loopback port 8795. Atlas remains the app's message store. History received from WhatsApp repopulates the inbox after login; the available history is controlled by WhatsApp and may not include every older message. The journal is cleared on logout. Do not expose the gateway or copy its device keys into `wa_auth`. The standalone `npm run voice:whatsapp` command is still available for a manually managed shared gateway.

Once it shows **Linked**, go to **Orders**, save a test order and expand it. Select the call type, check the channel-specific consent and click **Call customer**. A customer can also send `CALL ORD-123` or `CALL-WHATSAPP ORD-123` by SMS or WhatsApp text. `CALL` uses the Telnyx assistant if configured, otherwise the keypad menu; `CALL-WHATSAPP` requires the linked gateway. Use **View action log** and the order's call status to see the outcome.

## Personal calls and manual messages

The WhatsApp chat header has a **Call** button for a personal browser microphone call. It uses the linked voice device directly; Gemini and the order agent are not involved. Microphone permission is requested only after clicking Call. The call bar provides mute/unmute and hangup. Leaving the WhatsApp page ends the browser call. Personal calls are limited to one-to-one contacts, one gateway call at a time, and one hour per call. Auto-reply can stay off.

Personal calls pass the contact's normalized WhatsApp ID directly to the gateway, including private `@lid` identities. A shared phone number or a saved LID-to-phone mapping is not required. Group and broadcast IDs are rejected.

The composer sends manual text, emoji, PNG/JPEG/WebP photos, documents (up to 5 MB) and uploaded WebP stickers (up to 512 KB). Stickers have no caption. Drafts stay with their chat while the inbox remains open. Outgoing attachments are retained in the message record and served only to authenticated admins. The sticker control uploads your own file; it does not browse WhatsApp sticker packs. Incoming media import is still outside this composer change.

Test sends and personal-call PCM forwarding use synthetic providers. No real contact was called or sent a message during verification.

## Limits and verification

- Outbound, one-to-one callbacks for existing orders. No inbound auto-answer, video/group calls, open-ended sales agent or autonomous order decisions.
- The WhatsApp transport is unofficial and can break if WhatsApp changes its protocol. An ambiguous failure goes to review; the app does not switch channels or retry a call on its own.
- Verified: 54 Node tests, two Go tests, TypeScript check and both production builds. Local tests exercise both audio transports, stream admission, interrupted playback, one-attempt consent, order approval and keypad fallback. An isolated browser check verified the separate voice device panel, the three call choices, clearing consent after changing channel and the disabled Call button while live actions are off.
- The command policy prevented the standalone gateway smoke test against WhatsApp. A real QR scan and audio on both call channels still need a controlled test call. No customer call or message was sent during implementation.
