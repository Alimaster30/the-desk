# Agentic Call and Message System

Node 22.14 or newer, React/Vite, Fastify, MongoDB Atlas, Telnyx WebRTC, and a shared Hypermeow/meowcaller WhatsApp gateway.

## Setup

Run commands from this project folder. In Windows PowerShell use `npm.cmd` if script execution policy blocks `npm`.

Local credentials, databases, WhatsApp sessions, recordings, downloaded tools and verification artifacts are excluded from Git. Create your own `.env` from `.env.example`; a clone does not include local accounts or runtime data. Before starting the server, install Go 1.27 or later and build the shared WhatsApp gateway:

```powershell
go -C services/whatsapp-voice build -trimpath -o ../../data/whatsapp-voice/gateway.exe .
```

See [VOICE-AGENT.md](VOICE-AGENT.md) for WhatsApp linking and [Order confirmation setup](#order-confirmation-ivr) for the optional local IVR audio files.

For npm 12.2.2, update Node first: it requires Node `^22.22.2 || ^24.15.0 || >=26.0.0`. A current Node 22 LTS patch works. Node 22.14 with its bundled npm 10 also supports this project; upgrading npm is optional. Node's `ExperimentalWarning` messages about SQLite or type stripping are informational, not migration failures.

1. Install dependencies with `npm.cmd ci` on a new checkout. Dependencies are already installed in this workspace.
2. Keep credentials in `.env` using `.env.example` as the template. Set `MONGODB_URI` to your Atlas connection string. The app uses the `agentic_desk` database by default; set `MONGODB_DB` to select another database. This setting takes precedence over the database path in the URI.
3. Give the Atlas database user read/write access to that database and allow your machine's public IP in Atlas Network Access. DNS and outbound access to Atlas must work from the machine running Node.
4. Stop any running copy of the app before migration, then run:

   ```powershell
   npm.cmd run migrate:atlas -- --dry-run
   npm.cmd run migrate:atlas
   ```

5. After migration reports `migrated: true` and `verified: true`, run:

   ```powershell
   npm.cmd run dev
   ```

Open http://127.0.0.1:5173. For the built app, run `npm.cmd run build` followed by `npm.cmd start`, then open http://127.0.0.1:8787.

## Accounts

Once your instance is running, use **Create an account** to register with your own email and password. Public signup creates a regular user. To give your own account admin access, have the deployment owner set its `role` to `admin` in the `users` collection of the configured MongoDB database, then sign in again.

This repository ships without accounts or a database. The startup instructions above assume you have an existing SQLite database to migrate or an Atlas database where migration has already completed. A fresh clone with a blank database needs a separate initialization step, which the project does not currently provide.

## Migration behavior

The migration copies every SQLite table into the corresponding MongoDB collection, retaining numeric IDs, references, password hashes, balances, timestamps, sessions, and summaries. It also copies the cached Telnyx credential into `app_settings` and all Baileys JSON authentication entries into `wa_auth` using their existing serialized format.

It refuses to overwrite nonempty target collections. The import, counters, and completion marker commit in one Atlas transaction after every copied record is compared with the source. It verifies collection counts again after commit. Re-running a completed migration leaves the target unchanged. SQLite is opened with an exclusive lock during copying, and a backup is saved in `data/migration-backups` before import. Keep other WhatsApp processes stopped so the authentication files do not change during copying.

Record verification compares every field strictly after converting the SQLite row to a plain object, matching the MongoDB document's prototype.

The server uses MongoDB exclusively and requires the completion marker before listening. SQLite and the original authentication files remain local backups and are not used by the server. `/api/health` pings MongoDB.

If Atlas is unreachable, migration exits with an error before writing records. Retry `npm.cmd run migrate:atlas` after resolving connectivity. No automatic SQLite fallback is performed.

## Checks and rollback

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run build
```

Tests cover existing business logic plus MongoDB authentication/authorization, duplicate billing updates with mocked database calls, and login/signup field validation. They do not prove live Atlas connectivity.

The interface uses a warm paper workspace, charcoal sidebar, editorial titles and restrained glass controls, based on the supplied Nomi AI screenshot and Figma Settings Liquid Glass UI reference. The admin workspace opens to Analytics, and regular accounts with Orders access have an Orders page. The mobile drawer supports keyboard focus containment, Escape and inert background content. Calls remain mounted across navigation; signing out ends the call and disconnects the phone client.

Login and signup include a show/hide password button, inline errors on blur or submission, first-error focus, and disabled controls while submitting. Signup follows the existing server rules: at least two characters in the trimmed name, a valid email, and a password of at least eight characters. Login requires an email and password without applying signup password-length rules to existing accounts. Switching forms clears the password and validation errors.

See [UI-UX-AUDIT.md](UI-UX-AUDIT.md) for implemented fixes, remaining functionality gaps and verification limits. [DESIGN.md](DESIGN.md) records the shared visual system. Synthetic desktop/mobile evidence is in `artifacts/ui-redesign/`. The redesign was verified against an isolated application with fake providers; no live messages, purchases or calls were made.

## WhatsApp connection

Run `npm run dev`, sign in as admin and open **Admin → WhatsApp**. The connection panel always shows its status and Connect control. The server still tries the saved session at startup. If it is already linked, the panel shows **Connected** and explains that no QR is needed. For a disconnected or failed session, click **Connect to WhatsApp**; when the code appears, use WhatsApp on the phone → **Linked devices → Link a device**.

Status errors are visible, live updates are backed by a five-second status refresh, and a handshake that produces neither a QR nor a connection within 45 seconds becomes retryable. Repeated clicks reuse an existing connecting, QR or connected socket. If WhatsApp has logged the session out, Connect begins fresh pairing in a new authentication namespace; old auth entries and saved chats are retained, so clearing `wa_auth` is unnecessary. The active-session pointer and credentials remain private server-side data.

Connection tests use a fake transport and synthetic QR, covering admin authorization, duplicate clicks, QR generation, saved sessions, logged-out recovery, stale socket events, timeout/retry, shutdown and retained auth records. Browser checks cover desktop/mobile QR display, connected state and visible failure/retry. No real phone was scanned and no live WhatsApp messages were sent in these checks.

## Order confirmation IVR

Open **Orders** (`/#/orders`) as an admin or as staff with Orders access. Register an existing order with its reference, customer phone in international `+` format, description, total, currency, message channel and English/Urdu language. **Save and start confirmation** records the order and queues its first message in the same transaction when live actions are enabled. **Save order** lets you review the order first and use **Send confirmation request** later. **Call customer** requires the customer's request for the selected channel and queues the first message if needed.

In **Admin workspace → Staff access**, grant Orders access by entering the email of an existing regular account. The staff member can refresh or sign in to see Orders, and can work on orders they create. Removing access takes effect on the next API request. Admins can review all orders. WhatsApp inbox and device setup are admin-only. Each installation serves one organization.

**Admin workspace → Analytics** shows 7- and 30-day reports for order outcomes, initial confirmation messages, callbacks and recorded Telnyx usage. Daily totals use UTC. Failed and pending records link to the order. Older processed messages without acknowledgement evidence are counted separately.

Customers can reply on WhatsApp or SMS with `CONFIRM ORD-123`, `CANCEL ORD-123`, or `CALL ORD-123`. Commands must include the exact reference and come from the registered phone number. `CALL` requests one Telnyx callback. The IVR accepts **1** to confirm, **2** to cancel, and **9** to repeat. It plays the menu at most three times and caps a call at 90 seconds. An unanswered call leaves the order pending. Text confirmation before dial dispatch suppresses the call; a decision during a call requests hangup. A final receipt uses the order's original message channel, even when the decision arrived through the other channel.

The optional [conversational voice assistant](VOICE-AGENT.md) supports English and Urdu on Telnyx and WhatsApp callbacks. WhatsApp text and voice share one gateway and one QR login. Voice requests for order decisions require approval by text.

There is one call attempt and one invitation per order. Delivery failures and interrupted actions appear in **View action log** and are not automatically retried, because a timed-out provider request may already have delivered the message or started the call. Review the provider/chat history before taking further action. The log's `done` means the provider acknowledged the send/command, not that the customer read the message or the carrier delivered an SMS. With the optional text agent off, vague or unrecognized replies from a customer with a pending order receive reference-based instructions through the original message channel and bypass the general chat bot. The admin supplies the known order details; creation of orders from conversation is outside this increment.

Live actions are **off by default**. To activate them after reviewing a test order:

1. Prepare a Telnyx **Voice API / Call Control application** and outbound voice profile with permission to call the destination. Set its ID as `TELNYX_CALL_CONTROL_CONNECTION_ID`; this is separate from the existing WebRTC connection ID. Enable the application's **Call Cost Webhook Event** so `call.cost` can update billing. The existing API key, webhook public key and voice caller number are also required. Calling checks the order owner's app credit and retains normal call-cost accounting when cost events arrive; it does not reserve an estimated call charge in advance.
2. Expose the Fastify server on a stable public HTTPS origin, such as a tunnel forwarding to port 8787. Put only that origin in `PUBLIC_BASE_URL`, for example `https://your-host.example`. The application supplies `/api/telnyx/webhook` when dialing. Point the SMS number's messaging profile webhook to that same path. It verifies Telnyx signatures before accepting call events or SMS replies. The SMS sender must support messaging; set `TELNYX_SMS_PHONE_NUMBER` when it differs from the voice number. Account registration and destination support still apply.
3. Connect WhatsApp on the existing admin page for WhatsApp invitations/receipts. Orders with SMS as the original channel use Telnyx Messaging.
4. Keep the prepared `data/order-ivr/en.wav` and `ur.wav` on the server. The files in this workspace are 8 kHz, mono, 16-bit PCM WAV. `ORDER_IVR_DIRECTORY` can select another folder. The public `/api/order-audio/en.wav` and `/api/order-audio/ur.wav` routes serve only these two generic menus, with no customer details. Check **Preview the phone menu**, and confirm that Telnyx can fetch the audio from the public origin.
5. Set `ORDER_AUTOMATION_ENABLED=true` in `.env`, then restart `npm run dev`. Enabling the worker can dispatch previously queued actions; inspect the action logs first. This implementation has left the real `.env` and live-action flag unchanged.

English audio was generated locally with Kokoro-82M (`af_sarah`). Urdu audio was generated through the official ZONOS3-Mini demo with the publisher's Ananya stock voice, Urdu-script text and neutral controls. Both publishers release their model weights under Apache-2.0: [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M), [ZONOS3-Mini](https://huggingface.co/Zyphra/ZONOS3-Mini). Source recordings, exact scripts, hashes and format/non-silence checks are in `data/order-ivr`; review pronunciation before customer use. No Hugging Face API token or runtime hosted TTS service is needed for these cached menus. The IVR references the details sent by message; it does not speak dynamic order details.

New collections are `orders`, `order_jobs` and `order_events`. Unique indexes guard references, queued actions and incoming event IDs. State changes and their queued actions commit in Atlas transactions. The worker retains pending work across restarts and flags stale in-progress work for review. Keep one application instance for this small MVP; the queue uses atomic claims, but these tests do not establish distributed delivery guarantees.

`npm test` includes isolated order-flow tests with fake MongoDB/provider responses. They cover authorization, validation, duplicate/cross-channel replies, signed SMS webhooks, keypad input, bounded repeats/timeouts, reordered events, accounting linkage, failures and the live-action switch. They do not establish real carrier delivery, live Atlas transaction behaviour, WhatsApp device compatibility or telephone audio/keypad performance. `ORDER-CONFIRMATION.md` records the scope and acceptance checks.

## Shared WhatsApp/SMS text agent

Increment 1 adds a LangChain `createAgent` workflow using the existing `GEMINI_API_KEY` and `GEMINI_MODEL`. It understands natural-language requests for **existing registered orders**. Its scoped `get_customer_order` tool can read only the sender's orders; validated structured output proposes an action. Customer messages, selected order details and up to six recent agent turns are sent to the configured Gemini service. There is no product catalogue or new-order creation in this increment.

After the ordinary messaging setup is ready, set `TEXT_AGENT_ENABLED=true` alongside `ORDER_AUTOMATION_ENABLED=true`, then restart `npm run dev`. Both flags default off; the implementation has left the real `.env` unchanged. The admin Orders page shows the text-assistant setup state and any approved customer details. Configuration status checks key presence, not model quota or availability.

Example: `Mera naam Ali hai, mera pata House 5 Lahore hai` produces an order-specific preview. The customer replies `YES ORD-123` (or `haan ORD-123` / `جی ہاں ORD-123`) to approve, or `NO ORD-123` to withdraw. Names, addresses and delivery notes are copied from the current customer message and saved only after approval. A bare yes/haan is accepted only for one outstanding proposal on the same channel. Proposals expire after ten minutes and cannot be approved before the preview send was acknowledged. If several orders exist, supply the exact reference. The agent considers the latest twenty registered orders for that phone; ask staff about older orders.

`Please confirm my order`, `mera order cancel kar dein`, and `مجھے فون کریں` propose the corresponding action, then request the same explicit approval. Callback approval uses the existing Telnyx credit/configuration checks and one-attempt limit. Status questions return saved facts without changing the order. Agent replies use the incoming message channel; final decision receipts retain the original order channel. These are phone callbacks, not WhatsApp voice calls.

Exact `CONFIRM/CANCEL/CALL <reference>` commands still work directly. Unknown numbers retain the existing general WhatsApp bot behaviour and receive no order data from this agent; SMS from unknown numbers is ignored by the order service. Natural messages from registered order numbers bypass the general WhatsApp bot.

Inbound messages are deduplicated and durably queued before the webhook returns. One model job runs separately from the call-action worker so model latency cannot hold up IVR commands. Model calls have a 60-second deadline, no automatic provider retries and a bounded tool loop. Each phone can submit six agent requests per clock minute, followed by one wait notice; exact commands remain available. Failed/invalid model responses produce command instructions without changing customer or order data. Interrupted sends require review in **View action log**. Keep a single application instance for this MVP.

The agent adds optional `customer`, `agent_proposal` and intake-counter fields to orders and input/reply text to order jobs; internal proposal/counter fields are omitted from the admin API response. Protect database backups as customer data. Automated tests use synthetic records and mocked providers, including the actual LangChain graph/tool exchange. After the Gemini key update on 2026-11-13, seven live-model synthetic scenarios passed: English status, Roman Urdu and Urdu customer-detail collection, English confirmation, Urdu cancellation, negated confirmation, and a WhatsApp-call request that does not place a telephone call. Model requests were real; messaging and MongoDB were isolated fixtures. The earlier key hit quota, and the first retest exposed a 20-second deadline that was too short. The text agent now uses low thinking effort and a 60-second overall deadline. These samples do not establish general language accuracy or live carrier delivery. See `artifacts/text-agent/live-check.json`. The dependency audit found three moderate advisories in the existing Telnyx WebRTC/uuid chain and none in the added LangChain dependency chain; no unrelated dependency downgrade was applied.

Before conversion, server code and package files were copied into `data/code-before-atlas`. To roll back before using Atlas, stop the app, restore those files, and use the retained `data/app.db`. If the app has already written new records to Atlas, export and reconcile those writes before reverting to SQLite; the old SQLite file does not contain them.
