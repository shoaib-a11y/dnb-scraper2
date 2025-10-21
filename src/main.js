// src/main.js
import { Actor, log } from 'apify';
import { PlaywrightCrawler } from '@crawlee/playwright';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
  startUrls = [
    // default to the directory page you sent
    { url: 'https://www.dnb.com/business-directory/company-information.automobile_dealers.us.html' },
  ],
  maxRequestsPerCrawl = 200,
  maxConcurrency = 5,
  maxRequestsPerMinute = 60,
} = input;

// ---------- helpers ----------
const pickText = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const pickHref = (el) => (el?.getAttribute('href') ?? '').trim();

/**
 * Extract a field that is rendered with a label like:
 *   <div>Website:</div><a href="...">www.site.com</a>
 *   <div>Address:</div><div>...</div>
 * We search the whole document for the label and then read the next sibling/link.
 */
function extractByLabel(document, labelStartsWith) {
  const nodes = Array.from(document.querySelectorAll('div,span,dt,strong,p,label'));
  const lab = nodes.find((n) => pickText(n).toLowerCase().startsWith(labelStartsWith));
  if (!lab) return null;

  // Prefer a direct anchor (for Website)
  const link = lab.parentElement?.querySelector('a[href^="http"]');
  if (link) {
    return { text: pickText(link), href: pickHref(link) };
  }

  // Otherwise read the next sibling text (for Address)
  const sib = lab.parentElement?.querySelector(':scope > *:not(:first-child)');
  if (sib) return { text: pickText(sib) };

  // Fallback: nextElementSibling in the DOM
  const next = lab.nextElementSibling;
  if (next) return { text: pickText(next) };

  return null;
}

// ---------- crawler ----------
const crawler = new PlaywrightCrawler({
  headless: true,
  maxConcurrency,
  maxRequestsPerMinute,
  maxRequestsPerCrawl,
  navigationTimeoutSecs: 45,
  requestHandlerTimeoutSecs: 90,

  async requestHandler({ request, page, enqueueLinks }) {
    const label = request.userData.label || 'LIST';
    log.debug(`Handling ${label}: ${request.url}`);

    if (label === 'LIST') {
      // Wait for list to render
      await page.waitForLoadState('domcontentloaded');

      // The list typically renders company names as anchors in the left column.
      // Grab links that go to company profiles. We keep it permissive but scoped to dnb.com.
      const companyLinks = await page.$$eval('a', (as) =>
        as
          .filter((a) =>
            a.href.includes('/business-directory/company-profiles') ||
            a.href.includes('/business-directory/company-information.')
          )
          .map((a) => ({ url: a.href }))
      );

      // Enqueue each detail page
      for (const l of companyLinks) {
        await enqueueLinks({
          urls: [l.url],
          userData: { label: 'DETAIL' },
          forefront: false,
        });
      }

      // Try to enqueue pagination if present
      const nextHref = await page.$$eval('a', (as) => {
        // Buttons often contain “Next”, chevron, or rel="next"
        const relNext = as.find((a) => a.rel === 'next');
        if (relNext) return relNext.href;
        const textNext = as.find((a) => /next/i.test(a.textContent || ''));
        return textNext?.href || null;
      });
      if (nextHref) {
        await enqueueLinks({
          urls: [nextHref],
          userData: { label: 'LIST' },
          forefront: false,
        });
      }

      // Also push a light log item for observability
      await Actor.pushData({
        pageType: 'LIST',
        url: request.url,
        foundCompanies: companyLinks.length,
        next: nextHref || null,
        scrapedAt: new Date().toISOString(),
      });

      return;
    }

    if (label === 'DETAIL') {
      await page.waitForLoadState('domcontentloaded');

      const result = await page.evaluate(() => {
        const get = (sel) => (document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();

        // Company name: try a few likely headers
        const name =
          get('h1') ||
          get('h1.company-name') ||
          get('h1[class*="company"]') ||
          get('[data-testid="company-name"]') ||
          '';

        // Labeled fields (public-only)
        const byWebsite = (function () {
          // try several label phrasings
          return (
            (window.__x = (() => {
              // try exact
              return null;
            })) || null
          );
        })();

        const websiteField =
          (function () {
            // Try label lookups
            const labels = ['website:', 'web site:'];
            for (const lab of labels) {
              const hit = (function extractByLabel(labelStartsWith) {
                const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
                const nodes = Array.from(document.querySelectorAll('div,span,dt,strong,p,label'));
                const labNode = nodes.find((n) => norm(n.textContent).toLowerCase().startsWith(labelStartsWith));
                if (!labNode) return null;
                const link = labNode.parentElement?.querySelector('a[href^="http"]');
                if (link) return { text: norm(link.textContent), href: link.getAttribute('href') };
                const sib = labNode.parentElement?.querySelector(':scope > *:not(:first-child)');
                if (sib) return { text: norm(sib.textContent) };
                const next = labNode.nextElementSibling;
                if (next) return { text: norm(next.textContent) };
                return null;
              })(lab);
              if (hit) return hit;
            }
            // Fallback: any visible http link in the right info column
            const rightCol = document.querySelector('[class*="sidebar"],[class*="summary"],[class*="info"]') || document;
            const link = rightCol.querySelector('a[href^="http"]:not([href*="dnb.com"])');
            if (link) return { text: link.textContent?.trim() || link.href, href: link.href };
            return null;
          })() || null;

        const addressField =
          (function () {
            const labels = ['address:', 'headquarters:', 'hq address:', 'location:'];
            const norm = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
            // Try labeled blocks first
            for (const lab of labels) {
              const nodes = Array.from(document.querySelectorAll('div,span,dt,strong,p,label'));
              const labNode = nodes.find((n) => norm(n.textContent).toLowerCase().startsWith(lab));
              if (labNode) {
                const sib = labNode.parentElement?.querySelector(':scope > *:not(:first-child)');
                if (sib) return norm(sib.textContent);
                const next = labNode.nextElementSibling;
                if (next) return norm(next.textContent);
              }
            }
            // Fallback: look for an Address icon block
            const blocks = Array.from(document.querySelectorAll('section,div'));
            const addrBlock = blocks.find((b) => /address/i.test(norm(b.textContent)));
            if (addrBlock) return norm(addrBlock.textContent);
            return '';
          })() || '';

        return {
          name,
          website: websiteField?.href || '',
          websiteLabel: websiteField?.text || '',
          address: addressField || '',
        };
      });

      // Keep only public info (some fields are locked on DNB; if empty, we leave them blank)
      const item = {
        url: request.url,
        name: result.name || null,
        website: result.website || null,
        websiteLabel: result.websiteLabel || null,
        address: result.address || null,
        scrapedAt: new Date().toISOString(),
      };

      await Actor.pushData(item);
      log.info(`Scraped: ${item.name || request.url}`);
      return;
    }
  },

  failedRequestHandler: async ({ request }) => {
    await Actor.pushData({ url: request.url, error: 'FAILED', when: new Date().toISOString() });
  },
});

// Seed with the directory page(s)
const sources = (startUrls || []).map((x) => (x.url ? x : { url: x, userData: {} }));
// Ensure the first requests are LIST pages
for (const s of sources) s.userData = { ...(s.userData || {}), label: 'LIST' };

await crawler.run(sources);
await Actor.exit();
