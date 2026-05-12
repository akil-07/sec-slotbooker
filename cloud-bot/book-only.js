const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SAVEETHA_USER = process.env.SAVEETHA_USER;
const SAVEETHA_PASS = process.env.SAVEETHA_PASS;
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON;

// Parse accounts mapping
let ACCOUNTS = {};
try {
    if (ACCOUNTS_JSON) {
        ACCOUNTS = JSON.parse(ACCOUNTS_JSON);
        console.log('[Bot] Loaded accounts for chat IDs:', Object.keys(ACCOUNTS).join(', '));
    } else {
        console.warn('[Bot] ACCOUNTS_JSON not set — falling back to single user.');
        // Fallback to single user if JSON not provided
        ACCOUNTS[CHAT_ID] = {
            user: SAVEETHA_USER,
            pass: SAVEETHA_PASS,
            name: 'Primary User'
        };
        console.log('[Bot] Single user fallback, chat ID:', CHAT_ID);
    }
} catch (e) {
    console.error('[Bot] Failed to parse ACCOUNTS_JSON:', e.message);
    console.error('[Bot] Raw ACCOUNTS_JSON value:', ACCOUNTS_JSON);
}

function getUserConfig(chatId) {
    return ACCOUNTS[chatId] || null;
}

// ─── Telegram Helpers ────────────────────────────────────────────────────────

async function sendTelegram(text) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' })
        });
        const data = await res.json();
        if (!data.ok) console.error('[Telegram] Error:', data.description);
        else console.log('[Telegram] Message sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send:', e.message);
    }
}

async function sendTelegramPhoto(photoPath, caption) {
    try {
        const formData = new FormData();
        formData.append('chat_id', CHAT_ID);
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

async function runBookingOnPage(page, targetKeyword, targetTime, silent = false) {
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

            let matchKeyword = !kwNorm || fullTextNorm.includes(kwNorm);
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
            await sendTelegram(`⚠️ No slot found for *"${targetKeyword}"*${targetTime ? ` at *${targetTime}*` : ''}.${availableMsg}`);
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
        `${actionStr} Successfully!\n\n🎯 Slot: ${targetKeyword}${targetTime ? ` at ${targetTime}` : ''}\n🔗 URL: ${finalUrl}\n\nBooking complete! 🎉`
    );
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return true;
}

async function runUnbookingOnPage(page, targetKeyword, targetTime) {
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
        await sendTelegram(`⚠️ Could not find any booked slot matching *"${targetKeyword}"* to cancel.`);
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
        await sendTelegramPhoto(tmpPath, `🛑 *Slot Cancelled Successfully!*\n\n🎯 Slot: ${targetKeyword}\n\nCancellation complete.`);
        try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function doLogin(page, user, pass) {
    console.log(`[Bot] Logging in as ${user}...`);
    await page.goto('https://learner.saveetha.in/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[type="text"], input[name="uid"], #username', { timeout: 15000 });

    const userInputs = await page.$$('input[type="text"], input[name="uid"], #username');
    if (userInputs.length > 0) await userInputs[0].fill(user);

    const passInputs = await page.$$('input[type="password"]');
    if (passInputs.length > 0) await passInputs[0].fill(pass);

    const loginBtns = await page.$$('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in")');
    if (loginBtns.length > 0) await loginBtns[0].click();
    else await page.keyboard.press('Enter');

    await page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => null);
    console.log('[Bot] Logged in successfully. Current URL:', page.url());
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
    const context = await browser.newContext();

    console.log('[Bot] Polling Telegram for commands...');
    await sendTelegram(`✅ *Saveetha Multi-User Bot is Online!*\nReady to handle multiple accounts.`);

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

                const text = msg.text.trim();

                // ── !status ──────────────────────────────────────────────
                if (text === '!status') {
                    const count = activeTasks.size;
                    await sendTelegram(`✅ Bot is running and logged in.\n${count > 0 ? `⏳ Currently processing ${count} booking(s).` : '🟢 Ready to book!'}`);
                    continue;
                }

                // ── !progress ─────────────────────────────────────────────
                if (text === '!progress') {
                    if (activeTasks.size === 0) {
                        await sendTelegram(`🟢 *No active bookings.*\nBot is idle and ready.`);
                    } else {
                        let statusMsg = `⏳ *Active Bookings (${activeTasks.size})*\n\n`;
                        activeTasks.forEach((task, id) => {
                            statusMsg += `🔹 *${task.keyword}*\n` +
                                         `📍 Phase: ${task.phase}\n` +
                                         `${task.targetTime ? `🕐 Target: ${task.targetTime}\n` : ''}` +
                                         `${task.startTime ? `⏱️ Start: ${task.startTime}\n` : ''}\n`;
                        });
                        statusMsg += `_To stop one: !stop <keyword>_`;
                        await sendTelegram(statusMsg);
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
                    await sendTelegram(`⚠️ Please provide a keyword. Example: \`!book CAT\``);
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
                                await sendTelegram(`⏱️ *Timer Active [${keyword}]*\nWaiting ${delayMins} min(s) until ${startTime}.\n_You can still start other bookings!_`);
                                task.phase = `Waiting until ${startTime}`;
                                const endTime = Date.now() + delayMs;
                                while (Date.now() < endTime) {
                                    if (task.stopRequested) break;
                                    await new Promise(resolve => setTimeout(resolve, 2000));
                                }
                            }
                        }

                        if (task.stopRequested) {
                            await sendTelegram(`🛑 Task *${keyword}* was cancelled.`);
                            return;
                        }

                        taskPage = await context.newPage();
                        taskPage._userConfig = userConfig; // Attach config to page for expiry handling
                        task.page = taskPage;

                        // Perform login for this specific task page
                        await doLogin(taskPage, userConfig.user, userConfig.pass);
                        
                        if (isScan) {
                            let scanCount = 1;
                            while (!task.stopRequested) {
                                task.phase = `Scanning (Check #${scanCount})`;
                                if (scanCount === 1) await sendTelegram(`🔎 *Scanning Mode Active* for *${keyword}*\nChecking every 60 seconds...`);
                                
                                const success = await runBookingOnPage(taskPage, keyword, targetTime, true);
                                if (success) break;
                                
                                scanCount++;
                                // Wait 60 seconds before next scan
                                for (let i = 0; i < 30; i++) {
                                    if (task.stopRequested) break;
                                    await new Promise(r => setTimeout(r, 2000));
                                }
                                if (task.stopRequested) break;
                            }
                        } else if (isUnbook) {
                            task.phase = 'Cancelling slot';
                            await sendTelegram(`⏳ Processing Cancellation for *${keyword}*...`);
                            await runUnbookingOnPage(taskPage, keyword, targetTime);
                        } else {
                            task.phase = 'Booking on portal';
                            await sendTelegram(`⏳ Processing Booking for *${keyword}*...`);
                            await runBookingOnPage(taskPage, keyword, targetTime);
                        }
                    } catch (err) {
                        console.error(`[Bot] Task ${taskId} Error:`, err.message);
                        await sendTelegram(`❌ Error [${keyword}]: ${err.message}`);
                    } finally {
                        if (taskPage) await taskPage.close().catch(() => {});
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
