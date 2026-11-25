# Demo runbook (90–180 seconds)

Prepare a synthetic database and separate member, owner and viewer sessions. Start `npm.cmd run demo` and open http://127.0.0.1:3108/ui. Use the local tenant A member, a distinct tenant A owner and a tenant A viewer. Use seed identities privately and keep sign-in values out of recordings. For the foreign-order check, use a pre-staged synthetic order that exists only in tenant B. Stock seed order codes collide across tenants. With stock seed data alone, show the same order code under the two tenant sessions and use the linked browser test as evidence for the foreign-only case. [Windows setup](../LOCAL_SETUP_TR.md) · [Seed data](../../src/db/seed-data.ts)

| Time | Screen action and expected result |
|---|---|
| 0:00–0:20 | Sign in as the member. The browser hits the API login route and the API forwards to the auth process on loopback. Point out the no-send banner. |
| 0:20–0:45 | Enter a Turkish order-status request for seeded `ORD-1001` and select **Preview draft**. Compare classified intent and **Internal evidence** with the generic **Customer-safe draft**. Preview a low-stock request such as `Check low stock` if time allows, then return to the order preview. |
| 0:45–1:10 | Click **Send to human review**. Save the Turkish edit "Ekibimiz talebinizi inceleyecek." and show the edited version 2 with Language: tr. Press **Approve (internal only)** as the same actor and show refusal. |
| 1:10–1:40 | Sign out and sign in as the second actor, the owner. Open the queued review and approve it. Show `approved_internal`, revision/version and the event history. Nothing is ever sent. |
| 1:40–2:20 | Show a viewer session denied access to reviews. The browser suite checks the real API 403 on all six review operations. As an eligible tenant A operator, preview the foreign-order code and show missing evidence with no foreign details. |
| 2:20–2:40 | Return to the owner's approved review for the final screen. Point to the no-send banner and internal decision history. State that the workflow is deterministic rules and mocks. |

For a 90-second recording, pre-stage the three sessions, preview just the order and keep the boundary screens brief.

The classifier detects Turkish ASCII order words such as `siparisim` and `kargom`; Turkish policy drafts fall back to a Turkish acknowledgement. Operator edits remain human-authored free text and undergo disclosure checks. [Browser flow](../../test/e2e/operator-flow.test.ts) · [Captures](screenshots/README.md)
