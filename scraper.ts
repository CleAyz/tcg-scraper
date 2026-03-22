import { chromium } from 'playwright';
import dotenv from 'dotenv';
import fs from 'node:fs';

dotenv.config();

type SnkrdunkConfig = {
  baseUrl: string;
  searchKeywordsParamName: string;
  enableSearchFallback: boolean;
  playwrightTimeoutMs: number;
  playwrightNavigationTimeoutMs: number;
  priceExtractTimeoutMs: number;
  seeMoreMaxClicks: number;
  userAgent: string;
  headless: boolean;
  executablePath?: string;
};

function getConfig(): SnkrdunkConfig {
  const env = process.env;

  const baseUrl = env.SNKRDUNK_BASE_URL?.trim() || 'https://snkrdunk.com/en';
  const searchKeywordsParamName = env.SNKRDUNK_SEARCH_PARAM?.trim() || 'keywords';

  const playwrightTimeoutMs = Number(env.PLAYWRIGHT_TIMEOUT_MS ?? 45_000);
  const playwrightNavigationTimeoutMs = Number(env.PLAYWRIGHT_NAVIGATION_TIMEOUT_MS ?? 60_000);
  const priceExtractTimeoutMs = Number(env.SNKRDUNK_PRICE_EXTRACT_TIMEOUT_MS ?? 20_000);
  const seeMoreMaxClicks = Number(env.SNKRDUNK_SEE_MORE_MAX_CLICKS ?? 6);

  const userAgent =
    env.SNKRDUNK_USER_AGENT?.trim() ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  const headless = true;

  // Search works when the query is typed into the search box (URL ?keywords= does not populate the SPA).
  const enableSearchFallback = (env.SNKRDUNK_ENABLE_SEARCH ?? 'true').toLowerCase() !== 'false';

  const defaultChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePathFromEnv = env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  const executablePath =
    executablePathFromEnv ||
    (fs.existsSync(defaultChromePath) ? defaultChromePath : undefined);

  return {
    baseUrl,
    searchKeywordsParamName,
    enableSearchFallback,
    playwrightTimeoutMs,
    playwrightNavigationTimeoutMs,
    priceExtractTimeoutMs,
    seeMoreMaxClicks,
    userAgent,
    headless,
    executablePath,
  };
}

function toAbsoluteUrl(maybeRelativeUrl: string, baseUrl: string): string {
  try {
    return new URL(maybeRelativeUrl, baseUrl).toString();
  } catch {
    return maybeRelativeUrl;
  }
}

function stripQueryAndHash(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return url.split('?')[0].split('#')[0];
  }
}

function isUsedListingsUrl(s: string): boolean {
  return /\/trading-cards\/used\/listings\//i.test(s);
}

function parseCleanNumericPrice(text: string): number | null {
  const normalized = text
    .replace(/[\u00A0\s]/g, ' ')
    .replace(/(SG)/gi, ' ')
    .replace(/[¥￥]/g, ' ')
    .replace(/[$]/g, ' ')
    .replace(/[~]/g, ' ')
    .trim();

  const match = normalized.match(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/);
  if (!match) return null;

  const integerPart = match[1].replace(/,/g, '');
  const decimalPart = match[2];
  const value = decimalPart ? `${integerPart}.${decimalPart}` : integerPart;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function logScrapeError(message: string, meta: Record<string, unknown>): void {
  console.error(`[snkrdunk:scraper] ${message}`, meta);
}

async function waitForFullyLoaded(page: { waitForLoadState: Function }, timeoutMs: number): Promise<void> {
  await page.waitForLoadState('load').catch(() => undefined);
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => undefined);
}

function queryTokens(query: string): Set<string> {
  return new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((t) => t.length >= 2),
  );
}

type ResolvedInput =
  | { kind: 'listings'; listingsUrl: string }
  | { kind: 'product'; productUrl: string }
  | { kind: 'search'; query: string };

function resolveInput(raw: string, config: SnkrdunkConfig): ResolvedInput {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Empty input');

  if (/^https?:\/\//i.test(trimmed)) {
    const abs = stripQueryAndHash(toAbsoluteUrl(trimmed, config.baseUrl));
    if (isUsedListingsUrl(abs)) return { kind: 'listings', listingsUrl: abs };
    return { kind: 'product', productUrl: abs };
  }

  if (isUsedListingsUrl(trimmed)) {
    return { kind: 'listings', listingsUrl: stripQueryAndHash(toAbsoluteUrl(trimmed, config.baseUrl)) };
  }

  const m1 = trimmed.match(/\/trading-cards\/(\d+)/i);
  if (m1?.[1]) {
    return { kind: 'product', productUrl: `${config.baseUrl}/trading-cards/${m1[1]}` };
  }

  if (/^\d+$/.test(trimmed)) {
    return { kind: 'product', productUrl: `${config.baseUrl}/trading-cards/${trimmed}` };
  }

  if (!config.enableSearchFallback) {
    throw new Error(
      'Free-text search requires SNKRDUNK_ENABLE_SEARCH=true (default is true). Pass a product id, product URL, or used-listings URL.',
    );
  }

  return { kind: 'search', query: trimmed };
}

function tradingCardIdFromHref(href: string): string | null {
  const m = href.match(/\/trading-cards\/(\d+)/i);
  return m?.[1] ?? null;
}

function candidateTitleFromSearchRow(anchorTitle: string, anchorText: string): string {
  const t = anchorTitle.trim();
  if (t) return t;
  return anchorText
    .replace(/^SG\s*\$[^~]*~\s*\d+\s*sellers\s*/i, '')
    .replace(/^SG\s*\$\s*-\s*\d+\s*sellers\s*/i, '')
    .trim();
}

type SearchResolution =
  | { resolution: 'single'; productUrl: string }
  | { resolution: 'ambiguous'; candidates: Array<{ title: string; productUrl: string }> };

/**
 * Deterministic search resolution only: score anchors, tie-break EN vs JP, dedupe by product id.
 * Does not navigate to product or listings pages.
 */
async function resolveSearchTradingCard(page: any, query: string, config: SnkrdunkConfig): Promise<SearchResolution> {
  const searchPage = `${config.baseUrl}/search`;
  await page.goto(searchPage, { waitUntil: 'load', timeout: config.playwrightNavigationTimeoutMs });
  await waitForFullyLoaded(page, config.playwrightTimeoutMs);

  const searchInput = page.locator('input[type="search"], input[aria-label="Search"]').first();
  await searchInput.waitFor({ state: 'visible', timeout: config.playwrightTimeoutMs });
  await searchInput.fill(query);
  await page.keyboard.press('Enter');

  await page.waitForTimeout(8000);
  await waitForFullyLoaded(page, Math.min(config.playwrightTimeoutMs, 20_000));

  const tokens = queryTokens(query);
  const queryNorm = query.trim().toLowerCase().replace(/\s+/g, ' ');

  type SearchRank = { href: string; score: number; text: string; anchorTitle: string };

  const ranked: SearchRank[] = await page.evaluate(
    ({ tokenList, queryNormalized }: { tokenList: string[]; queryNormalized: string }) => {
      const tokens = new Set(tokenList);
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      const rows: Array<{ href: string; score: number; text: string; anchorTitle: string }> = [];

      for (const a of anchors) {
        const hrefVal = a.getAttribute('href') || '';
        if (!hrefVal) continue;
        if (!/\/trading-cards\/\d+/i.test(hrefVal)) continue;
        if (/\/used\//i.test(hrefVal)) continue;

        const text = (a.textContent || '').trim();
        const anchorTitle = ((a as HTMLAnchorElement).getAttribute('title') || '').trim();
        const blob = `${text} ${anchorTitle} ${hrefVal}`.toLowerCase();

        let s = 0;
        let matched = 0;
        for (const t of tokens) {
          if (blob.includes(t)) {
            s += 2;
            matched += 1;
          }
        }
        if (tokens.size) s += Math.round((matched / tokens.size) * 6);
        if (queryNormalized && blob.includes(queryNormalized)) s += 12;
        if (/\/trading-cards\/\d+/i.test(hrefVal)) s += 3;

        if (s > 0) rows.push({ href: hrefVal, score: s, text: text.slice(0, 400), anchorTitle });
      }

      rows.sort((x, y) => y.score - x.score);
      return rows.slice(0, 24);
    },
    { tokenList: Array.from(tokens), queryNormalized: queryNorm },
  );

  if (!ranked.length) {
    throw new Error(`No trading-card search results matched query="${query}"`);
  }

  const top = ranked[0];
  let tier = ranked.filter((r) => r.score === top.score);

  const nonEn = tier.filter((r) => !/\[EN\]/i.test(r.text));
  if (nonEn.length > 0) tier = nonEn;

  const seenIds = new Set<string>();
  const deduped: SearchRank[] = [];
  for (const r of tier) {
    const id = tradingCardIdFromHref(r.href);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    deduped.push(r);
  }

  if (deduped.length === 1) {
    return { resolution: 'single', productUrl: stripQueryAndHash(toAbsoluteUrl(deduped[0].href, config.baseUrl)) };
  }

  if (deduped.length === 0) {
    throw new Error(`No trading-card search results matched query="${query}" after deduplication`);
  }

  const candidates = deduped.map((r) => ({
    title: candidateTitleFromSearchRow(r.anchorTitle, r.text),
    productUrl: stripQueryAndHash(toAbsoluteUrl(r.href, config.baseUrl)),
  }));

  return { resolution: 'ambiguous', candidates };
}

async function extractTitleFromPage(page: any): Promise<string> {
  const title = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    if (h1) return (h1.textContent || '').trim();
    const main = document.querySelector('.product-detail__main');
    if (main) return (main.textContent || '').trim().split('\n')[0]?.trim() || '';
    return '';
  });
  return title;
}

