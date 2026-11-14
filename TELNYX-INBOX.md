# Telnyx inbox

The personal workspace's **Telnyx** page contains the SMS inbox. **Make a call** stays a separate dialer. A conversation's Call link fills that dialer with its contact number; it never starts a call automatically. Calls continue when navigating between pages.

Each account sees messages for its own successfully ordered numbers. The configured `TELNYX_SMS_PHONE_NUMBER` (falling back to `TELNYX_PHONE_NUMBER`) is available to the first admin when it has no assigned owner. Pending/review number purchases cannot send. Admin status alone does not expose another account's message history.

New inbound messages and delivery receipts use the existing signature-verified `/api/telnyx/webhook`. Configure this HTTPS endpoint on the number's Telnyx messaging profile. Outgoing order messages are also recorded. Historical messages from before this feature are not imported. Number SMS/MMS capability, messaging-profile assignment, destination support and carrier registration remain Telnyx prerequisites.

For local development, run `npm.cmd run dev` and, in another terminal, `npm.cmd run webhook:telnyx`. The latter requires the official Cloudflare `cloudflared` executable in `.tools/cloudflared.exe` on Windows (`.tools/cloudflared` elsewhere). It starts a temporary HTTPS tunnel to a restricted relay on port 8788, assigns that URL to the configured sender's existing messaging profile, and reads the profile back to verify persistence. Only POST requests to `/api/telnyx/webhook` are forwarded to the app; original body bytes and signature headers are preserved. Other routes return 404. The application still checks Telnyx signatures. This tunnel does not expose the app UI, private APIs, MMS media or order audio.

Keep both processes running to receive messages. The tunnel command assigns a new URL whenever restarted; it is for development, not a permanent hosted service. Production needs a stable HTTPS webhook endpoint. Starting the app alone does not start this tunnel. The webhook command updates the whole messaging profile, so use a profile dedicated to Desk.

The shared composer supports text, emoji and PNG/JPEG MMS photos up to 1 MB. MMS requires `PUBLIC_BASE_URL` to be the app's public HTTPS origin, which must reach the backend `/api/telnyx-media/` route. Random photo links expire after 24 hours for the provider; the original account retains authenticated photo access. External inbound media URLs remain subject to Telnyx's retention period. Unsupported files and stickers are rejected.

Accepted messages appear as queued, not delivered, until carrier receipts arrive. A client request UUID reserves each send before the provider request. Repeating an accepted request returns its existing acknowledgement. Explicit provider rejections can be retried with the same UUID after fixing the issue. Unknown send attempts and potentially ambiguous HTTP 408/409 responses require reviewing provider history before sending a new request; the app never retries them automatically. USD messaging costs reported by signed final receipts (or inbound receipts) debit the local balance once. Costs stay pending if Telnyx has not reported them, and existing in-flight messages may take the balance below zero.

The three-dot menu exposes the existing organization-wide order assistant controls. Text and Voice are independent, managed by admins, and shared with Orders. They handle existing order workflows and requested callbacks; they are not a new general-purpose SMS bot or an inbound voice answering service. Manual SMS and the browser dialer remain independent of these switches.

Summaries update automatically using Gemini, identify outgoing messages by the account owner's name and reuse unchanged summaries. The inbox lists the 200 most recently active conversations and the latest 200 messages per conversation. Older messages remain stored. Summaries describe text only and report provider/quota failures without putting errors into customer messages.

Reference: https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks
