# UI and UX audit

Reviewed 13–14 November 2026. Implemented directly from the user's Nomi AI screenshot and the [Settings Liquid Glass UI reference](https://www.figma.com/community/file/1533491545657955757/settings-liquid-glass-ui) by Sithum Lahiru. The public Figma preview was inspected; source layers were not imported. WhatsApp and orders remain admin-only, as confirmed by the user.

## Delivered

| Area | Changes and verified behavior |
| --- | --- |
| Shared shell | Warm paper workspace, charcoal sidebar, serif page titles, self-hosted licensed fonts, restrained translucent chrome, active routes, page titles, skip link and account identity. No placeholder notification/settings actions. |
| Mobile | Drawer replaces sidebar; hidden links and covered workspace are inert. Tab and Shift+Tab stay within the open drawer, Escape closes it and restores focus. Tables scroll inside their containers. Reduced-motion preference is respected. |
| Personal overview | Actual API balance, spend, minutes, destination history and transactions, with useful Calls/Billing links and loading/error/empty states. |
| Calls | Outbound dial/hangup and existing call history/cost refresh retained. Call controls stay mounted across route changes. An active-call banner returns the user to controls. Sign-out ends/tracks the call and disconnects RTC; stale SDK events and pending setup cannot leak into the next login. |
| Numbers | Search progress, separate owned/available headings, inline price confirmation, purchase guards, actual success notice and balance refresh. Displayed search country is retained for the purchase. Uncertain provider orders remain visible for review. |
| Billing | Amount limits and note length, busy state, clear approval explanation, request history and status badges. Confirmed saves remain successful when the subsequent history refresh fails. |
| Admin approvals | Pending/all filters, refresh control, explicit result feedback and duplicate-click guards. Confirmed decisions update locally even if a later list refresh fails. |
| Admin WhatsApp | Connection/QR controls retained, compact connected state, conversation search, transcript and summary. Switching customers clears previous messages and guards stale responses. Selected mobile conversation receives focus and scrolls into view. Auto-reply uses acknowledged server state; unknown settings show Loading/Unavailable and Retry rather than Off. |
| Admin orders | Existing-order form, consent, English/Urdu menu preview, search, expandable records and action logs retained. Unknown setup is distinguished from disabled live actions. Saved orders and queued actions keep their confirmed outcome after refresh failures; acknowledged actions cannot be queued again in the mounted view. |
| Authentication | Responsive sign-in/signup matching the shell; password visibility, inline field validation, first-error focus, submitting state and password clearing on form changes retained. |

## Remaining gaps

These are source-confirmed limitations, not functioning controls hidden by the redesign.

| Priority | Gap | Consequence / next work |
| --- | --- | --- |
| High | Real-device acceptance of conversational callbacks is pending. | The [voice increment](VOICE-AGENT.md) adds Telnyx and WhatsApp voice callbacks alongside the keypad IVR. Test the linked device and real carrier audio before using it for customers. |
| High | Ambiguous provider outcomes require manual reconciliation. | A timeout may follow a real send/purchase/call. The application avoids silently repeating order actions; an admin must review provider/action history. A persisted reconciliation workflow is still needed. |
| Medium | No manual WhatsApp composer or general SMS inbox/composer. | WhatsApp history, summaries and automatic replies exist; use the linked phone for a manual reply. SMS currently serves the order workflow. |
| Medium | No inbound call answer/reject, mute, hold or keypad controls in the regular Calls screen. | The current user flow supports outbound Call/Hang up and history. Add these controls only with actual SDK/backend behavior and browser validation. |
| Medium | Conversational intake cannot create a new order or look up a product catalogue. | The text agent works with registered existing orders. Admins currently enter authoritative order details. |
| Medium | Live integration setup is configured through server environment variables. | There is no credentials/onboarding settings screen or UI activation switch. Verify prerequisites before enabling real automation. |
| Medium | Billing uses USD account credit; no FX, refund or recurring-number-billing management UI. | Number inventory displays USD through the current price formatter. Multi-currency support would need an explicit account/currency contract. |
| Low | Initial account-service failure falls back to the sign-in screen. | It does not distinguish a server outage from an expired session. A service-unavailable recovery state would improve diagnosis. |
| Low | Invitation status is not persisted in the order list response. | Local acknowledgement disables repeat actions until navigation/remount; after remount the server's duplicate guard returns 409 and directs the admin to the action log. Exposing invitation status would improve clarity. |

## Verification and limits

- `npm test`: **49 passed**, including sign-out/session regression, RTC disconnect and stale SDK cancellation, role checks, idempotent billing, order/agent boundaries and WhatsApp connection tests.
- `npm run check` and `npm run build`: passed.
- Actual built React/Fastify application exercised in an isolated localhost fixture with synthetic users, in-memory database and blocked/mocked external providers. The helper is `data/design-ui-test.ts`; it is not part of the production server.
- Browser flows: personal/admin navigation, regular-user admin-route rejection, number search/confirmation/purchase, credit request, approval, chat search/summary, auto-reply acknowledgement, order save/search, sign-out, password visibility, signup validation and mobile keyboard navigation.
- Injected GET failures after successful POSTs for number purchase, credit request, credit decision and order creation; success remains visible with a separate refresh warning. Auto-reply fetch failure/retry and unknown order setup were also observed. Live order-action buttons stayed disabled in this fixture; their queue acknowledgement branch was source-reviewed and backend idempotency was unit-tested.
- Viewport checks at 390, 768, 1024 and 1440px for the overview, plus mobile orders/WhatsApp: no document/workspace horizontal overflow. See `artifacts/ui-redesign/viewport-checks.json`.
- Corrected text pairs exceed 4.5:1: placeholders 5.39:1, toolbar at least 5.13:1 against a conservative light surface, outgoing metadata 5.48:1. See `contrast-checks.json`. This is a targeted contrast check, not a full WCAG certification or assistive-technology audit.
- The Impeccable mechanical detector ran once; it returned an Instrument Serif saturation warning. The font was deliberately retained to honor the supplied serif reference. No blocking detector finding was returned.
- Captures under `artifacts/ui-redesign/` are synthetic QA evidence. Live Atlas writes, real Telnyx calls/purchases, real phone QR scanning, carrier delivery, Gemini quality and WhatsApp audio calling were not tested during this redesign. Existing customer records and `.env` were not changed.

Original frontend snapshots are retained under `data/ui-redesign-backup/20261113-231731/`. No deployment or commit was performed.