async function findUsedListingsUrlFromProductPage(page: any, config: SnkrdunkConfig): Promise<string | null> {
  return await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/trading-cards/used/listings/"]')) as HTMLAnchorElement[];
    if (!anchors.length) return null;

    let best: HTMLAnchorElement | null = null;
    let bestScore = -999;

    for (const a of anchors) {
      let score = 0;
      let el: HTMLElement | null = a;
      for (let depth = 0; depth < 12 && el; depth++) {
        const cls = String(el.className || '').toLowerCase();
        const txt = (el.textContent || '').slice(0, 300).toLowerCase();
        if (cls.includes('similar')) score += 6;
        if (txt.includes('similar items')) score += 6;
        if (cls.includes('used-listing')) score += 4;
        if (cls.includes('product-item')) score += 1;
        el = el.parentElement;
      }
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }

    const href = (best || anchors[0]).getAttribute('href');
    return href || null;
  }).then((href: string | null) => (href ? stripQueryAndHash(toAbsoluteUrl(href, config.baseUrl)) : null));
}

async function clickSeeMoreWhilePresent(page: any, maxClicks: number): Promise<void> {
  for (let i = 0; i < maxClicks; i++) {
    const more = page.getByRole('button', { name: /see more/i }).or(page.locator('a:has-text("See More")')).first();
    const visible = await more.isVisible({ timeout: 1200 }).catch(() => false);
    if (!visible) break;
    try {
      await more.click({ timeout: 8000 });
    } catch {
      break;
    }
    await page.waitForTimeout(2800);
  }
}

/**
 * DOM order = SNKRDUNK display order; first SOLD row per grade = latest sold for that grade on this page.
 */
async function extractLastSoldByGradeFromListingsPage(page: any): Promise<{
  lastSoldByGrade: Record<string, number>;
  /** Grades in first-seen (DOM) order — useful when JSON object key order is not guaranteed. */
  lastSoldGradeOrder: string[];
}> {
  const raw = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[class*="product-item"]')) as HTMLElement[];
    const rows: Array<{ grade: string; price: number; order: number }> = [];
    let order = 0;

    for (const el of items) {
      const text = (el.innerText || '').replace(/\r/g, '');
      if (!/\bSOLD\b/i.test(text)) continue;

      const priceMatch = text.match(/SG\s*\$\s*([\d,]+)/i) || text.match(/\$\s*([\d,]+)/);
      if (!priceMatch) continue;
      const price = Number(String(priceMatch[1]).replace(/,/g, ''));
      if (!Number.isFinite(price)) continue;

      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      let soldIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^sold$/i.test(lines[i])) {
          soldIdx = i;
          break;
        }
      }
      if (soldIdx < 0) continue;

      let grade = '';
      for (let i = soldIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (/^SG\s*\$/i.test(line)) break;
        if (line.length > 48) break;

        if (/^(PSA|CGC|BGS)\b/i.test(line)) {
          grade = line;
          break;
        }
        if (/^[A-Z]$/i.test(line)) {
          grade = line.toUpperCase();
          break;
        }
      }

      if (!grade) grade = 'UNKNOWN';

      rows.push({ grade, price, order });
      order += 1;
    }

    return rows;
  });

  const byGrade: Record<string, number> = {};
  const order: string[] = [];
  for (const row of raw) {
    if (byGrade[row.grade] !== undefined) continue;
    byGrade[row.grade] = row.price;
    order.push(row.grade);
  }
  return { lastSoldByGrade: byGrade, lastSoldGradeOrder: order };
}

async function inferProductUrlFromListingsPage(page: any, config: SnkrdunkConfig): Promise<string | null> {
  const href = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
    for (const a of anchors) {
      const h = a.getAttribute('href') || '';
      if (!/\/trading-cards\/\d+/i.test(h)) continue;
      if (/\/trading-cards\/used\/listings\//i.test(h)) continue;
      const m = h.match(/\/trading-cards\/(\d+)/i);
      if (m?.[1]) return m[1];
    }
    return null;
  });
  if (!href) return null;
  return `${config.baseUrl}/trading-cards/${href}`;
}

