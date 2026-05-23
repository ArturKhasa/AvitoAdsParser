import 'dotenv/config';
import {chromium} from 'playwright';
import {Pool} from 'pg';
import {readdirSync, readFileSync, statSync, mkdirSync} from 'node:fs'
import path from 'node:path'
//pm2 start index.js --cron-restart="2 * * * *"
// firewall-container
const {
    START_URL = 'https://www.avito.ru/',
    MAX_SCROLLS = '5',
    SCROLL_PAUSE_MS = '1200', // было 1200
    CLICK_TIMEOUT_MS = '20000', // было 12000
    NAV_TIMEOUT_MS = '30000', //было 20000
} = process.env;

const MAX_SCROLLS_N = Number(MAX_SCROLLS);
const SCROLL_PAUSE_MS_N = Number(SCROLL_PAUSE_MS);
const CLICK_TIMEOUT = Number(CLICK_TIMEOUT_MS);
const NAV_TIMEOUT = Number(NAV_TIMEOUT_MS);

const pool = new Pool({
    connectionString: "postgres://avimaps:R\\zTGKWil^*j[b6@c-c9q2tjkhcoelkia86tnk.rw.mdb.yandexcloud.net:6432/db3",
    ssl: {
        rejectUnauthorized: true,
        ca: readFileSync('root.crt').toString(),
    },
});

function isExternalToAvito(urlStr) {
    const d = getDomain(urlStr);
    if (!d) return false;
    return !d.includes('avito') || !d.includes('yandex') || !d.includes('google')
}

async function clickThreeDotsAndGetAdvertiserText(page, banner) {
    await page.mouse.click(5, 5).catch(() => {}); // клик в угол
    await sleep(jitter(80, 120));

    // Ищем "⋮" внутри баннера (точно символ)
    const dots = banner.locator('span', { hasText: '⋮' }).first();

    // Часто кликабелен родительский контейнер
    const dotsClickable = dots.locator('xpath=ancestor::div[1]');

    // Узкий паттерн именно по нужному тексту
    const disclosureLocator = page
        .locator('span, div')
        .filter({ hasText: /Рекламодатель/i })
        .filter({ hasText: /erid/i });

    // Сколько уже было до клика
    const before = await disclosureLocator.count().catch(() => 0);

    // Клик по ⋮ (с фоллбэком на родителя)
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

    // Ждём появления НОВОГО disclosure (count станет больше)
    await page.waitForFunction(
        ({ before }) => {
            const nodes = Array.from(document.querySelectorAll('span,div'));
            const now = nodes.filter(n =>
                /рекламодатель/i.test(n.innerText || '') && /erid/i.test(n.innerText || '')
            ).length;
            return now > before;
        },
        { before },
        { timeout: 3500 }
    ).catch(() => {});

    // Берём последний (чаще всего это только что открывшийся)
    const after = await disclosureLocator.count().catch(() => 0);
    const idx = Math.max(0, after - 1);
    let raw = (await disclosureLocator.nth(idx).innerText().catch(() => '')) || '';
    raw = raw.replace(/\s+/g, ' ').trim();

    // Обрезаем строго нужный кусок:
    // от "Рекламодатель" до "18+" (если есть) или до конца,
    // и ограничиваем длину на всякий случай.
    const m = raw.match(/(Рекламодатель.*?)(?:\s(18\+)\b.*)?$/i);
    let cleaned = (m?.[1] || raw).trim();

    // если встречается "18+", сохраним его тоже
    if (/18\+/i.test(raw) && !/18\+/.test(cleaned)) cleaned = `${cleaned} 18+`;

    if (cleaned.length > 350) cleaned = cleaned.slice(0, 350);

    // Закрыть поповер, чтобы не мешал
    const closeSvg = page.locator('svg[data-icon-set="zna4ki/kvadratiki"]:visible').last();

// чаще всего кликабелен родитель (button/div с role)
    const closeClickable = closeSvg.locator(
        'xpath=ancestor::*[self::button or @role="button" or self::div][1]'
    );

    let closed = false;
    for (const t of [closeClickable, closeSvg]) {
        try {
            await t.click({ timeout: 1200, force: true });
            closed = true;
            break;
        } catch (_) {}
    }

    if (!closed) {
        await page.keyboard.press('Escape').catch(() => {});
    }

    await sleep(jitter(80, 120));


    return cleaned;
}


async function extractSubtitleFromBanner(banner) {
    // точечный селектор по классу как просили
    const el = banner.locator('span.styles-module-size_s-GJxjZ.styles-module-size_s_dense-KN2W1').first();
    const txt = (await el.textContent().catch(() => '')) || '';
    return txt.replace(/\s+/g, ' ').trim();
}


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

        // Проверяем, содержит ли домен t.me
        if (hostname === 't.me') {
            return hostname + url.pathname;
        }

        return hostname;
    } catch (e) {
        return null;
    }
}

