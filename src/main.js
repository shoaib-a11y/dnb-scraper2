async requestHandler({ request, page, enqueueLinks, log, session }) {
  // LIST PAGE
  await page.waitForLoadState('domcontentloaded');

  // Heuristic: if the page shows a generic block page, bail so errorHandler can retire session.
  const isBlocked = await page.evaluate(() => {
    const txt = (document.body?.innerText || '').toLowerCase();
    return /access denied|forbidden|blocked|just a moment|verify you are a human/i.test(txt);
  });
  if (isBlocked) throw new Error('BLOCK_PAGE');

  // 1) Collect company anchors on this page
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

  // 2) Paginate via “Next” (div.next.font-16)
  const nextBtn = await page.$('div.next.font-16');
  if (nextBtn) {
    const prev = page.url();
    await Promise.allSettled([
      page.waitForLoadState('domcontentloaded', { timeout: 10000 }),
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

  // polite jitter
  await page.waitForTimeout(400 + Math.floor(Math.random() * 600));
}
