# Repository structure

```
├── apify.json
├── package.json
├── README.md
├── Dockerfile
├── INPUT_SCHEMA.json
├── src
│   ├── main.js
│   ├── firebase.js
│   └── utils.js
├── .env.example
└── .gitignore
```
```
# apify.json
{
  "name": "dnb-scraper-firebase",
  "version": "0.1.0",
  "buildTag": "latest",
  "env": {
    "APIFY_HEADLESS": "1"
  }
}
```

```
# package.json
{
  "name": "dnb-scraper-firebase",
  "version": "0.1.0",
  "type": "module",
  "description": "Apify actor that scrapes D&B-like company pages and optionally syncs to Firebase/Firestore.",
  "scripts": {
    "start": "node ./src/main.js",
    "local": "APIFY_LOCAL_STORAGE_DIR=./storage node ./src/main.js"
  },
  "dependencies": {
    "apify": "^3.0.2",
    "@crawlee/playwright": "^3.8.1",
    "@apify/timeout": "^0.3.0",
    "playwright": "^1.47.2",
    "firebase-admin": "^12.6.0",
    "zod": "^3.23.8"
  }
}
```

```
# Dockerfile
FROM apify/actor-node-playwright:20

# Copy files
COPY package*.json ./
RUN npm ci --omit=dev

COPY . ./

# Required by Apify platform
CMD [ "npm", "start" ]
```

```
# INPUT_SCHEMA.json
{
  "title": "DNB Scraper (Firebase optional)",
  "type": "object",
  "schemaVersion": 1,
  "properties": {
    "startUrls": {
      "title": "Start URLs",
      "type": "array",
      "description": "Company profile page URLs to scrape (public, no login).",
      "editor": "requestListSources"
    },
    "maxRequestsPerCrawl": {
      "title": "Max requests",
      "type": "integer",
      "default": 50
    },
    "maxConcurrency": {
      "title": "Max concurrency",
      "type": "integer",
      "default": 5
    },
    "maxRequestsPerMinute": {
      "title": "Throttle (requests/min)",
      "type": "integer",
      "default": 60
    },
    "useProxy": {
      "title": "Use Apify Proxy",
      "type": "boolean",
      "default": false
    },
    "proxyGroups": {
      "title": "Proxy groups",
      "type": "array",
      "description": "Optional Apify proxy groups.",
      "editor": "stringList"
    },
    "selectors": {
      "title": "CSS Selectors",
      "type": "object",
      "description": "Customize selectors for company fields.",
      "properties": {
        "name": { "type": "string", "default": "h1.company-name" },
        "address": { "type": "string", "default": "p.company-address" },
        "phone": { "type": "string", "default": "a.company-phone" },
        "website": { "type": "string", "default": "a.company-website" },
        "industry": { "type": "string", "default": "span.company-industry" }
      }
    },
    "firebaseEnabled": {
      "title": "Enable Firebase sync",
      "type": "boolean",
      "default": false
    },
    "firebaseCollection": {
      "title": "Firestore collection",
      "type": "string",
      "default": "companies"
    },
    "login": {
      "title": "(Optional) Login flow — only use with permission",
      "type": "object",
      "properties": {
        "enabled": { "type": "boolean", "default": false },
        "loginUrl": { "type": "string" },
        "username": { "type": "string" },
        "password": { "type": "string" },
        "usernameSelector": { "type": "string", "default": "input[name=email]" },
        "passwordSelector": { "type": "string", "default": "input[type=password]" },
        "submitSelector": { "type": "string", "default": "button[type=submit]" }
      }
    }
  },
  "required": ["startUrls"]
}
```

```
# .env.example
# Set only when running locally. In Apify, use Actor > Secrets.
FIREBASE_SERVICE_ACCOUNT_BASE64=
FIREBASE_COLLECTION=companies
```

```
# .gitignore
node_modules
storage
.apify_storage
.env
```

