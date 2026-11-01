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
