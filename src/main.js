import { Actor, log } from 'apify';
import { PlaywrightCrawler } from '@crawlee/playwright';

await Actor.init();

const input = await Actor.getInput() || {};
const {
  startUrls = [],
  maxRequestsPerCrawl = 50,
  maxConcurrency = 5,
  maxRequestsPerMinute = 60,
  selectors = {},
} = input;

const sel = {
  name: selectors.name || 'h1.company-name',
  address: selectors.address || 'p.company-address',
  phone: selectors.phone || 'a.company-phone',
  website: selectors.website || 'a.company-website',
  industry: selectors.industry || 'span.company-industry',
};

const crawler = new PlaywrightCrawler({
  headless: true,
  maxRequestsPerCrawl,
  maxConcurrency,
  maxRequestsPerMinute,
  requestHandler: async ({ request, page }) => {
    await page.waitForLoadState('domcontentloaded');
    const result = await page.evaluate((s) => {
      const pick = (css) => (document.querySelector(css)?.textContent || '').trim();
      const pickHref = (css) => (document.querySelector(css)?.href || '').trim();
      return {
        name: pick(s.name),
        address: pick(s.address),
        phone: pick(s.phone),
        website: pickHref(s.website),
        industry: pick(s.industry),
      };
    }, sel);

    const data = { url: request.url, ...result, scrapedAt: new Date().toISOString() };
    await Actor.pushData(data);
    log.info(`Scraped: ${request.url}`);
  },
  failedRequestHandler: async ({ request }) => {
    await Actor.pushData({ url: request.url, error: 'FAILED' });
  },
});

const sources = (startUrls || []).map((x) => (x.url ? x : { url: x }));
await crawler.run(sources);

await Actor.exit();
