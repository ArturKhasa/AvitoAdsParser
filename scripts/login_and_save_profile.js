import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
    fs.mkdirSync('profiles', { recursive: true });

    const uuid = crypto.randomUUID();
    const initialProfileDir = path.join('profiles', `profile-${uuid}`);

    const context = await chromium.launchPersistentContext(initialProfileDir, {
        headless: false,
        channel: 'chrome',
        viewport: null,
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
        proxy: {
            server: 'http://pool.proxys.io:10002',
            username: 'user388501o17284r329030',
            password: 'qgyxlt',
        },
    });

    const page = context.pages()[0] ?? await context.newPage();

    await page.goto('https://www.avito.ru', { waitUntil: 'domcontentloaded' });

    console.log('Войдите в аккаунт вручную.');
    await page.waitForTimeout(120_000);

    const state = await context.storageState();
    const phoneRaw = extractPhoneFromStorageState(state) ?? 'unknown';
    const safePhone = sanitizePathPart(phoneRaw) || 'unknown';

    await context.close();

    const finalProfileDir = path.join('profiles', `profile-${safePhone}-${uuid}`);

    if (initialProfileDir !== finalProfileDir && !fs.existsSync(finalProfileDir)) {
        fs.renameSync(initialProfileDir, finalProfileDir);
    }

    console.log(`Profile saved: ${finalProfileDir}`);
})();