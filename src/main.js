// src/main.js
import { Actor, log } from 'apify';
import { CheerioCrawler, ProxyConfiguration } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
  // Make sure this is the continental US page
  startUrls = [
    { url: 'https://www.dnb.com/business-directory/company-information.automobile_dealers.us.html' }
  ],

  maxRequestsPerCrawl = 500,
  maxConcurrency = 2,
  maxRequestsPerMinute = 20,

  // Proxy + Geo (forces US IP to avoid redirection to USVI)
  useProxy = true,
  proxyGroups = ['RESIDENTIAL'],  // or your assigned groups; if none, omit
  proxyCountryCode = 'US',
} = input;

// Proxy config
const proxyConfiguration = useProxy
  ? await Actor.createProxyConfiguration({ groups: proxyGroups, countryCode: proxyCountryCode })
  : new ProxyConfiguration({ useApifyProxy: false });

// Helper: normalize whitespace
const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

const crawler = new CheerioCrawler({
  proxyConfiguration,
  maxConcurrency,
  requestHandlerTimeoutSecs: 60,
  maxRequestsPerMinute,
  maxRequestsPerCrawl,

  // Force HTTP/1.1 (avoids HTTP/2 protocol issues)
  // and generate realistic headers automatically.
  // Crawlee passes these through got-scraping under the hood.
  requestOptions: {
    http2: false,
    headers: {
      'accept-language': 'en-US,en;q=0.9',
      'upgrade-insecure-requests': '1',
    },
    // Use a realistic desktop UA; header generator will add sec-ch-ua etc.
    headerGeneratorOptions: {
      browsers: [{ name: 'chrome', minVersion: 114 }],
      devices: ['desktop'],
      locales: ['en-US'],
      operatingSystems: ['windows', 'linux'],
    },
    timeout: { request: 25000 },
  },

  async requestHandler({ request, $, enqueueLinks }) {
    // Quick block-page heuristic (CDNs sometimes serve a 200 with a block challenge)
    const bodyText = $('body').text().toLowerCase();
    if (/(access denied|forbidden|blocked|verify you are a human|just a moment)/i.test(bodyText)) {
      throw new Error('BLOCK_PAGE');
    }

    // 1) Collect company anchors
    // Your selector: #companyResults > div:nth-child(2) > div.col-md-6 > a
    // Safer: any anchor with class companyName inside #companyResults
    const items = [];
    $('#companyResults a.companyName, #companyResults > div > div.col-md-6 > a').each((_, el) => {
      const name = norm($(el).text());
      const href = $(el).attr('href');
      if (!href) return;
      const abs = new URL(href, request.url).toString();
      items.push({ name, url: abs });
    });

    if (!items.length) {
      // Save a small debug snippet to KV store to inspect markup quickly
      await Actor.setValue(`DEBUG_${Date.now()}`, {
        url: request.url,
        snippet: norm($('body').html() || '').slice(0, 5000),
      });
      log.warning(`No items found on ${request.url} — stored DEBUG_... in KV store (first 5k chars).`);
    }

    for (const it of items) {
      await Actor.pushData({
        name: it.name || null,
        url: it.url,
        sourceList: request.url,
        scrapedAt: new Date().toISOString(),
      });
    }
    log.info(`Found ${items.length} companies on ${request.url}`);

    // 2) Pagination — prefer a real link with text "Next"
    let nextHref = null;

    // a) Try an actual <a> that says "Next"
    const nextA = $('a').filter((_, a) => /next/i.test($(a).text()));
    if (nextA.length) {
      nextHref = nextA.first().attr('href');
    }

    // b) If they use <div class="next font-16">Next</div>, look for its closest <a>
    if (!nextHref) {
      const nextDiv = $('div.next.font-16:contains("Next")').first();
      if (nextDiv.length) {
        const parentA = nextDiv.closest('a');
        if (parentA.length) nextHref = parentA.attr('href');
      }
    }

    // c) If neither is present, try rel=next
    if (!nextHref) {
      const relNext = $('a[rel="next"]').attr('href');
      if (relNext) nextHref = relNext;
    }

    if (nextHref) {
      const absNext = new URL(nextHref, request.url).toString();
      await enqueueLinks({ urls: [absNext] });
      log.info(`Enqueued next page: ${absNext}`);
    }
  },

  errorHandler: async ({ request, error, session, log }) => {
    const msg = String(error?.message || '').toLowerCase();
    if (msg.includes('block_page') || msg.includes('403')) {
      session?.retire?.();
      log.warning(`Blocked on ${request.url}; retired session to retry with a new identity.`);
    }
  },

  failedRequestHandler: async ({ request }) => {
    await Actor.pushData({ error: 'FAILED', url: request.url, when: new Date().toISOString() });
  },
});

// Seed
const sources = (startUrls || []).map((x) => (x.url ? x : { url: x }));
await crawler.run(sources);
await Actor.exit();