```
// src/utils.js
import crypto from 'node:crypto';

export const stableIdFrom = (url) =>
  crypto.createHash('sha1').update(url).digest('hex');

export const cleanText = (s) => (s || '').replace(/\s+/g, ' ').trim();
```

```
// src/firebase.js
import admin from 'firebase-admin';

let appInitialized = false;

export function initFirebase() {
  if (appInitialized) return admin.firestore();

  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!base64) throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 not set');
  const json = Buffer.from(base64, 'base64').toString('utf8');
  const creds = JSON.parse(json);

  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(creds),
    });
  }
  appInitialized = true;
  return admin.firestore();
}
```

```
// src/main.js
import { Actor, log } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration } from '@crawlee/playwright';
import { initFirebase } from './firebase.js';
import { stableIdFrom, cleanText } from './utils.js';

await Actor.init();

const input = await Actor.getInput();
const {
  startUrls = [],
  maxRequestsPerCrawl = 50,
  maxConcurrency = 5,
  maxRequestsPerMinute = 60,
  useProxy = false,
  proxyGroups = [],
  selectors = {},
  firebaseEnabled = false,
  firebaseCollection = 'companies',
  login = { enabled: false },
} = input || {};

let db = null;
if (firebaseEnabled) {
  try {
    db = initFirebase();
    log.info('Firebase initialized ✔');
  } catch (err) {
    log.exception(err, 'Firebase init failed');
    process.exitCode = 1;
  }
}

const proxyConfiguration = useProxy
  ? await Actor.createProxyConfiguration({ groups: proxyGroups })
  : new ProxyConfiguration({ useApifyProxy: false });

const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  headless: true,
  maxRequestsPerCrawl,
  maxConcurrency,
  maxRequestsPerMinute,
  navigationTimeoutSecs: 45,
  requestHandlerTimeoutSecs: 90,
  preNavigationHooks: [async ({ request, page }, goToOptions) => {
    goToOptions.waitUntil = 'domcontentloaded';
    // Attach default headers to be nice
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  }],
  failedRequestHandler: async ({ request, log }) => {
    log.error(`Request failed ${request.url}`);
    await Actor.pushData({ url: request.url, error: 'FAILED' });
  },
  requestHandler: async ({ request, page, enqueueLinks, log }) => {
    // If a login flow is provided (and permitted), handle it on first page only
    if (login?.enabled && request.userData.isLoginStep) {
      log.info('Running login flow');
      await page.goto(login.loginUrl, { waitUntil: 'domcontentloaded' });
      await page.fill(login.usernameSelector, login.username);
      await page.fill(login.passwordSelector, login.password);
      await page.click(login.submitSelector);
      await page.waitForLoadState('domcontentloaded');
      return; // continue to next queued requests (which share cookies)
    }

    await page.waitForLoadState('domcontentloaded');

    const sel = {
      name: selectors.name || 'h1.company-name',
      address: selectors.address || 'p.company-address',
      phone: selectors.phone || 'a.company-phone',
      website: selectors.website || 'a.company-website',
      industry: selectors.industry || 'span.company-industry',
    };

    const result = await page.evaluate((sel) => {
      const pick = (css) => (document.querySelector(css)?.textContent || '').trim();
      const pickHref = (css) => (document.querySelector(css)?.href || '').trim();
      return {
        name: pick(sel.name),
        address: pick(sel.address),
        phone: pick(sel.phone),
        website: pickHref(sel.website),
        industry: pick(sel.industry),
      };
    }, sel);

    const data = {
      id: stableIdFrom(request.url),
      url: request.url,
      name: cleanText(result.name),
      address: cleanText(result.address),
      phone: cleanText(result.phone),
      website: cleanText(result.website),
      industry: cleanText(result.industry),
      scrapedAt: new Date().toISOString(),
    };

    // Save to Apify dataset (always)
    await Actor.pushData(data);

    // Optional: upsert into Firestore
    if (firebaseEnabled && db) {
      try {
        const col = process.env.FIREBASE_COLLECTION || firebaseCollection;
        await db.collection(col).doc(data.id).set(data, { merge: true });
        log.info(`Firestore upsert ✔ ${data.name || data.url}`);
      } catch (err) {
        log.exception(err, 'Firestore write failed');
      }
    }

    // Enqueue detail links if you want to crawl deeper (disabled by default)
    // await enqueueLinks({ selector: 'a[href*="/company/"]' });
  },
});

// Build initial RequestList
const sources = [];
for (const src of startUrls) sources.push(src);

// Optionally add a login step (only if permitted and required)
if (login?.enabled && login?.loginUrl) {
  sources.unshift({ url: login.loginUrl, userData: { isLoginStep: true } });
}

await crawler.run(sources);

await Actor.exit();
```

