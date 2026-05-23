import 'dotenv/config';
import { chromium } from 'playwright';
import { Pool } from 'pg';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// pm2 start index_proxy.js --cron-restart="2 * * * *"
// pm2 start index_proxy.js --restart-delay 3600000
// pm2 start index_proxy.js --restart-delay 600000

const {
    START_URL = 'https://avito.ru/',
    MAX_SCROLLS = '5',
    SCROLL_PAUSE_MS = '1200',
    CLICK_TIMEOUT_MS = '20000',
    NAV_TIMEOUT_MS = '30000',
    CONCURRENCY = '10',           // сколько прокси работают параллельно
    PROXY_FILE = 'proxys.txt',
} = process.env;

const MAX_SCROLLS_N = Number(MAX_SCROLLS);
const SCROLL_PAUSE_MS_N = Number(SCROLL_PAUSE_MS);
const CLICK_TIMEOUT = Number(CLICK_TIMEOUT_MS);
const NAV_TIMEOUT = Number(NAV_TIMEOUT_MS);
const CONCURRENCY_N = Number(CONCURRENCY);

const pool = new Pool({
    connectionString: "postgres://tguser:buk8lck1@c-c9q2tj. khcoelkia86tnk.rw.mdb.yandexcloud.net:6432/db3",
    ssl: {
        rejectUnauthorized: true,
        ca: readFileSync('root.crt').toString(),
    },
});

// ── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function jitter(base, spread = 350) {
    return base + Math.floor(Math.random() * spread);
}

function getDomain(urlStr) {
    try {
        const url = new URL(urlStr);
        const hostname = url.hostname;
        if (hostname === 't.me') return hostname + url.pathname;
        return hostname;
    } catch {
        return null;
    }
}

function isExternalToAvito(urlStr) {
    const d = getDomain(urlStr);
    if (!d) return false;
    return !d.includes('avito') || !d.includes('yandex') || !d.includes('google');
}

/**
 * Читает proxys_38103.txt и возвращает массив объектов
 * { server, username, password, label }
 */
