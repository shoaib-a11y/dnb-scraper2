import { Actor, log } from 'apify';
import { PlaywrightCrawler } from '@crawlee/playwright';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
  startUrls = [
    { url: 'https://www.dnb.com/business-directory/company-information.automobile_dealers.us.html' },
  ],
  maxRequestsPerCrawl = 200,
  maxConcurrency = 3,
  maxRequestsPerMinute = 40,
} = input;

const crawler = new PlaywrightCrawler({
  headless: true,
  maxConcurrency,
  maxRequestsPerMinute,
  maxRequestsPerCrawl,
  navigationTimeoutSecs: 45,
  requestHandlerTimeoutSecs: 90,

  async requestHandler({ request, page, enqueueLinks }) {
    // LIST PAGE
    await page.waitForLoadState('domcontentloaded');

    // 1) Collect company anchors on this page
    const items = await page.$$eval('#companyResults a.companyName, #companyResults > div > div.col-md-6 > a', (links) => {
      const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
      return links
        .filter((a) => a.getAttribute('href'))
        .map((a) => ({
          name: norm(a.textContent),
          href: a.getAttribute('href'),
        }));
    });

    // Normalize to absolute URLs and push
    for (const it of items) {
      const url = new URL(it.href, document.location.href).toString();
      await Actor.pushData({
        name: it.name || null,
        url,
        sourceList: request.url,
        scrapedAt: new Date().toISOString(),
      });
    }

    log.info(`Found ${items.length} companies on ${request.url}`);

    // 2) Paginate: try to click the “Next” div; if it navigates, enqueue the new URL
    const nextExists = await page.$('div.next.font-16');
    if (nextExists) {
      const prevUrl = page.url();
      const [nav] = await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 7000 }).catch(() => null),
        page.click('div.next.font-16').catch(() => null),
      ]);

      // If URL changed, enqueue the new page as another LIST
      const newUrl = page.url();
      if (nav && newUrl !== prevUrl) {
        await enqueueLinks({
          urls: [newUrl],
          userData: { label: 'LIST' },
        });
        log.info(`Enqueued next page: ${newUrl}`);
      } else {
        log.info('Next button present but did not navigate (maybe last page).');
      }
    }
  },

  failedRequestHandler: async ({ request }) => {
    await Actor.pushData({ error: 'FAILED', url: request.url, scrapedAt: new Date().toISOString() });
  },
});

// Seed
const sources = (startUrls || []).map((x) => (x.url ? x : { url: x }));
await crawler.run(sources);

await Actor.exit();
