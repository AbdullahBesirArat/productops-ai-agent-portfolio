# Screenshot gallery

Real Chrome captures of the local app using synthetic data only. They are produced by the browser test ([source](../../../test/e2e/operator-flow.test.ts)); set `PRODUCTOPS_E2E_SCREENSHOTS=1` before `npm run test:e2e` to regenerate them. Each image was reviewed for personal data, credentials, tokens, local paths and browser profile information; none were found.

| PNG | Screen |
|---|---|
| [01-desktop-login.png](01-desktop-login.png) | Desktop sign-in before credentials are entered |
| [02-desktop-dashboard.png](02-desktop-dashboard.png) | Signed-in review desk |
| [03-classification-preview.png](03-classification-preview.png) | Classification output panel |
| [04-internal-vs-customer-safe.png](04-internal-vs-customer-safe.png) | Internal evidence and customer-safe draft |
| [05-review-workflow.png](05-review-workflow.png) | Review detail after edit (state `edited`, version 2) |
| [06-mobile-view.png](06-mobile-view.png) | Review desk at 375 px width |
