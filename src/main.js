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
  maxRequestsPerMinute = 20,

  // ✳️ Force US geo so you don't get redirected to U.S. Virgin Islands
  useProxy = true,
  proxyGroups = ['RESIDENTIAL'],    // if you have this; otherwise omit
  proxyCountryCode = 'US',          // 👈 important
} = input;

const proxyConfiguration = useProxy
  ? await Actor.createProxyConfiguration({
      groups: proxyGroups,
      countryCode: proxyCountryCode,  // 👈 force US IP
    })
  : new ProxyConfiguration({ useApifyProxy: false });

const crawler = new PlaywrightCrawler({
  headless: true,
  maxConcurrency,
  maxRequestsPerMinute,
  maxRequestsPerCrawl,
  proxyConfiguration,

  useSessionPool: true,
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
  }],

  errorHandler: async ({ request, error, session }) => {
    const msg = String(error?.message || '').toLowerCase();
    if (msg.includes('403') || msg.includes('block_page')) {
      session?.retire();
      log.warning(`Blocked on ${request.url} → retiring session and retrying.`);
    }
  },

  async requestHandler({ request, page, enqueueLinks }) {
    await page.waitForLoadState('domcontentloaded');

    // ✳️ Handle cookie banners so the list becomes visible
    try {
      const btn = await page.$('button:has-text("Accept") , button:has-text("I agree"), #onetrust-accept-btn-handler');
      if (btn) await btn.click({ delay: 60 });
    } catch {}

    // ✳️ Nudge lazy loads
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(500);
    }

    // ✳️ Wait specifically for the list container or anchor to show
    await Promise.race([
      page.waitForSelector('#companyResults a.companyName', { timeout: 12000 }),
      page.waitForSelector('#companyResults > div > div.col-md-6 > a', { timeout: 12000 }),
    ]).catch(() => null);

    // Heuristic for block pages
    const blocked = await page.evaluate(() => {
      const txt = (document.body?.innerText || '').toLowerCase();
      return /access denied|forbidden|blocked|verify you are a human|just a moment/.test(txt);
    });
    if (blocked) throw new Error('BLOCK_PAGE');

    // ✅ Grab name + absolute URL
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

    // 🔎 Debug snapshot if nothing found
    if (!items.length) {
      const html = await page.content();
      await Actor.setValue(`DEBUG_${Date.now()}`, { url: page.url(), htmlSnippet: html.slice(0, 5000) }, { contentType: 'application/json; charset=utf-8' });
      log.warning(`No items found on ${page.url()} — saved DEBUG snapshot in KV store.`);
    }

    for (const it of items) {
      await Actor.pushData({
        name: it.name || null,
        url: it.href,
        sourceList: request.url,
        scrapedAt: new Date().toISOString(),
      });
    }
    log.info(`Found ${items.length} companies on ${request.url}`);

    // ➡️ Paginate via “Next”
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