function loadProxies(filePath) {
    const abs = path.resolve(filePath);
    const lines = readFileSync(abs, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

    return lines.map((line) => {
        const [host, port, username, password] = line.split(':');
        if (!host || !port || !username || !password) {
            console.warn(`[proxies] Skipping malformed line: ${line}`);
            return null;
        }
        return {
            server: `http://${host}:${port}`,
            username,
            password,
            label: `${host}-${port}`,
        };
    }).filter(Boolean);
}

// ── DB helpers (те же, что в index.js) ───────────────────────────────────────

async function upsertCreativeMeta(client, { title, subtitle, advertiser_info }) {
    const q = `
        UPDATE avito_creatives
        SET subtitle = $2, advertiser_info = $3, last_visible_at = NOW()
        WHERE title = $1
        RETURNING id;
    `;
    const res = await client.query(q, [title, subtitle ?? null, advertiser_info ?? null]);
    return res.rows[0]?.id ?? null;
}

async function upsertCreative(client, { title, subtitle, domain, click_url, advertiser_info }) {
    const q = `
        INSERT INTO avito_creatives (title, subtitle, domain, click_url, advertiser_info, first_visible_at, last_visible_at)
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
        ON CONFLICT (title) DO UPDATE SET
            subtitle        = EXCLUDED.subtitle,
            domain          = EXCLUDED.domain,
            click_url       = EXCLUDED.click_url,
            advertiser_info = EXCLUDED.advertiser_info,
            last_visible_at = NOW()
        RETURNING id;
    `;
    const res = await client.query(q, [title, subtitle ?? null, domain, click_url, advertiser_info ?? null]);
    return res.rows[0]?.id;
}

async function insertCreativeFiles(client, creativeId, fileUrls) {
    if (!creativeId || !fileUrls?.length) return;
    const q = `
        INSERT INTO avito_creative_files (creative_id, file_url, created_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT ON CONSTRAINT avito_creatives_files_creative_file_uniq DO NOTHING;
    `;
    for (const url of fileUrls) {
        await client.query(q, [creativeId, url]);
    }
}

// ── page helpers ──────────────────────────────────────────────────────────────

async function extractTitleFromBanner(banner) {
    const texts = await banner.locator('span[data-marker="rootComponent"]').allTextContents().catch(() => []);
    const cleaned = (texts || [])
        .map((t) => (t || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    const candidate = cleaned.find((t) => !/реклама/i.test(t)) || cleaned[0] || '';
    return candidate.slice(0, 255);
}

async function extractSubtitleFromBanner(banner) {
    const el = banner.locator('span.styles-module-size_s-GJxjZ.styles-module-size_s_dense-KN2W1').first();
    const txt = (await el.textContent().catch(() => '')) || '';
    return txt.replace(/\s+/g, ' ').trim();
}

async function extractImagesFromBanner(banner) {
    const srcs = await banner.locator('img')
        .evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src') || '').filter(Boolean))
        .catch(() => []);
    return [...new Set(srcs.filter((u) => u.startsWith('http')))];
}

async function clickThreeDotsAndGetAdvertiserText(page, banner) {
    await page.mouse.click(5, 5).catch(() => {});
    await sleep(jitter(80, 120));

    const dots = banner.locator('span', { hasText: '⋮' }).first();
    const dotsClickable = dots.locator('xpath=ancestor::div[1]');

    const disclosureLocator = page
        .locator('span, div')
        .filter({ hasText: /Рекламодатель/i })
        .filter({ hasText: /erid/i });

    const before = await disclosureLocator.count().catch(() => 0);

    let clicked = false;
    for (const t of [dots, dotsClickable]) {
        try {
            await t.scrollIntoViewIfNeeded().catch(() => {});
            await sleep(jitter(120, 150));
            await t.click({ timeout: 2500, force: true });
            clicked = true;
            break;
        } catch (_) {}
    }
    if (!clicked) return '';

    await page.waitForFunction(
        ({ before }) => {
            const nodes = Array.from(document.querySelectorAll('span,div'));
            const now = nodes.filter((n) =>
                /рекламодатель/i.test(n.innerText || '') && /erid/i.test(n.innerText || '')
            ).length;
            return now > before;
        },
        { before },
        { timeout: 3500 }
    ).catch(() => {});

    const after = await disclosureLocator.count().catch(() => 0);
    const idx = Math.max(0, after - 1);
    let raw = (await disclosureLocator.nth(idx).innerText().catch(() => '')) || '';
    raw = raw.replace(/\s+/g, ' ').trim();

    const m = raw.match(/(Рекламодатель.*?)(?:\s(18\+)\b.*)?$/i);
    let cleaned = (m?.[1] || raw).trim();
    if (/18\+/i.test(raw) && !/18\+/.test(cleaned)) cleaned = `${cleaned} 18+`;
    if (cleaned.length > 350) cleaned = cleaned.slice(0, 350);

    const closeSvg = page.locator('svg[data-icon-set="zna4ki/kvadratiki"]:visible').last();
    const closeClickable = closeSvg.locator('xpath=ancestor::*[self::button or @role="button" or self::div][1]');
    let closed = false;
    for (const t of [closeClickable, closeSvg]) {
        try {
            await t.click({ timeout: 1200, force: true });
            closed = true;
            break;
        } catch (_) {}
    }
    if (!closed) await page.keyboard.press('Escape').catch(() => {});
    await sleep(jitter(80, 120));

    return cleaned;
}

async function clickBannerAndGetFinalUrl(page, banner) {
    const moreBtn = banner.locator('button:has-text("Подробнее")').first();
    const clickTarget = (await moreBtn.count().catch(() => 0)) > 0 ? moreBtn : banner;

    const popupPromise = page.waitForEvent('popup', { timeout: CLICK_TIMEOUT });

    await banner.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(jitter(80, 140));

    await clickTarget.click({ force: true, noWaitAfter: true, timeout: CLICK_TIMEOUT }).catch(async () => {
        await banner.click({ force: true, noWaitAfter: true, timeout: CLICK_TIMEOUT }).catch(() => {});
    });

    const popup = await popupPromise.catch(() => null);
    if (!popup) return null;

    try {
        let intendedUrl = null;
        popup.on('framenavigated', (frame) => {
            if (frame === popup.mainFrame()) {
                const u = frame.url();
                if (u && u !== 'about:blank' && !u.startsWith('chrome-error://')) {
                    intendedUrl = u;
                }
            }
        });

        await popup.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
        if (popup.url() === 'about:blank') {
            await popup.waitForURL((u) => u.toString() !== 'about:blank', { timeout: NAV_TIMEOUT }).catch(() => {});
        }

        await popup.waitForURL(
            (u) => isExternalToAvito(u.toString()),
            { timeout: NAV_TIMEOUT }
        ).catch(() => {});

        await popup.waitForLoadState('load', { timeout: Math.min(8000, NAV_TIMEOUT) }).catch(() => {});

        const rawUrl = popup.url();
        const finalUrl = rawUrl.startsWith('chrome-error://') ? intendedUrl : rawUrl;

        return finalUrl && finalUrl !== 'about:blank' ? finalUrl : null;
    } finally {
        await popup.close().catch(() => {});
    }
}

// ── core: один прокси = один запуск ──────────────────────────────────────────

async function runWithProxy(proxy) {
    const profileDir = path.resolve(`./proxy-profiles/${proxy.label}`);
    mkdirSync(profileDir, { recursive: true });

    const context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        channel: 'chrome',
        viewport: null,
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
        proxy: {
            server:   proxy.server,
            username: proxy.username,
            password: proxy.password,
        },
    });

    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(15000);

    try {
        await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(jitter(1500, 900));

        await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});
        const bannerSelector = 'div[data-element="beduin-v2/outclickBanner"]';
        const seenTitles = new Set();
        let totalSaved = 0;

        for (let i = 0; i < MAX_SCROLLS_N; i++) {
            await sleep(jitter(SCROLL_PAUSE_MS_N, 700));

            const banners = page.locator(bannerSelector);
            const count = await banners.count().catch(() => 0);

            for (let idx = 0; idx < count; idx++) {
                const banner = banners.nth(idx);
                await banner.scrollIntoViewIfNeeded().catch(() => {});
                await sleep(jitter(350, 350));

                const title = await extractTitleFromBanner(banner);
                if (!title) continue;
                if (seenTitles.has(title)) continue;

                const subtitle = await extractSubtitleFromBanner(banner);

                const images = await extractImagesFromBanner(banner);
                const finalUrl = await clickBannerAndGetFinalUrl(page, banner);
                const advertiserInfo = await clickThreeDotsAndGetAdvertiserText(page, banner);

                if (!finalUrl) {
                    const metaClient = await pool.connect();
                    try {
                        await upsertCreativeMeta(metaClient, { title, subtitle, advertiser_info: advertiserInfo });
                    } finally {
                        metaClient.release();
                    }
                    seenTitles.add(title);
                    continue;
                }

                const domain = getDomain(finalUrl);
                const click_url = finalUrl;

                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    const creativeId = await upsertCreative(client, {
                        title, subtitle, domain, click_url, advertiser_info: advertiserInfo,
                    });
                    await insertCreativeFiles(client, creativeId, images);
                    await client.query('COMMIT');
                    seenTitles.add(title);
                    totalSaved += 1;
                } catch (e) {
                    await client.query('ROLLBACK').catch(() => {});
                    console.error(`[${proxy.label}] DB error:`, e?.message || e);
                } finally {
                    client.release();
                }

                await sleep(jitter(800, 900));
            }

            await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
            await sleep(jitter(SCROLL_PAUSE_MS_N, 900));
        }

        console.log(`[${proxy.label}] Done. Titles processed: ${seenTitles.size}, saved: ${totalSaved}`);
    } finally {
        await context.close().catch(() => {});
    }
}

// ── main: параллельный пул ────────────────────────────────────────────────────

async function main() {
    const proxies = loadProxies(PROXY_FILE);
    if (proxies.length === 0) {
        console.error(`No proxies loaded from ${PROXY_FILE}`);
        process.exit(1);
    }

    console.log(`Loaded ${proxies.length} proxies. Concurrency: ${CONCURRENCY_N}`);

    // Очередь: запускаем не более CONCURRENCY_N штук одновременно
    const queue = [...proxies];
    let active = 0;
    let done = 0;

    await new Promise((resolve) => {
        function next() {
            while (active < CONCURRENCY_N && queue.length > 0) {
                const proxy = queue.shift();
                active++;
                const mskTime = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
                console.log(`[${mskTime}] Start proxy: ${proxy.label} (active: ${active}, remaining: ${queue.length})`);

                runWithProxy(proxy)
                    .catch((e) => console.error(`[${proxy.label}] Failed:`, e?.message || e))
                    .finally(() => {
                        active--;
                        done++;
                        next();
                        if (active === 0 && queue.length === 0) resolve();
                    });
            }
        }
        next();
    });

    console.log(`All proxies done. Total processed: ${done}`);
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => pool.end().catch(() => {}));
