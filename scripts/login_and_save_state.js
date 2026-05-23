
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PROXY = {
    server: 'http://217.29.63.203:11223',
    username: 'YhmJ8A8XfS',
    password: 'yFqjTfyC4N',
};

const WAIT_MS = 10_000; // 2 minutes to log in manually

function extractPhoneFromStorageState(state) {
    for (const origin of state.origins ?? []) {
        const ls = origin.localStorage ?? [];
        const lastLogin = ls.find((x) => x?.name === 'lastLogin')?.value;
        if (!lastLogin) continue;

        try {
            const parsed = JSON.parse(lastLogin);
            const data = parsed?.data;
            if (!data || typeof data !== 'object') continue;

            for (const k of Object.keys(data)) {
                const login = data?.[k]?.login;
                if (typeof login === 'string' && login.trim()) {
                    return login.trim();
                }
            }
        } catch {}
    }

    return null;
}

function sanitizePathPart(value) {
    return value
        .replace(/[<>:"/\\|?*\s]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
}

(async () => {
    fs.mkdirSync('states', { recursive: true });

    const browser = await chromium.launch({
        headless: false,
        channel: 'chrome',
    });

    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
        proxy: PROXY,
    });

    const page = await context.newPage();

    await page.goto('https://www.avito.ru', { waitUntil: 'domcontentloaded' });

    console.log(`Войдите в аккаунт вручную. Есть ${WAIT_MS / 1000} секунд.`);
    await page.waitForTimeout(WAIT_MS);

    const state = await context.storageState();

    await context.close();
    await browser.close();

    const phoneRaw = extractPhoneFromStorageState(state) ?? null;

    const uuid = crypto.randomUUID().slice(0, 8);
    let fileName = `state-${uuid}.json`;

    if (phoneRaw) {
        const safePhone = sanitizePathPart(phoneRaw);
        fileName = `state-${safePhone}-${uuid}.json`;
    }

    const filePath = path.join('states', fileName);

    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));

    console.log(`State сохранён: ${filePath}`);
    console.log(`Скопируйте файл на сервер: scp ${filePath} tgmaps@84.201.176.101:/var/www/parser-avito/${filePath}`);
})();