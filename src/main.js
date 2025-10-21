import { Actor, log } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration } from '@crawlee/playwright';

await Actor.init();
const input = (await Actor.getInput()) || {};

const {
  startUrls = [{ url: 'https://www.dnb.com/business-directory/company-information.automobile_dealers.us.html' }],
  maxRequestsPerCrawl = 200,
  maxConcurrency = 2,
  maxRequestsPerMinute = 24,
  useProxy = true,                 // <— turn on
  proxyGroups = [],                // e.g. ["RESIDENTIAL"] or your assigned groups
} = input;

const proxyConfiguration = useProxy
  ? await Actor.createProxyConfiguration({ groups: proxyGroups }) // uses your Apify proxy
  : new ProxyConfiguration({ useApifyProxy: false });

const crawler = new PlaywrightCrawler({
  headless: true,
  maxConcurrency,
  maxRequestsPerMinute,
  maxRequestsPerCrawl,
  proxyConfiguration,

  // keep identities + cookies
  useSessionPool: true,
  sessionPoolOptions: {
    maxPoolSize: 30,
    sessionOptions: { maxUsageCount: 30 }, // rotate after some usage
  },
  persistCookiesPerSession: true,

  navigationTimeoutSecs: 45,
  requestHandlerTimeoutSecs: 90,

  // Dress up like a normal browser and slow down a bit
  preNavigationHooks: [async ({ page, session }, goToOptions) => {
    goToOptions.waitUntil = 'domcontentloaded';
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1',
    });
    await page.addInitScript(() => {
      // minimal stealth: timezone/notifications reduce fingerprint weirdness
      Object.defineProperty(Notification, 'permission', { get: () => 'default' });
    });
    // random human-ish delay before first interaction
    await page.waitForTimeout(800 + Math.floor(Math.random() * 600));
  }],

  // If DNB returns 403, mark this session as bad and retry with a new one
  errorHandler: async ({ request, error, session, log }) => {
    if (String(error?.message || '').includes('403')) {
      session?.retire();
      log.warning(`403 on ${request.url} → retiring session and retrying.`);
    }
  },

  async requestHandler({ request, page, enqueueLinks, log }) {
    // 1) Extract name + URL from the list
    await page.waitForLoadState('domcontentloaded');

    // quick 403 guard (some sites send 200 with a block page—skip those)
    const status = page.response()?.status();
    if (status === 403) throw new Error('403');

    const items = await page.$$eval('#companyResults a.companyName, #companyResults > div > div.col-md-6 > a', (links) => {
      const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
      return links
        .filter((a) => a.getAttribute('href'))
        .map((a) => ({
          name: norm(a.textContent),
          href: new URL(a.getAttribute('href'), location.href).toString(),
        }));
    });

    for (const it of items) {
      await Actor.pushData({
        name: it.name || null,
        url: it.href,
        sourceList: request.url,
        scrapedAt: new Date().toISOString(),
      });
    }
    log.info(`Found ${items.length} companies on ${request.url}`);

    // 2) Paginate via “Next” (div.next.font-16)
    const nextBtn = await page.$('div.next.font-16');
    if (nextBtn) {
      const prev = page.url();
      await Promise.allSettled([
        page.waitForLoadState('domcontentloaded', { timeout: 8000 }),
        nextBtn.click({ delay: 80 }),
      ]);
      const newUrl = page.url();
      if (newUrl !== prev) {
        await enqueueLinks({ urls: [newUrl] });
        log.info(`Enqueued next page: ${newUrl}`);
      } else {
        log.info('Next present but did not navigate (maybe last page).');
      }
    }

    // politeness jitter
    await page.waitForTimeout(400 + Math.floor(Math.random() * 600));
  },

  failedRequestHandler: async ({ request }) => {
    await Actor.pushData({ error: 'FAILED', url: request.url, scrapedAt: new Date().toISOString() });
  },
});

// seed
const sources = (startUrls || []).map((x) => (x.url ? x : { url: x }));
await crawler.run(sources);
await Actor.exit();
