// src/main.js
import { Actor, log } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration } from '@crawlee/playwright';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
  startUrls = [
    { url: 'https://www.dnb.com/business-directory/company-information.automobile_dealers.us.html' },
  ],
  maxRequestsPerCrawl = 200,
  maxConcurrency = 2,
  maxRequestsPerMinute = 24,
  useProxy = true,          // set to false if you don't have Apify proxy
  proxyGroups = [],         // e.g., ["RESIDENTIAL"] if available to your account
} = input;

// Proxy config
const proxyConfiguration = useProxy
  ? await Actor.createProxyConfiguration({ groups: proxyGroups })
  : new ProxyConfiguration({ useApifyProxy: false });

const crawler = new PlaywrightCrawler({
  headless: true,
  maxConcurrency,
  maxRequestsPerMinute,
  maxRequestsPerCrawl,
  proxyConfiguration,

  // Sessions + cookies to reduce blocking
  useSessionPool: true,
  sessionPoolOptions: {
    maxPoolSize: 30,
    sessionOptions: { maxUsageCount: 30 },
  },
  persistCookiesPerSession: true,

  navigationTimeoutSecs: 45,
  requestHandlerTimeoutSecs: 90,

  preNavigationHooks: [async ({ page }, goToOptions) => {
    goToOptions.waitUntil = 'domcontentloaded';
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1',
    });
    // small human-ish pause
    await page.waitForTimeout(800 + Math.floor(Math.random() * 600));
  }],

  // retire session on block
  errorHandler: async ({ request, error, session }) => {
    const msg = String(error?.message || '').toLowerCase();
    if (msg.includes('403') || msg.includes('block_page')) {
      session?.retire();
      log.warning(`Blocked on ${request.url} → retiring session and retrying.`);
    }
  },

  // === YOUR LIST SCRAPER ===
  async requestHandler({ request, page, enqueueLinks }) {
    await page.waitForLoadState('domcontentloaded');

    // Heuristic for block pages (some sites serve 200 with block HTML)
    const blocked = await page.evaluate(() => {
      const txt = (document.body?.innerText || '').toLowerCase();
      return /access denied|forbidden|blocked|verify you are a human|just a moment/.test(txt);
    });
    if (blocked) throw new Error('BLOCK_PAGE');

    // Collect company anchors (name + href)
    const items = await page.$$eval(
      '#companyResults a.companyName, #companyResults > div > div.col-md-6 > a',
      (links) => {
        const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
        return links
          .filter((a) => a.getAttribute('href'))
          .map((a) => ({
            name: norm(a.textContent),
            href: new URL(a.getAttribute('href'), location.href).toString(),
          }));
      }
    );

    for (const it of items) {
      await Actor.pushData({
        name: it.name || null,
        url: it.href,
        sourceList: request.url,
        scrapedAt: new Date().toISOString(),
      });
    }
    log.info(`Found ${items.length} companies on ${request.url}`);

    // Paginate via “Next” (div.next.font-16)
    const nextBtn = await page.$('div.next.font-16');
    if (nextBtn) {
      const prevUrl = page.url();
      await Promise.allSettled([
        page.waitForLoadState('domcontentloaded', { timeout: 10000 }),
        nextBtn.click({ delay: 100 }),
      ]);
      const newUrl = page.url();
      if (newUrl !== prevUrl) {
        await enqueueLinks({ urls: [newUrl] });
        log.info(`Enqueued next page: ${newUrl}`);
      } else {
        log.info('Next present but did not navigate (likely last page).');
      }
    }

    // polite jitter
    await page.waitForTimeout(400 + Math.floor(Math.random() * 600));
  },

  failedRequestHandler: async ({ request }) => {
    await Actor.pushData({
      error: 'FAILED',
      url: request.url,
      scrapedAt: new Date().toISOString(),
    });
  },
});

// Seed and run
const sources = (startUrls || []).map((x) => (x.url ? x : { url: x }));
await crawler.run(sources);

await Actor.exit();
