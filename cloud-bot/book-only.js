const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SAVEETHA_USER = process.env.SAVEETHA_USER;
const SAVEETHA_PASS = process.env.SAVEETHA_PASS;
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON;
const GIST_TOKEN = process.env.GIST_TOKEN;
const GIST_ID_ENV = process.env.GIST_ID;
const ADMIN_CHAT_ID = '6374825608';

// User Registry
let ACCOUNTS = {};
let USER_SESSIONS = new Map(); // chatId -> { context, config, persistentPage, isBusy }

// ─── Gist Persistence Logic ──────────────────────────────────────────────────

async function loadGist() {
    if (!GIST_TOKEN || !GIST_ID_ENV) {
        console.log('[Gist] GIST_TOKEN or GIST_ID not set. Runtime users will not persist.');
        return {};
    }
    try {
        const res = await fetch(`https://api.github.com/gists/${GIST_ID_ENV}`, {
            headers: { 'Authorization': `token ${GIST_TOKEN}` }
        });
        const data = await res.json();
        if (data.files && data.files['users.json']) {
            return JSON.parse(data.files['users.json'].content);
        }
    } catch (e) {
        console.error('[Gist] Load error:', e.message);
    }
    return {};
}

async function updateGist(users) {
    if (!GIST_TOKEN || !GIST_ID_ENV) return;
    try {
        await fetch(`https://api.github.com/gists/${GIST_ID_ENV}`, {
            method: 'PATCH',
            headers: { 
                'Authorization': `token ${GIST_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                files: { 'users.json': { content: JSON.stringify(users, null, 2) } }
            })
        });
        console.log('[Gist] Updated successfully.');
    } catch (e) {
        console.error('[Gist] Update error:', e.message);
    }
}

// ─── Account Initialization ──────────────────────────────────────────────────

async function initAccounts() {
    // 1. Load hardcoded secret users
    try {
        if (ACCOUNTS_JSON) {
            ACCOUNTS = JSON.parse(ACCOUNTS_JSON);
            console.log('[Bot] Loaded hardcoded accounts:', Object.keys(ACCOUNTS).join(', '));
        } else {
            ACCOUNTS[CHAT_ID] = { user: SAVEETHA_USER, pass: SAVEETHA_PASS, name: 'Primary User' };
        }
    } catch (e) { console.error('[Bot] ACCOUNTS_JSON parse error'); }

    // 2. Load dynamic users from Gist
    const gistUsers = await loadGist();
    Object.assign(ACCOUNTS, gistUsers);
    console.log('[Bot] Total authorized users:', Object.keys(ACCOUNTS).length);
}

function getUserConfig(chatId) {
    return ACCOUNTS[chatId] || null;
}

// ─── Telegram Helpers ────────────────────────────────────────────────────────

async function sendTelegram(text, chatId = CHAT_ID) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
        });
        const data = await res.json();
        if (!data.ok) console.error('[Telegram] Error:', data.description);
        else console.log('[Telegram] Message sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send:', e.message);
    }
}

async function sendTelegramPhoto(photoPath, caption, chatId = CHAT_ID) {
    try {
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('caption', caption);
        const buffer = fs.readFileSync(photoPath);
        const blob = new Blob([buffer], { type: 'image/png' });
        formData.append('photo', blob, 'screenshot.png');
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
        const res = await fetch(url, { method: 'POST', body: formData });
        const data = await res.json();
        if (!data.ok) console.error('[Telegram] Photo error:', data.description);
        else console.log('[Telegram] Photo sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send photo:', e.message);
    }
}

async function getTelegramUpdates(offset) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=30&offset=${offset}`;
        const res = await fetch(url);
        const data = await res.json();
        if (!data.ok) return [];
        return data.result || [];
    } catch (e) {
        console.error('[Telegram] getUpdates error:', e.message);
        return [];
    }
}

// ─── Time Helper ─────────────────────────────────────────────────────────────

function getDelayMsUntil(timeStr) {
    if (!timeStr) return 0;
    const now = new Date();
    const match = timeStr.match(/(\d{1,2})[\.:] ?(\d{2})\s*(AM|PM|am|pm)?/i);
    if (!match) return 0;

    let hours = parseInt(match[1], 10);
    const mins = parseInt(match[2], 10);
    const isPM = match[3] && match[3].toLowerCase() === 'pm';
    const isAM = match[3] && match[3].toLowerCase() === 'am';

    if (isPM && hours < 12) hours += 12;
    if (isAM && hours === 12) hours = 0;

    const target = new Date(now);
    target.setHours(hours, mins, 0, 0);
    let diff = target.getTime() - now.getTime();
    if (diff < 0) {
        target.setDate(target.getDate() + 1);
        diff = target.getTime() - now.getTime();
    }
    return diff;
}

// ─── Booking Logic ────────────────────────────────────────────────────────────

async function runBookingOnPage(page, targetKeyword, targetTime, silent = false, chatId = CHAT_ID) {
    console.log(`[Bot] Navigating to Event Booking page...`);
    await page.goto('https://learner.saveetha.in/academicevents/event-booking/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    // Check if session expired — if redirected to login page, re-login
    const currentUrl = page.url();
    if (currentUrl.includes('/login')) {
        console.log('[Bot] Session expired — re-logging in...');
        const config = page._userConfig;
        await doLogin(page, config.user, config.pass);
        await page.goto('https://learner.saveetha.in/academicevents/event-booking/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
    }

    console.log(`[Bot] Scanning for slots matching: "${targetKeyword}"${targetTime ? ` at "${targetTime}"` : ''}...`);

    const evaluation = await page.evaluate((params) => {
        const { kw, time } = params;
        const results = [];
        const allAvailable = [];
        const allClickable = document.querySelectorAll('a, button, input[type="button"], input[type="submit"]');
        const btns = Array.from(allClickable).filter(el => {
            if (el.offsetParent === null) return false;
            const text = (el.innerText || el.value || el.textContent || '').trim().toLowerCase();
            return text === 'book' || text === 'book now' || text === 'register' ||
                   text === 'book slot' || text === 'enroll' ||
                   text.startsWith('book') || text.includes('waitlist');
        });

        function normalize(str) {
            if (!str) return '';
            return str.toLowerCase()
                .replace(/[^a-z0-9\s]/g, '')
                .replace(/\s+/g, ' ')
                .replace(/(\d)(am|pm)/g, '$1 $2')
                .trim();
        }

        function extractStartTime(normalizedText) {
            const match = normalizedText.match(/\b(\d{1,2})\s*(am|pm)\b/);
            if (!match) return '';
            return match[1] + ' ' + match[2];
        }

        const kwNorm = normalize(kw);
        const timeNorm = normalize(time);

        for (let i = 0; i < btns.length; i++) {
            const btn = btns[i];
            let current = btn;
            let card = null;
            for (let d = 0; d < 10; d++) {
                if (!current || current === document.body) break;
                current = current.parentElement;
                if (!current) break;
                const hasHeading = current.querySelector('h1,h2,h3,h4,h5,strong,b,[class*="title"],[class*="heading"]');
                const rect = current.getBoundingClientRect();
                if (hasHeading && rect.height > 50 && rect.height < 2500) {
                    card = current;
                    break;
                }
            }

            const fullTextRaw = card ? card.innerText : btn.innerText;
            const fullTextNorm = normalize(fullTextRaw);
            const btnText = (btn.innerText || btn.value || '').trim().toLowerCase();
            const isWaitlist = btnText.includes('waitlist');

            let summary = fullTextRaw.replace(/\n+/g, ' | ').trim();
            if (summary.length > 80) summary = summary.substring(0, 80) + '...';
            allAvailable.push(summary);

            // Get the title/heading text separately for smarter matching
            const titleEl = card ? card.querySelector('h1,h2,h3,h4,h5,strong,b,[class*="title"],[class*="heading"]') : null;
            const titleTextNorm = normalize(titleEl ? titleEl.innerText : '');

            // Use whole-word regex so "world" doesn't match "real-world" or "worldwide"
            const kwWords = kwNorm.split(' ').filter(Boolean);
            function wholeWordMatch(text, words) {
                return words.every(w => new RegExp('\\b' + w + '\\b').test(text));
            }

            // Prioritize title match; fall back to full card text
            let matchKeyword = !kwNorm || wholeWordMatch(titleTextNorm, kwWords) || wholeWordMatch(fullTextNorm, kwWords);

            let matchTime = true;
            if (timeNorm) {
                const startTime = extractStartTime(fullTextNorm);
                matchTime = startTime === timeNorm;
            }

            if (matchKeyword && matchTime) {
                results.push({ index: i, fullText: fullTextNorm, isWaitlist });
            }
        }
        return { slotsFound: results, availableSlots: [...new Set(allAvailable)] };
    }, { kw: targetKeyword, time: targetTime });

    const slotsFound = evaluation.slotsFound;
    const availableSlots = evaluation.availableSlots;

    if (slotsFound.length === 0) {
        console.log('[Bot] No slot found.');
        if (!silent) {
            const availableMsg = availableSlots.length > 0
                ? `\n\n*Available Slots:*\n` + availableSlots.map(s => `- ${s}`).join('\n')
                : '\n\nNo slots are currently available on the page.';
            await sendTelegram(`⚠️ No slot found for *"${targetKeyword}"*${targetTime ? ` at *${targetTime}*` : ''}.${availableMsg}`, chatId);
        }
        return false;
    }

    console.log(`[Bot] Match found: ${slotsFound[0].fullText.substring(0, 60)}...`);

    const tagged = await page.evaluate((targetData) => {
        document.querySelectorAll('[data-saveetha-btn],[data-saveetha-input]').forEach(el => {
            el.removeAttribute('data-saveetha-btn');
            el.removeAttribute('data-saveetha-input');
        });

        const allClickable = document.querySelectorAll('a, button, input[type="button"], input[type="submit"]');
        const btns = Array.from(allClickable).filter(el => {
            if (el.offsetParent === null) return false;
            const text = (el.innerText || el.value || el.textContent || '').trim().toLowerCase();
            return text === 'book' || text === 'book now' || text === 'register' ||
                   text === 'book slot' || text === 'enroll' ||
                   text.startsWith('book') || text.includes('waitlist');
        });

        const btn = btns[targetData.index];
        if (!btn) return { success: false, reason: 'Button vanished' };

        let current = btn;
        let card = null;
        for (let d = 0; d < 10; d++) {
            if (!current || current === document.body) break;
            current = current.parentElement;
            if (!current) break;
            const hasHeading = current.querySelector('h1,h2,h3,h4,h5,strong,b,[class*="title"],[class*="heading"]');
            const rect = current.getBoundingClientRect();
            if (hasHeading && rect.height > 50 && rect.height < 2500) {
                card = current;
                break;
            }
        }

        btn.setAttribute('data-saveetha-btn', 'target');
        let purposeFound = false;
        if (card) {
            const inputs = card.querySelectorAll('input[type="text"], textarea, input:not([type])');
            for (const inp of inputs) {
                if (inp.offsetParent === null) continue;
                const p = (inp.placeholder || '').toLowerCase();
                const n = (inp.getAttribute('name') || '').toLowerCase();
                const a = (inp.getAttribute('aria-label') || '').toLowerCase();
                if (p.includes('purpose') || p.includes('reason') || p.includes('attend') ||
                    n.includes('purpose') || a.includes('purpose')) {
                    inp.setAttribute('data-saveetha-input', 'purpose');
                    purposeFound = true;
                    break;
                }
            }
            if (!purposeFound) {
                const inputs2 = card.querySelectorAll('input[type="text"], textarea, input:not([type])');
                for (const inp of inputs2) {
                    if (inp.offsetParent !== null) {
                        inp.setAttribute('data-saveetha-input', 'purpose');
                        purposeFound = true;
                        break;
                    }
                }
            }
        }
        return { success: true, purposeFound };
    }, slotsFound[0]);

    if (!tagged.success) {
        await sendTelegram(`⚠️ Found the slot but failed to tag it: ${tagged.reason}`);
        return;
    }

    const bookBtn = page.locator('[data-saveetha-btn="target"]');
    await bookBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    if (tagged.purposeFound) {
        const purposeInput = page.locator('[data-saveetha-input="purpose"]');
        console.log('[Bot] Filling purpose input...');
        await purposeInput.scrollIntoViewIfNeeded();
        await purposeInput.click({ force: true });
        await page.waitForTimeout(400);
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.waitForTimeout(200);
        await purposeInput.pressSequentially('To attend as part of academic curriculum', { delay: 50 });
        await page.waitForTimeout(600);
    }

    console.log('[Bot] Clicking Book Now...');
    await bookBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await bookBtn.click({ force: true });
    console.log('[Bot] Book Now clicked!');
    await page.waitForTimeout(2000);

    // Handle confirmation modals
    try {
        const swal2Confirm = page.locator('.swal2-confirm');
        if (await swal2Confirm.count() > 0) {
            console.log('[Bot] SweetAlert2 confirm found — clicking...');
            await swal2Confirm.first().click();
            await page.waitForTimeout(1500);
        } else {
            const modalBtns = page.locator('.modal button, [role="dialog"] button, .swal-button');
            const count = await modalBtns.count();
            for (let i = 0; i < count; i++) {
                const t = (await modalBtns.nth(i).innerText().catch(() => '')).toLowerCase().trim();
                if (t === 'ok' || t === 'confirm' || t === 'yes' || t === 'book') {
                    console.log(`[Bot] Modal button "${t}" — clicking...`);
                    await modalBtns.nth(i).click();
                    await page.waitForTimeout(1500);
                    break;
                }
            }
        }
    } catch (modalErr) {
        console.log('[Bot] Modal check:', modalErr.message);
    }

    await page.waitForTimeout(1500);
    const finalUrl = page.url();
    console.log(`[Bot] Final URL: ${finalUrl}`);

    const actionStr = slotsFound[0].isWaitlist ? '📋 Waitlisted' : '✅ Booked';
    const tmpPath = path.join(__dirname, '_tmp_screenshot.png');
    await page.screenshot({ path: tmpPath, fullPage: false });
    await sendTelegramPhoto(
        tmpPath,
        `${actionStr} Successfully!\n\n🎯 Slot: ${targetKeyword}${targetTime ? ` at ${targetTime}` : ''}\n🔗 URL: ${finalUrl}\n\nBooking complete! 🎉`,
        chatId
    );
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return true;
}

async function runUnbookingOnPage(page, targetKeyword, targetTime, chatId = CHAT_ID) {
    console.log(`[Bot] Navigating to Event Booking page for Unbooking...`);
    await page.goto('https://learner.saveetha.in/academicevents/event-booking/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    const currentUrl = page.url();
    if (currentUrl.includes('/login')) {
        await doLogin(page);
        await page.goto('https://learner.saveetha.in/academicevents/event-booking/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
    }

    console.log(`[Bot] Scanning for slots to CANCEL: "${targetKeyword}"...`);

    const evaluation = await page.evaluate((params) => {
        const { kw, time } = params;
        const results = [];
        const allClickable = document.querySelectorAll('a, button, input[type="button"], input[type="submit"]');
        
        const btns = Array.from(allClickable).filter(el => {
            if (el.offsetParent === null) return false;
            const text = (el.innerText || el.value || el.textContent || '').trim().toLowerCase();
            return text === 'cancel' || text === 'unbook' || text === 'remove' || text === 'withdraw' || text.includes('cancel');
        });

        function normalize(str) {
            if (!str) return '';
            return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        }

        const kwNorm = normalize(kw);

        for (let i = 0; i < btns.length; i++) {
            const btn = btns[i];
            let current = btn;
            let card = null;
            for (let d = 0; d < 10; d++) {
                if (!current || current === document.body) break;
                current = current.parentElement;
                if (!current) break;
                const hasHeading = current.querySelector('h1,h2,h3,h4,h5,strong,b,[class*="title"],[class*="heading"]');
                if (hasHeading) { card = current; break; }
            }

            const fullTextNorm = normalize(card ? card.innerText : btn.innerText);
            if (fullTextNorm.includes(kwNorm)) {
                results.push({ index: i, fullText: fullTextNorm });
            }
        }
        return { slotsFound: results };
    }, { kw: targetKeyword, time: targetTime });

    if (evaluation.slotsFound.length === 0) {
        await sendTelegram(`⚠️ Could not find any booked slot matching *"${targetKeyword}"* to cancel.`, chatId);
        return;
    }

    // Click the cancel button
    const tagged = await page.evaluate((targetData) => {
        const allClickable = document.querySelectorAll('a, button, input[type="button"], input[type="submit"]');
        const btns = Array.from(allClickable).filter(el => {
            if (el.offsetParent === null) return false;
            const text = (el.innerText || el.value || el.textContent || '').trim().toLowerCase();
            return text === 'cancel' || text === 'unbook' || text === 'remove' || text === 'withdraw' || text.includes('cancel');
        });
        const btn = btns[targetData.index];
        if (!btn) return false;
        btn.setAttribute('data-saveetha-cancel', 'true');
        return true;
    }, evaluation.slotsFound[0]);

    if (tagged) {
        console.log('[Bot] Clicking Cancel/Unbook...');
        await page.locator('[data-saveetha-cancel="true"]').click({ force: true });
        await page.waitForTimeout(2000);

        // Handle confirmation
        try {
            const confirmBtn = page.locator('.swal2-confirm, .modal button:has-text("Yes"), .modal button:has-text("Confirm")');
            if (await confirmBtn.count() > 0) {
                await confirmBtn.first().click();
                await page.waitForTimeout(2000);
            }
        } catch (e) {}

        const tmpPath = path.join(__dirname, '_cancel_screenshot.png');
        await page.screenshot({ path: tmpPath });
        await sendTelegramPhoto(tmpPath, `🛑 *Slot Cancelled Successfully!*\n\n🎯 Slot: ${targetKeyword}\n\nCancellation complete.`, chatId);
        try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function doLogin(page, user, pass) {
    console.log(`[Bot] Logging in as ${user}...`);
    await page.goto('https://learner.saveetha.in/login', { waitUntil: 'networkidle', timeout: 60000 });

    // Try multiple selectors for the username field
    const userSelectors = [
        'input[name="uid"]',
        'input[name="username"]',
        '#username',
        'input[type="text"]',
        'input[placeholder*="user" i]',
        'input[placeholder*="id" i]',
        'input[placeholder*="roll" i]'
    ];

    let userInput = null;
    for (const sel of userSelectors) {
        try {
            await page.waitForSelector(sel, { timeout: 5000, state: 'visible' });
            userInput = page.locator(sel).first();
            break;
        } catch (_) {}
    }

    if (!userInput) throw new Error('Could not find username input on login page.');

    // Fill using React-compatible method
    await userInput.click({ force: true });
    await userInput.fill('');
    await userInput.type(user, { delay: 50 });

    const passInput = page.locator('input[type="password"]').first();
    await passInput.click({ force: true });
    await passInput.fill('');
    await passInput.type(pass, { delay: 50 });

    // Click login button
    const loginSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Login")',
        'button:has-text("Sign in")',
        'button:has-text("Log in")'
    ];

    let clicked = false;
    for (const sel of loginSelectors) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.count() > 0) {
                await btn.click({ force: true });
                clicked = true;
                break;
            }
        } catch (_) {}
    }
    if (!clicked) await page.keyboard.press('Enter');

    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => null);
    console.log('[Bot] Logged in. Current URL:', page.url());
}

// ─── Timetable Scraper ───────────────────────────────────────────────────────

/**
 * Scrapes today's schedule from people_schedule page.
 * Returns an array of { slot, venue, timeStr, hour, minute } sorted by time.
 */
async function fetchTimetable(context, config) {
    const page = await context.newPage();
    try {
        console.log(`[Timetable] Fetching schedule for ${config.name}...`);
        await page.goto('https://learner.saveetha.in/academics/people_schedule/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        // If redirected to login, re-login
        if (page.url().includes('/login')) {
            console.log(`[Timetable] Session expired for ${config.name} — re-logging in...`);
            await doLogin(page, config.user, config.pass);
            await page.goto('https://learner.saveetha.in/academics/people_schedule/', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
        }

        // Wait for table/schedule content
        await page.waitForTimeout(3000);

        const slots = await page.evaluate(() => {
            const results = [];
            const today = new Date();
            const todayStr = today.toLocaleDateString('en-IN', { weekday: 'long' }).toLowerCase();
            const todayDate = today.toISOString().split('T')[0]; // YYYY-MM-DD

            function parseTime(timeText) {
                if (!timeText) return null;
                // Match patterns like "9:00 AM", "09:00", "9.00AM"
                const m = timeText.match(/(\d{1,2})[\.:](\d{2})\s*(AM|PM|am|pm)?/i);
                if (!m) return null;
                let h = parseInt(m[1], 10);
                const min = parseInt(m[2], 10);
                const period = (m[3] || '').toLowerCase();
                if (period === 'pm' && h < 12) h += 12;
                if (period === 'am' && h === 12) h = 0;
                return { hour: h, minute: min, timeStr: timeText.trim() };
            }

            // ── Strategy 0: Saveetha people_schedule labeled-card format (PRIMARY) ──
            // Cards look like:
            //   19MA201 – Calculus and Matrix Algebra
            //   SLOT : 25EJ2150
            //   01:00 PM - 02:59 PM
            //   VENUE : 5613
            // We find elements containing "VENUE :" and extract the value after the colon.
            const allEls = Array.from(document.querySelectorAll('*'));
            const venueEls = allEls.filter(el => {
                const txt = (el.innerText || '').trim();
                return /VENUE\s*:/i.test(txt) && txt.length < 200;
            });

            for (const venueEl of venueEls) {
                const venueText = (venueEl.innerText || '')
                    .replace(/.*VENUE\s*:\s*/i, '')
                    .split('\n')[0]
                    .trim();
                if (!venueText) continue;

                // Walk up to card container (must have SLOT: and AM/PM time)
                let card = venueEl.parentElement;
                for (let d = 0; d < 8; d++) {
                    if (!card || card === document.body) break;
                    const ct = card.innerText || '';
                    if (/SLOT\s*:/i.test(ct) && /(AM|PM)/i.test(ct)) break;
                    card = card.parentElement;
                }
                if (!card || card === document.body) continue;

                const cardText = card.innerText || '';
                const lines = cardText.split('\n').map(l => l.trim()).filter(Boolean);

                // Subject = first line that is not a label or time line
                const subject = lines.find(l =>
                    l.length > 5 &&
                    !/^SLOT\s*:/i.test(l) &&
                    !/^VENUE\s*:/i.test(l) &&
                    !/(AM|PM)/i.test(l)
                ) || 'Class';

                // Time = first line containing AM or PM
                const timeLine = lines.find(l => /(AM|PM)/i.test(l));
                const timeInfo = timeLine ? parseTime(timeLine) : null;
                if (!timeInfo) continue;

                results.push({ slot: subject, venue: venueText, ...timeInfo, hasToday: true });
            }

            // ── Strategy 1: Table rows (fallback) ─────────────────────────────────
            const tables = document.querySelectorAll('table');
            for (const table of tables) {
                const rows = table.querySelectorAll('tr');

                // First pass: detect which column index is the venue column from headers
                let venueColIndex = -1;
                let slotColIndex = -1;
                let timeColIndex = -1;
                const headerRow = table.querySelector('tr:first-child');
                if (headerRow) {
                    const headers = Array.from(headerRow.querySelectorAll('th, td'))
                        .map(c => c.innerText.trim().toLowerCase());
                    headers.forEach((h, i) => {
                        if (/venue|location|room|place|hall/i.test(h)) venueColIndex = i;
                        if (/slot|subject|course|class|title|module/i.test(h)) slotColIndex = i;
                        if (/time|period|hour/i.test(h)) timeColIndex = i;
                    });
                }

                for (const row of rows) {
                    const cells = Array.from(row.querySelectorAll('td, th')).map(c => c.innerText.trim());
                    if (cells.length < 2) continue;
                    const rowText = cells.join(' ').toLowerCase();

                    // Skip header rows
                    if (row.querySelectorAll('th').length === cells.length) continue;

                    // Check if this row relates to today (day name or date)
                    const hasToday = rowText.includes(todayStr) || rowText.includes(todayDate) ||
                        rowText.includes(today.getDate() + '/');

                    let timeInfo = null;
                    let slot = '';
                    let venue = '';

                    // Use detected column indices if available
                    if (venueColIndex >= 0 && venueColIndex < cells.length) {
                        venue = cells[venueColIndex];
                    }
                    if (slotColIndex >= 0 && slotColIndex < cells.length) {
                        slot = cells[slotColIndex];
                    }
                    if (timeColIndex >= 0 && timeColIndex < cells.length) {
                        timeInfo = parseTime(cells[timeColIndex]);
                    }

                    // Fallback: scan all cells for time, slot, venue heuristically
                    if (!timeInfo || !slot) {
                        for (let i = 0; i < cells.length; i++) {
                            const t = parseTime(cells[i]);
                            if (t && !timeInfo) { timeInfo = t; continue; }
                            // Broadened venue keywords: also catch names like AB1, MB Block, IT Dept, B1, etc.
                            if (!venue && /hall|room|lab|block|floor|dept|building|wing|annex|\bab\b|\bmb\b|\bit\b|\b[a-z]?\d{1,4}\b/i.test(cells[i]) && cells[i].length < 60) {
                                venue = cells[i];
                            } else if (!slot && cells[i].length > 3 && cells[i].length < 120 && i > 0) {
                                slot = cells[i];
                            }
                        }
                        // Last resort: if still no venue, grab the last unused cell
                        if (!venue && cells.length >= 3) {
                            for (let i = cells.length - 1; i >= 0; i--) {
                                const c = cells[i];
                                if (c && c !== slot && !parseTime(c) && c.length < 80) {
                                    venue = c;
                                    break;
                                }
                            }
                        }
                    }

                    if (timeInfo && slot) {
                        results.push({ slot, venue: venue || 'N/A', ...timeInfo, hasToday });
                    }
                }
            }

            // ── Strategy 2: Generic class/schedule divs (last resort) ─────────────
            if (results.length === 0) {
                const cards = document.querySelectorAll(
                    '[class*="schedule"], [class*="timetable"], [class*="slot"], [class*="class"], [class*="period"], [class*="event"]'
                );
                for (const card of cards) {
                    const text = card.innerText || '';
                    const timeMatch = text.match(/(\d{1,2})[.:] ?(\d{2})\s*(AM|PM)/i);
                    if (!timeMatch) continue;
                    const t = parseTime(timeMatch[0]);
                    if (!t) continue;
                    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
                    // Prefer labeled fields if present
                    const vLabel = lines.find(l => /^VENUE\s*:/i.test(l));
                    const sLabel = lines.find(l => /^SLOT\s*:/i.test(l));
                    const venue = vLabel
                        ? vLabel.replace(/^VENUE\s*:\s*/i, '').trim()
                        : (lines.find(l => /hall|room|lab|block|floor|dept/i.test(l) && l !== lines[0]) || 'N/A');
                    const slot = sLabel
                        ? sLabel.replace(/^SLOT\s*:\s*/i, '').trim()
                        : (lines.find(l => l.length > 5 && !/(AM|PM)/i.test(l)) || 'Class');
                    results.push({ slot, venue, ...t, hasToday: true });
                }
            }

            // Deduplicate by time+slot and sort
            const seen = new Set();
            const deduped = results.filter(r => {
                const key = `${r.hour}:${r.minute}-${r.slot}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            return deduped.sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));
        });

        console.log(`[Timetable] Found ${slots.length} slots for ${config.name}`);
        return slots;
    } catch (err) {
        console.error(`[Timetable] Error fetching for ${config.name}:`, err.message);
        return [];
    } finally {
        await page.close().catch(() => {});
    }
}

/**
 * Format timetable slots into a readable Telegram message.
 */
function formatTimetable(slots, name) {
    const today = new Date().toLocaleDateString('en-IN', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
    if (!slots || slots.length === 0) {
        return `📅 *Good Morning ${name}!*\n\n*Today's Timetable (${today})*\n\n✅ No classes scheduled today. Enjoy your day! 🎉`;
    }
    let msg = `📅 *Good Morning ${name}!*\n\n*Today's Timetable — ${today}*\n${'─'.repeat(30)}\n\n`;
    for (const s of slots) {
        const h = s.hour % 12 || 12;
        const period = s.hour < 12 ? 'AM' : 'PM';
        const minStr = String(s.minute).padStart(2, '0');
        const venueDisplay = (s.venue && s.venue !== 'N/A') ? s.venue : 'N/A (Check Portal)';
        msg += `🕐 *${h}:${minStr} ${period}*\n`;
        msg += `📚 ${s.slot}\n`;
        msg += `📍 Venue: *${venueDisplay}*\n\n`;
    }
    msg += `_Have a productive day! 💪_`;
    return msg;
}

// ─── Timetable Scheduler ─────────────────────────────────────────────────────

/**
 * Starts per-user timetable schedulers:
 *   1. Daily 8:00 AM → send full timetable
 *   2. 15 min before each slot → send reminder
 *
 * Uses India Standard Time (IST = UTC+5:30).
 */
function startTimetableSchedulers(userSessions) {
    console.log('[Scheduler] Starting timetable schedulers for all users...');

    // Helper: ms until next HH:MM in IST
    function msUntilIST(targetHour, targetMin) {
        const now = new Date();
        // IST offset in ms = +5h30m = 19800000
        const IST_OFFSET = 5.5 * 60 * 60 * 1000;
        const nowIST = new Date(now.getTime() + IST_OFFSET);
        const target = new Date(nowIST);
        target.setUTCHours(targetHour, targetMin, 0, 0);
        let diff = target.getTime() - nowIST.getTime();
        if (diff <= 0) {
            target.setUTCDate(target.getUTCDate() + 1);
            diff = target.getTime() - nowIST.getTime();
        }
        return diff;
    }

    // Schedule the 8 AM daily timetable for every user
    for (const [chatId, session] of userSessions.entries()) {
        scheduleDailyTimetable(chatId, session);
        
        // --- Immediate Check on Startup ---
        // If the bot starts after 8 AM (e.g. after a restart), 
        // we still want to schedule reminders for the rest of today.
        (async () => {
            try {
                console.log(`[Scheduler] Initializing today's reminders for ${session.config.name}...`);
                const slots = await fetchTimetable(session.context, session.config);
                scheduleSlotReminders(chatId, session, slots);
            } catch (e) {
                console.error(`[Scheduler] Startup check failed for ${session.config.name}:`, e.message);
            }
        })();
    }

    function scheduleDailyTimetable(chatId, session) {
        const delay = msUntilIST(8, 0); // 8:00 AM IST
        const delayMin = Math.round(delay / 60000);
        console.log(`[Scheduler] Daily timetable for ${session.config.name} in ${delayMin} min`);

        setTimeout(async () => {
            await sendDailyTimetable(chatId, session);
            // Schedule again for the next day
            scheduleDailyTimetable(chatId, session);
        }, delay);
    }

    async function sendDailyTimetable(chatId, session) {
        try {
            console.log(`[Scheduler] Sending 8 AM timetable to ${session.config.name}...`);
            const slots = await fetchTimetable(session.context, session.config);
            const msg = formatTimetable(slots, session.config.name);
            await sendTelegram(msg, chatId);

            // Schedule 15-min reminders for each slot today
            scheduleSlotReminders(chatId, session, slots);
        } catch (err) {
            console.error(`[Scheduler] Failed to send timetable to ${session.config.name}:`, err.message);
        }
    }

    function scheduleSlotReminders(chatId, session, slots) {
        if (!slots || slots.length === 0) return;
        const IST_OFFSET = 5.5 * 60 * 60 * 1000;

        for (const s of slots) {
            const now = new Date();
            const nowIST = new Date(now.getTime() + IST_OFFSET);

            // Build the slot's start time in UTC today (IST - offset)
            const slotIST = new Date(nowIST);
            slotIST.setUTCHours(s.hour, s.minute, 0, 0);

            // Reminder = 15 minutes before slot
            const reminderTime = slotIST.getTime() - 15 * 60 * 1000;
            const delay = reminderTime - nowIST.getTime();

            if (delay <= 0) {
                console.log(`[Scheduler] Skipping past slot: ${s.slot} at ${s.hour}:${s.minute}`);
                continue;
            }

            const delayMin = Math.round(delay / 60000);
            console.log(`[Scheduler] Reminder for "${s.slot}" in ${delayMin} min (${session.config.name})`);

            setTimeout(async () => {
                try {
                    const h = s.hour % 12 || 12;
                    const period = s.hour < 12 ? 'AM' : 'PM';
                    const minStr = String(s.minute).padStart(2, '0');
                    const venueDisplay = (s.venue && s.venue !== 'N/A') ? s.venue : '(Venue not found — check timetable)';
                    const msg =
                        `⏰ *Class Reminder — 15 Minutes!*\n\n` +
                        `📚 *${s.slot}*\n` +
                        `🕐 Starts at: *${h}:${minStr} ${period}*\n` +
                        `📍 Venue: *${venueDisplay}*\n\n` +
                        `_Get ready! Class starts in 15 minutes. 🚀_`;
                    await sendTelegram(msg, chatId);
                    console.log(`[Scheduler] Reminder sent for "${s.slot}" (venue: ${venueDisplay}) to ${session.config.name}`);
                } catch (err) {
                    console.error(`[Scheduler] Reminder error:`, err.message);
                }
            }, delay);
        }
    }

    console.log('[Scheduler] All timetable schedulers started.');
}

async function spawnUserSession(browser, chatId, config) {
    try {
        console.log(`[Bot] Spawning session for ${config.name} (${chatId})...`);
        const userContext = await browser.newContext();
        const hotPage = await userContext.newPage();
        
        await doLogin(hotPage, config.user, config.pass);
        
        console.log(`[Bot] Preparing Hot Tab for ${config.name}...`);
        await hotPage.goto('https://learner.saveetha.in/academicevents/event-booking/', { 
            waitUntil: 'networkidle', 
            timeout: 60000 
        });
        
        const session = { 
            context: userContext, 
            config, 
            persistentPage: hotPage,
            isBusy: false 
        };
        USER_SESSIONS.set(chatId, session);

        // Start specific scheduler
        scheduleDailyTimetableForUser(chatId, session);
        (async () => {
            try {
                const slots = await fetchTimetable(session.context, session.config);
                scheduleSlotReminders(chatId, session, slots);
            } catch (e) {}
        })();

        console.log(`[Bot] Session Ready: ${config.name}`);
        return true;
    } catch (err) {
        console.error(`[Bot] Failed to spawn session for ${config.name}:`, err.message);
        return false;
    }
}

// Extract these from the original function so they can be called individually
function scheduleDailyTimetableForUser(chatId, session) {
    const delay = msUntilIST(8, 0); 
    setTimeout(async () => {
        await sendDailyTimetable(chatId, session);
        scheduleDailyTimetableForUser(chatId, session);
    }, delay);
}

function msUntilIST(targetHour, targetMin) {
    const now = new Date();
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(now.getTime() + IST_OFFSET);
    const target = new Date(nowIST);
    target.setUTCHours(targetHour, targetMin, 0, 0);
    let diff = target.getTime() - nowIST.getTime();
    if (diff <= 0) {
        target.setUTCDate(target.getUTCDate() + 1);
        diff = target.getTime() - nowIST.getTime();
    }
    return diff;
}

async function sendDailyTimetable(chatId, session) {
    try {
        const slots = await fetchTimetable(session.context, session.config);
        const msg = formatTimetable(slots, session.config.name);
        await sendTelegram(msg, chatId);
        scheduleSlotReminders(chatId, session, slots);
    } catch (err) {}
}

function scheduleSlotReminders(chatId, session, slots) {
    if (!slots || slots.length === 0) return;
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    for (const s of slots) {
        const now = new Date();
        const nowIST = new Date(now.getTime() + IST_OFFSET);
        const slotIST = new Date(nowIST);
        slotIST.setUTCHours(s.hour, s.minute, 0, 0);
        const reminderTime = slotIST.getTime() - 15 * 60 * 1000;
        const delay = reminderTime - nowIST.getTime();
        if (delay <= 0) continue;
        setTimeout(async () => {
            try {
                const h = s.hour % 12 || 12;
                const period = s.hour < 12 ? 'AM' : 'PM';
                const minStr = String(s.minute).padStart(2, '0');
                const venueDisplay = (s.venue && s.venue !== 'N/A') ? s.venue : 'N/A (Check Portal)';
                const msg = 
                    `⏰ *Class Reminder — 15 Minutes!*\n\n` +
                    `📚 *${s.slot}*\n` +
                    `🕐 Starts at: *${h}:${minStr} ${period}*\n` +
                    `📍 Venue: *${venueDisplay}*\n\n` +
                    `_Get ready! Class starts in 15 minutes. 🚀_`;
                await sendTelegram(msg, chatId);
            } catch (err) {}
        }, delay);
    }
}

// ─── Main: Persistent Bot Loop ────────────────────────────────────────────────

async function main() {
    if (!SAVEETHA_USER || !SAVEETHA_PASS || !TELEGRAM_BOT_TOKEN || !CHAT_ID) {
        console.error('[Bot] Missing required environment variables!');
        process.exit(1);
    }

    // Launch browser ONCE and keep it alive
    console.log('[Bot] Launching multi-user browser...');
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    // Pre-login each user and keep a "Hot Tab" ready on the booking page
    await initAccounts();
    
    for (const [chatId, config] of Object.entries(ACCOUNTS)) {
        await spawnUserSession(browser, chatId, config);
    }

    // Optional: Keep-alive loop to prevent sessions from timing out
    setInterval(async () => {
        for (const [chatId, session] of USER_SESSIONS.entries()) {
            if (!session.isBusy) {
                try {
                    // Just refresh or check if still on booking page every 10 mins
                    if (!session.persistentPage.url().includes('event-booking')) {
                        await session.persistentPage.goto('https://learner.saveetha.in/academicevents/event-booking/', { waitUntil: 'domcontentloaded' });
                    }
                } catch (e) {}
            }
        }
    }, 600000); // Every 10 mins

    // ── Start Timetable Schedulers for all users ──────────────────────────────
    // (Note: Handled inside spawnUserSession now)

    await sendTelegram(`✅ *Saveetha Bot is Online!* (Hot Tab Mode)\nAll ${USER_SESSIONS.size} accounts have a tab open and ready on the booking page.\n📅 Daily timetable at *8:00 AM IST* + 15-min class reminders are active!`);

    // Track active bookings
    let activeTasks = new Map(); // taskId -> { keyword, targetTime, startTime, phase, stopRequested, page }
    let taskIdCounter = 0;

    // Poll Telegram for messages
    let offset = 0;
    console.log('[Bot] Polling Telegram for commands...');

    while (true) {
        try {
            const updates = await getTelegramUpdates(offset);

            for (const update of updates) {
                offset = update.update_id + 1;

                const msg = update.message || update.channel_post;
                if (!msg || !msg.text) continue;

                // Check if user is authorized
                const fromChatId = String(msg.chat.id);
                const userConfig = getUserConfig(fromChatId);
                
                if (!userConfig) {
                    console.log(`[Bot] Ignoring message from unauthorized chat: ${fromChatId}`);
                    // Optional: await sendTelegram(`⚠️ Your Chat ID (${fromChatId}) is not authorized for this bot.`);
                    continue;
                }

                const text = msg.text.trim().toLowerCase();

                // ── !help ─────────────────────────────────────────────────
                if (text === '!help' || text === '/start') {
                    let helpMsg = 
                        `📖 *Saveetha Bot Help*\n\n` +
                        `*Booking Commands:*\n` +
                        `\`!book <keyword>\` — Book immediately\n` +
                        `\`!book <keyword> @ 10:00 AM\` — Target specific time\n` +
                        `\`!book <keyword> # 06:00 PM\` — Start scanning at 6 PM IST\n` +
                        `\`!scan <keyword>\` — Scan every 30s until found\n` +
                        `\`!unbook <keyword>\` — Cancel a booked slot\n\n` +
                        `*Timetable Commands:*\n` +
                        `\`!timetable\` or \`!tt\` — Get today's schedule\n\n` +
                        `*System Commands:*\n` +
                        `\`!status\` — Check if bot is alive\n` +
                        `\`!progress\` — View active tasks\n` +
                        `\`!stop <keyword>\` — Stop a specific task\n` +
                        `\`!stop all\` — Stop everything\n`;

                    if (fromChatId === ADMIN_CHAT_ID) {
                        helpMsg += `\n*👑 Admin Commands:*\n` +
                                   `\`!adduser <id> <user> <pass> <name>\` — Add user\n` +
                                   `\`!removeuser <id>\` — Remove user\n` +
                                   `\`!listusers\` — Show all users\n`;
                    }
                    
                    helpMsg += `\n_Tip: Use "all" with !stop to clear the queue._`;
                    await sendTelegram(helpMsg, fromChatId);
                    continue;
                }

                // ── !status ──────────────────────────────────────────────
                if (text === '!status') {
                    const count = activeTasks.size;
                    await sendTelegram(`✅ Bot is running and logged in.\n${count > 0 ? `⏳ Currently processing ${count} booking(s).` : '🟢 Ready to book!'}`, fromChatId);
                    continue;
                }

                // ── !progress ─────────────────────────────────────────────
                if (text === '!progress') {
                    if (activeTasks.size === 0) {
                        await sendTelegram(`🟢 *No active bookings.*\nBot is idle and ready.`, fromChatId);
                    } else {
                        let statusMsg = `⏳ *Active Bookings (${activeTasks.size})*\n\n`;
                        activeTasks.forEach((task, id) => {
                            statusMsg += `🔹 *${task.keyword}*\n` +
                                         `📍 Phase: ${task.phase}\n` +
                                         `${task.targetTime ? `🕐 Target: ${task.targetTime}\n` : ''}` +
                                         `${task.startTime ? `⏱️ Start: ${task.startTime}\n` : ''}\n`;
                        });
                        statusMsg += `_To stop one: !stop <keyword>_`;
                        await sendTelegram(statusMsg, fromChatId);
                    }
                    continue;
                }

                // ── !stop ─────────────────────────────────────────────────
                if (text.toLowerCase().startsWith('!stop')) {
                    const arg = text.substring(5).trim().toLowerCase();
                    
                    if (activeTasks.size === 0) {
                        await sendTelegram(`🟢 No active bookings to stop.`);
                        continue;
                    }

                    if (arg === 'all') {
                        activeTasks.forEach(task => task.stopRequested = true);
                        await sendTelegram(`🛑 *Stopping all tasks...*`);
                    } else if (arg) {
                        let found = false;
                        activeTasks.forEach((task, id) => {
                            if (task.keyword.toLowerCase().includes(arg)) {
                                task.stopRequested = true;
                                found = true;
                            }
                        });
                        if (found) await sendTelegram(`🛑 Stop requested for tasks matching: *${arg}*`);
                        else await sendTelegram(`⚠️ No active task found for: *${arg}*`);
                    } else {
                        // Stop the most recent one
                        const lastId = Array.from(activeTasks.keys()).pop();
                        const task = activeTasks.get(lastId);
                        task.stopRequested = true;
                        await sendTelegram(`🛑 Stopping most recent task: *${task.keyword}*`);
                    }
                    continue;
                }

                // 👑 ADMIN COMMANDS
                if (fromChatId === ADMIN_CHAT_ID) {
                    if (text.startsWith('!adduser')) {
                        const parts = text.split(' ').filter(Boolean);
                        if (parts.length < 5) {
                            await sendTelegram(`Format: \`!adduser <chatId> <user> <pass> <name>\``, ADMIN_CHAT_ID);
                            continue;
                        }
                        const nId = parts[1], nU = parts[2], nP = parts[3], nName = parts.slice(4).join(' ');
                        const newConfig = { user: nU, pass: nP, name: nName };
                        
                        await sendTelegram(`⏳ Adding ${nName}...`, ADMIN_CHAT_ID);
                        const success = await spawnUserSession(browser, nId, newConfig);
                        if (success) {
                            const dynamicUsers = await loadGist();
                            dynamicUsers[nId] = newConfig;
                            await updateGist(dynamicUsers);
                            ACCOUNTS[nId] = newConfig;
                            await sendTelegram(`✅ Added ${nName} successfully!`, ADMIN_CHAT_ID);
                            await sendTelegram(`🎉 Welcome ${nName}! Your account is now connected. Try \`!help\` to begin.`, nId);
                        } else {
                            await sendTelegram(`❌ Failed to login ${nName}. Check credentials.`, ADMIN_CHAT_ID);
                        }
                        continue;
                    }

                    if (text.startsWith('!removeuser')) {
                        const parts = text.split(' ');
                        const rId = parts[1];
                        if (!rId) return;
                        
                        const session = USER_SESSIONS.get(rId);
                        if (session) {
                            await session.persistentPage.close().catch(() => {});
                            await session.context.close().catch(() => {});
                            USER_SESSIONS.delete(rId);
                        }
                        
                        const dynamicUsers = await loadGist();
                        delete dynamicUsers[rId];
                        await updateGist(dynamicUsers);
                        delete ACCOUNTS[rId];
                        
                        await sendTelegram(`🛑 Removed user ${rId}.`, ADMIN_CHAT_ID);
                        continue;
                    }

                    if (text === '!listusers') {
                        let list = `👥 *Authorized Users*\n\n`;
                        for (const [id, config] of Object.entries(ACCOUNTS)) {
                            const status = USER_SESSIONS.has(id) ? '🟢 Online' : '🔴 Offline';
                            list += `• *${config.name}* (\`${id}\`)\n  └ User: ${config.user} | ${status}\n\n`;
                        }
                        await sendTelegram(list, ADMIN_CHAT_ID);
                        continue;
                    }
                }
                if (text === '!timetable' || text === '!tt') {
                    const session = USER_SESSIONS.get(fromChatId);
                    if (!session) {
                        await sendTelegram(`❌ Session not found. Please restart the bot.`, fromChatId);
                        continue;
                    }
                    await sendTelegram(`⏳ Fetching your timetable, please wait...`, fromChatId);
                    try {
                        const slots = await fetchTimetable(session.context, session.config);
                        const msg = formatTimetable(slots, session.config.name);
                        await sendTelegram(msg, fromChatId);
                    } catch (err) {
                        await sendTelegram(`❌ Failed to fetch timetable: ${err.message}`, fromChatId);
                    }
                    continue;
                }

                // ── !book / !unbook / !scan ──────────────────────────────
                const isUnbook = text.toLowerCase().startsWith('!unbook');
                const isScan = text.toLowerCase().startsWith('!scan');
                if (!text.toLowerCase().startsWith('!book') && !isUnbook && !isScan) continue;

                // Parse command
                let keyword = text.substring(isUnbook ? 7 : (isScan ? 5 : 5)).trim();
                let targetTime = '';
                let startTime = '';

                if (keyword.includes('#')) {
                    const parts = keyword.split('#');
                    keyword = parts[0].trim();
                    startTime = parts[1].trim();
                }
                if (keyword.includes('@')) {
                    const parts = keyword.split('@');
                    keyword = parts[0].trim();
                    targetTime = parts[1].trim();
                }

                if (!keyword) {
                    await sendTelegram(`⚠️ Please provide a keyword. Example: \`!book CAT\``, fromChatId);
                    continue;
                }

                const taskId = ++taskIdCounter;
                const task = { 
                    keyword, targetTime, startTime, 
                    phase: 'Initializing', 
                    stopRequested: false,
                    page: null 
                };
                activeTasks.set(taskId, task);

                console.log(`[Bot] New Task [${taskId}]: !book "${keyword}"${targetTime ? ` @ ${targetTime}` : ''}${startTime ? ` # ${startTime}` : ''}`);

                // Run booking in background (don't block the poll loop)
                (async () => {
                    let taskPage = null;
                    try {
                        if (startTime) {
                            const delayMs = getDelayMsUntil(startTime);
                            if (delayMs > 0) {
                                const delayMins = Math.round(delayMs / 60000);
                                await sendTelegram(`⏱️ *Timer Active [${keyword}]*\nWaiting ${delayMins} min(s) until ${startTime}.\n_You can still start other bookings!_`, fromChatId);
                                task.phase = `Waiting until ${startTime}`;
                                const endTime = Date.now() + delayMs;
                                while (Date.now() < endTime) {
                                    if (task.stopRequested) break;
                                    await new Promise(resolve => setTimeout(resolve, 2000));
                                }
                            }
                        }

                        if (task.stopRequested) {
                            await sendTelegram(`🛑 Task *${keyword}* was cancelled.`, fromChatId);
                            return;
                        }

                        // Get user's pre-authenticated session
                        const session = USER_SESSIONS.get(fromChatId);
                        if (!session) {
                            await sendTelegram(`❌ Session not found. Please restart the bot.`, fromChatId);
                            return;
                        }

                        // Use the "Hot Tab" if it's not busy, otherwise open a temporary one
                        let isUsingPersistent = false;
                        if (!session.isBusy) {
                            taskPage = session.persistentPage;
                            session.isBusy = true;
                            isUsingPersistent = true;
                            console.log(`[Bot] Using Hot Tab for ${userConfig.name}`);
                        } else {
                            taskPage = await session.context.newPage();
                            console.log(`[Bot] Hot Tab busy, opened temp tab for ${userConfig.name}`);
                        }

                        taskPage._userConfig = userConfig;
                        task.page = taskPage;

                        await sendTelegram(`🚀 *Booking has started!* (Using ${isUsingPersistent ? 'Hot Tab' : 'New Tab'})\n🎯 Slot: *${keyword}*${targetTime ? ` at *${targetTime}*` : ''}\nPlease wait...`, fromChatId);
                        
                        if (isScan) {
                            let scanCount = 1;
                            while (!task.stopRequested) {
                                task.phase = `Scanning (Check #${scanCount})`;
                                if (scanCount === 1) await sendTelegram(`🔎 *Scanning Mode Active* for *${keyword}*\nChecking every 30 seconds... Use !stop to cancel.`, fromChatId);
                                
                                const success = await runBookingOnPage(taskPage, keyword, targetTime, true, fromChatId);
                                if (success) break;
                                
                                scanCount++;
                                // Wait 30 seconds before next scan
                                for (let i = 0; i < 15; i++) {
                                    if (task.stopRequested) break;
                                    await new Promise(r => setTimeout(r, 2000));
                                }
                                if (task.stopRequested) break;
                            }
                        } else if (isUnbook) {
                            task.phase = 'Cancelling slot';
                            await sendTelegram(`⏳ Processing Cancellation for *${keyword}*...`, fromChatId);
                            await runUnbookingOnPage(taskPage, keyword, targetTime, fromChatId);
                        } else {
                            task.phase = 'Booking on portal';
                            await sendTelegram(`⏳ Processing Booking for *${keyword}*...`, fromChatId);
                            await runBookingOnPage(taskPage, keyword, targetTime, false, fromChatId);
                        }
                    } catch (err) {
                        console.error(`[Bot] Task ${taskId} Error:`, err.message);
                        await sendTelegram(`❌ Error [${keyword}]: ${err.message}`, fromChatId);
                    } finally {
                        const session = USER_SESSIONS.get(fromChatId);
                        if (taskPage) {
                            if (session && taskPage === session.persistentPage) {
                                session.isBusy = false;
                                await taskPage.goto('https://learner.saveetha.in/academicevents/event-booking/').catch(() => {});
                            } else {
                                await taskPage.close().catch(() => {});
                            }
                        }
                        activeTasks.delete(taskId);
                    }
                })();
            }
        } catch (pollErr) {
            console.error('[Bot] Poll error:', pollErr.message);
        }

        // Small pause between polls (getUpdates uses long-polling of 30s already)
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

main().catch(async (err) => {
    console.error('[Bot] Fatal error:', err);
    await sendTelegram(`❌ *Bot crashed:* ${err.message}`).catch(() => {});
    process.exit(1);
});
