# PamoFi frontend

Run `npm ci && npm test && npm run build`. `npm run dev` serves the UI with API proxies to prepaid-access on port 18082 and assistant on port 18085. The UI is an explicitly labelled initial demonstration, not a functional purchase or hotspot portal.

Vercel can build this folder as a separate project. A standalone preview displays an unavailable state until an API origin is configured; no production routing or backend is configured yet. Do not claim the preview supports purchases or connects customers.

The local demo supports a simulated purchase and queued access view. Run `npm run test:browser` with `PAMOFI_CHROME_PATH` set to a compatible Chrome executable and the local services running. Never use the mock workflow for customers.