export type SnkrdunkResolvedLastSoldByGrade = {
  type: 'RESOLVED';
  resolvedTitle: string;
  productUrl: string;
  listingsUrl: string;
  lastSoldByGrade: Record<string, number>;
  lastSoldGradeOrder: string[];
};

export type SnkrdunkAmbiguousSearch = {
  type: 'AMBIGUOUS';
  candidates: Array<{ title: string; productUrl: string }>;
};

export type SnkrdunkLastSoldByGradeResult = SnkrdunkResolvedLastSoldByGrade | SnkrdunkAmbiguousSearch;

export async function getSnkrdunkLastSoldByGrade(cardQuery: string): Promise<SnkrdunkLastSoldByGradeResult> {
  const config = getConfig();
  if (!cardQuery?.trim()) throw new Error('getSnkrdunkLastSoldByGrade requires a non-empty query');

  const browser = await chromium.launch({
    headless: config.headless,
    executablePath: config.executablePath,
  });
  const context = await browser.newContext({
    userAgent: config.userAgent,
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(config.playwrightTimeoutMs);
  page.setDefaultNavigationTimeout(config.playwrightNavigationTimeoutMs);

  try {
    const resolved = resolveInput(cardQuery, config);

    let productUrl: string;
    let listingsUrl: string;
    let resolvedTitle: string;

    if (resolved.kind === 'listings') {
      listingsUrl = resolved.listingsUrl;
      await page.goto(listingsUrl, { waitUntil: 'load', timeout: config.playwrightNavigationTimeoutMs });
      await waitForFullyLoaded(page, config.playwrightTimeoutMs);
      resolvedTitle = await extractTitleFromPage(page);
      productUrl = (await inferProductUrlFromListingsPage(page, config)) || listingsUrl;
    } else {
      if (resolved.kind === 'search') {
        const searchResult = await resolveSearchTradingCard(page, resolved.query, config);
        if (searchResult.resolution === 'ambiguous') {
          return { type: 'AMBIGUOUS', candidates: searchResult.candidates };
        }
        productUrl = searchResult.productUrl;
      } else {
        productUrl = resolved.productUrl;
      }

      await page.goto(productUrl, { waitUntil: 'load', timeout: config.playwrightNavigationTimeoutMs });
      await waitForFullyLoaded(page, config.playwrightTimeoutMs);
      resolvedTitle = await extractTitleFromPage(page);

      const foundListings = await findUsedListingsUrlFromProductPage(page, config);
      if (!foundListings) {
        throw new Error(
          `Could not find a used listings link on product page. Open the card on SNKRDUNK and paste the full /used/listings/... URL.`,
        );
      }
      listingsUrl = foundListings;

      await page.goto(listingsUrl, { waitUntil: 'load', timeout: config.playwrightNavigationTimeoutMs });
      await waitForFullyLoaded(page, config.playwrightTimeoutMs);
    }

    await clickSeeMoreWhilePresent(page, config.seeMoreMaxClicks);

    const { lastSoldByGrade, lastSoldGradeOrder } = await extractLastSoldByGradeFromListingsPage(page);
    if (Object.keys(lastSoldByGrade).length === 0) {
      throw new Error('No SOLD rows with prices found on the used listings page.');
    }

    return {
      type: 'RESOLVED',
      resolvedTitle,
      productUrl,
      listingsUrl,
      lastSoldByGrade,
      lastSoldGradeOrder,
    };
  } catch (err) {
    const isTimeout = (err as { name?: string })?.name === 'TimeoutError';
    logScrapeError('getSnkrdunkLastSoldByGrade failed', {
      cardQuery,
      errorType: isTimeout ? 'TimeoutError' : 'Error',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    await page.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

/**
 * Back-compat: returns a single numeric price — PSA 10 last sold if present, else first grade in DOM order.
 * Prefer `getSnkrdunkLastSoldByGrade` for full `{ type, lastSoldByGrade, ... }` or `AMBIGUOUS` handling.
 */
export async function getSnkrdunkPrice(cardName: string): Promise<number> {
  const r = await getSnkrdunkLastSoldByGrade(cardName);
  if (r.type === 'AMBIGUOUS') {
    throw new Error(
      'Search is ambiguous: multiple products matched. Pick a candidate productUrl and call again with that URL or id.',
    );
  }
  if (r.lastSoldByGrade['PSA 10'] != null) return r.lastSoldByGrade['PSA 10'];
  const first = r.lastSoldGradeOrder[0];
  if (first != null && r.lastSoldByGrade[first] != null) return r.lastSoldByGrade[first];
  const keys = Object.keys(r.lastSoldByGrade).sort();
  if (!keys.length) throw new Error('No sold prices found');
  return r.lastSoldByGrade[keys[0]];
}
