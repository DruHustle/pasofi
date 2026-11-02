# PamoFi web frontend

This folder is the independent React/Vite web app. Node.js 22 or newer is required.

```sh
npm ci
npm test
npm run build
npm run dev -- --host 127.0.0.1
```

The development server proxies API requests to the locally running backend services. The checkout is explicitly simulated, and this app cannot yet take real payments or connect customers to Wi-Fi. The current Vercel deployment is a demo without a configured backend.

To run browser journeys, start the backend demo and the web development server, then run `PAMOFI_CHROME_PATH=/path/to/chrome npm run test:browser`. Vercel can build this folder as a standalone project.

## Local API and browser checks

The web app uses same-origin `/api/` calls. Vite forwards only the supported customer routes to separate services; credentials stay in HttpOnly cookies. For an isolated run, set server-only `PAMOFI_IDENTITY_URL`, `PAMOFI_PREPAID_URL`, and `PAMOFI_ASSISTANT_URL` as needed. Their defaults are `http://localhost:18081`, `http://localhost:18082`, and `http://localhost:18085`. The backend `PUBLIC_ORIGIN` must match the browser's exact origin, including its port. These settings do not configure Vercel production routing.

```sh
PAMOFI_IDENTITY_URL=http://localhost:28181 npm run dev -- --host 127.0.0.1 --port 5178 --strictPort
PAMOFI_BASE_URL=http://localhost:5178 PAMOFI_CHROME_PATH=/path/to/chrome npm run test:browser
```

The browser suite contains real local-service purchase, recovery and sign-out journeys plus mocked faults for response loss, cookie rejection, stale sessions, pagination, and unavailable catalogue/help. Reports and screenshots use Playwright's ignored `test-results` directory. The real journeys need the disposable demo database; never point them at production. `npm test` checks TypeScript and does not run the browser suite.

A pending demo order keeps its idempotency key in tab-scoped storage so closing the panel or reloading cannot silently start another order after a lost response. Recovery keys remain in component memory only. The UI verifies the recovered cookie before reporting success, clears a previous key before rotation, and clears account views across supported tabs after sign-out or account changes. Help search filters reviewed FAQs locally and does not transmit the search phrase to a model or support service.

The Nginx image includes customer API routes for local infrastructure using the Docker service names. It needs the same private backend network and a matching `PUBLIC_ORIGIN`; internal service routes remain unexposed. Unrecognized `/api/` paths return JSON 404 instead of the frontend HTML.