```
# README.md
# DNB-like Company Scraper (Apify Actor) with optional Firebase sync

> ⚠️ **Compliance first**: Respect each site's Terms of Service, robots.txt, and applicable laws. For Dun & Bradstreet specifically, pages are often gated or license-restricted. Prefer official APIs where available and only scrape content you have rights to access.

This actor uses **PlaywrightCrawler (Crawlee)** to extract company fields from public, static pages using configurable CSS selectors. Results always go to the Apify dataset and can optionally be upserted into **Firestore**.

## Features
- Playwright rendering (handles client-side HTML)
- Throttling via `maxRequestsPerMinute`
- Optional Apify Proxy
- Configurable selectors for name/address/phone/website/industry
- Optional login step (only when permitted)
- Firestore upsert with deterministic IDs (SHA1 of URL)

## Quick start (local)
```bash
npm i
cp .env.example .env
# Put your base64 service account JSON into FIREBASE_SERVICE_ACCOUNT_BASE64 (optional)

# Run with local storage
npm run local
```

Create an input JSON (e.g. `apify_storage/key_value_stores/default/INPUT.json`):
```json
{
  "startUrls": [
    { "url": "https://example.com/dnb-company-page-1" },
    { "url": "https://example.com/dnb-company-page-2" }
  ],
  "selectors": {
    "name": "h1.company-name",
    "address": "p.company-address",
    "phone": "a.company-phone",
    "website": "a.company-website",
    "industry": "span.company-industry"
  },
  "firebaseEnabled": true,
  "firebaseCollection": "companies"
}
```

## Deploy on Apify
- Push this repo to GitHub.
- In Apify Console: *Actors → Create new → Git repo* → connect.
- Set secrets (if using Firebase):
  - `FIREBASE_SERVICE_ACCOUNT_BASE64` (base64 of the Service Account JSON)
  - optional `FIREBASE_COLLECTION` (default `companies`)

## Input fields
- `startUrls` — array of objects `{ url }` to crawl
- `maxRequestsPerCrawl`, `maxConcurrency`, `maxRequestsPerMinute` — scale & throttle
- `useProxy`, `proxyGroups` — Apify proxy config
- `selectors` — CSS map for fields
- `firebaseEnabled`, `firebaseCollection` — Firestore sync
- `login` — optional login flow (only use if permitted by ToS)

## Output
- **Dataset** (default) — each item has `{ id, url, name, address, phone, website, industry, scrapedAt }`
- **Firestore** (optional) — upserted documents with the same fields

## Firebase setup (optional)
1. Create a Service Account with Firestore access.
2. Download the JSON key and base64-encode it:
   ```bash
   base64 -w 0 service-account.json > sa.b64
   ```
3. Put that string into Apify secret `FIREBASE_SERVICE_ACCOUNT_BASE64` (or local `.env`).

## Notes on D&B
- D&B content is often **paywalled** or governed by license. This actor intentionally expects **public pages** with CSS selectors you supply. If you need official D&B data, contact D&B for API access.
- Implement conservative throttling and consider adding `robots.txt` checks if required.

## Extending
- Add more fields under `selectors` and extract them in `page.evaluate`.
- Switch to `CheerioCrawler` if the target is fully static.
- Add retry/backoff policies, captcha handling, or queueing from sitemaps.

## License
MIT