/**
 * Достаём "заголовок" из баннера.
 * Т.к. классы динамические, лучше вытащить тексты rootComponent-спанов и выбрать подходящий.
 */
async function extractTitleFromBanner(banner) {
    const texts = await banner.locator('span[data-marker="rootComponent"]').allTextContents().catch(() => []);
    const cleaned = (texts || [])
        .map((t) => (t || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);

    // Обычно: [ЗАГОЛОВОК, ОПИСАНИЕ(... "Реклама"), ...]
    // Берём первый нормальный, который не содержит "Реклама"
    const candidate = cleaned.find((t) => !/реклама/i.test(t)) || cleaned[0] || '';
    return candidate.slice(0, 255);
}

async function extractImagesFromBanner(banner) {
    const srcs = await banner.locator('img').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src') || '').filter(Boolean))
        .catch(() => []);
    // чистим мусор
    return [...new Set(srcs.filter((u) => u.startsWith('http')))];
}

async function upsertCreativeMeta(client, { title, subtitle, advertiser_info }) {
    const q = `
        UPDATE avito_creatives
        SET
            subtitle = $2,
            advertiser_info = $3,
            last_visible_at = NOW()
        WHERE title = $1
            RETURNING id;
    `;
    const res = await client.query(q, [title, subtitle ?? null, advertiser_info ?? null]);
    return res.rows[0]?.id ?? null;
}



async function upsertCreative(client, {title, subtitle, domain, click_url, advertiser_info}) {
    const q = `
        INSERT INTO avito_creatives (title, subtitle, domain, click_url, advertiser_info, first_visible_at, last_visible_at)
        VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
            ON CONFLICT (title) DO UPDATE SET
            subtitle = EXCLUDED.subtitle,
                                       domain = EXCLUDED.domain,
                                       click_url = EXCLUDED.click_url,
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
        VALUES ($1, $2, NOW()) ON CONFLICT
        ON CONSTRAINT avito_creatives_files_creative_file_uniq DO NOTHING;
    `;
    for (const url of fileUrls) {
        await client.query(q, [creativeId, url]);
    }
}

async function clickBannerAndGetFinalUrl(page, banner, screenshotDir) {
    // Куда кликать: сначала кнопка "Подробнее", иначе весь баннер
    const moreBtn = banner.locator('button:has-text("Подробнее")').first();
    const clickTarget = (await moreBtn.count().catch(() => 0)) > 0 ? moreBtn : banner;

    // ВАЖНО: ловим popup строго от этого клика
    const popupPromise = page.waitForEvent('popup', { timeout: CLICK_TIMEOUT });

    await banner.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(jitter(80, 140));

    await clickTarget.click({ force: true, noWaitAfter: true, timeout: CLICK_TIMEOUT }).catch(async () => {
        // fallback: если кнопка не кликается
        await banner.click({ force: true, noWaitAfter: true, timeout: CLICK_TIMEOUT }).catch(() => {});
    });

    const popup = await popupPromise.catch(() => null);
    if (!popup) return null;

    try {
        // Перехватываем реальный URL навигации до того, как страница может упасть в ошибку
        let intendedUrl = null;
        popup.on('framenavigated', (frame) => {
            if (frame === popup.mainFrame()) {
                const u = frame.url();
                if (u && u !== 'about:blank' && !u.startsWith('chrome-error://')) {
                    intendedUrl = u;
                }
            }
        });

        // Подождём хоть какой-то реальный URL (часто сначала about:blank)
        await popup.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
        if (popup.url() === 'about:blank') {
            await popup.waitForURL((u) => u.toString() !== 'about:blank', { timeout: NAV_TIMEOUT }).catch(() => {});
        }

        // Ждём, пока вкладка уйдёт на внешний домен
        await popup.waitForURL(
            (u) => isExternalToAvito(u.toString()),
            { timeout: NAV_TIMEOUT }
        ).catch(() => {});

        // На некоторых лендингах networkidle может не наступить — поэтому не делаем это обязательным.
        await popup.waitForLoadState('load', { timeout: Math.min(8000, NAV_TIMEOUT) }).catch(() => {});

        const rawUrl = popup.url();
        // Если браузер показал страницу ошибки — берём перехваченный URL навигации
        const finalUrl = rawUrl.startsWith('chrome-error://') ? intendedUrl : rawUrl;

        if (screenshotDir && finalUrl && finalUrl !== 'about:blank') {
            const safeName = finalUrl.replace(/[^a-z0-9]/gi, '_').slice(0, 80);
            await popup.screenshot({ path: `${screenshotDir}/popup_${safeName}.png`, fullPage: false }).catch(() => {});
        }

        return finalUrl && finalUrl !== 'about:blank' ? finalUrl : null;
    } finally {
        // чтобы не копить вкладки
        await popup.close().catch(() => {});
    }
}


async function startProfile(profileDir) {
    const profileName = path.basename(profileDir);

    const context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        channel: 'chrome',
        viewport: null,
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
        proxy: {
            server: 'http://217.29.63.203:11223',
            username: 'YhmJ8A8XfS',
            password: 'yFqjTfyC4N',
        }
    });

    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(15000);

    const screenshotDir = `./screenshots/${profileName}_${Date.now()}`;
    mkdirSync(screenshotDir, { recursive: true });

    try {
        await page.goto(START_URL, {waitUntil: 'domcontentloaded', timeout: 45000});
        await sleep(jitter(1500, 900));

        // Скриншот 1: что видит браузер при первом открытии Авито
        await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});
        await page.screenshot({ path: `${screenshotDir}/01_avito_initial.png`, fullPage: false }).catch(() => {});

        // Селектор рекламного блока (из твоего HTML — это outclickBanner)
        const bannerSelector = 'div[data-element="beduin-v2/outclickBanner"]';

        const seenTitles = new Set();
        let totalSaved = 0;

        for (let i = 0; i < MAX_SCROLLS_N; i++) {
            // Подождём после прогрузки очередной "порции"
            await sleep(jitter(SCROLL_PAUSE_MS_N, 700));

            const banners = page.locator(bannerSelector);
            const count = await banners.count().catch(() => 0);

            // Скриншот 2: что видит браузер после скролла (показываем найденные баннеры)
            await page.screenshot({ path: `${screenshotDir}/02_scroll_${i}_banners_${count}.png`, fullPage: false }).catch(() => {});

            for (let idx = 0; idx < count; idx++) {
                const banner = banners.nth(idx);

                // чтобы элемент был в зоне видимости (иногда без этого клики тупят)
                await banner.scrollIntoViewIfNeeded().catch(() => {
                });
                await sleep(jitter(350, 350));

                const title = await extractTitleFromBanner(banner);
                if (!title) continue;

                // если уже обработали — можно только обновить last_visible_at,
                // но для простоты просто пропустим (или можно делать лёгкий upsert без клика)
                if (seenTitles.has(title)) continue;
                const subtitle = await extractSubtitleFromBanner(banner);

                // Скриншот 3: баннер крупным планом перед кликом
                const safeTitle = title.replace(/[^а-яёa-z0-9]/gi, '_').slice(0, 60);
                await banner.screenshot({ path: `${screenshotDir}/03_banner_${idx}_${safeTitle}.png` }).catch(() => {});

                const images = await extractImagesFromBanner(banner);

                const finalUrl = await clickBannerAndGetFinalUrl(page, banner, screenshotDir);
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

                // Запись в БД
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    const creativeId = await upsertCreative(client, {
                        title, subtitle, domain, click_url, advertiser_info: advertiserInfo
                    });
                    await insertCreativeFiles(client, creativeId, images);
                    await client.query('COMMIT');
                    seenTitles.add(title);
                    totalSaved += 1;
                } catch (e) {
                    await client.query('ROLLBACK').catch(() => {
                    });
                    console.error('DB error:', e?.message || e);
                } finally {
                    client.release();
                }

                // Антизалипание: микропаузу после клика/записи
                await sleep(jitter(800, 900));
            }

            // Скролл вниз (ленивая подгрузка рекламы)
            await page.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
            await sleep(jitter(SCROLL_PAUSE_MS_N, 900));
        }

        console.log(`[${profileName}] Done. Unique processed titles: ${seenTitles.size}, saved: ${totalSaved}`);
    } finally {
        await context.close().catch(() => {});
    }
}

async function main() {
    const profilesDir = './profiles';
    const profileDirs = readdirSync(profilesDir)
        .map(name => path.join(profilesDir, name))
        .filter(p => statSync(p).isDirectory());

    if (profileDirs.length === 0) {
        console.error('No profiles found in ./profiles');
        process.exit(1);
    }

    try {
        const tasks = profileDirs.map((profileDir) => {
            const mskTime = new Date().toLocaleString("ru-RU", {timeZone: "Europe/Moscow"});
            console.log(`[${mskTime}] Start: ${path.basename(profileDir)}`);
            return startProfile(profileDir)
                .catch((e) => console.error(`Profile failed: ${path.basename(profileDir)}`, e?.message || e));
        });

        await Promise.all(tasks);
    } finally {
        await pool.end().catch(() => {});
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});