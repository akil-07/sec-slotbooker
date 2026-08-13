// =============================================
//  Saveetha Schedule OTP Bot — Telegram Edition
//  Monitors class schedule, alerts 10 min before
//  class start/end, detects OTP windows, asks
//  for OTP via Telegram, submits it, sends screenshot
// =============================================

'use strict';

// ── Fix Playwright temp dir BEFORE requiring playwright ──────────────────────
const os = require('os');
const validTemp = 'C:\\Users\\akils\\AppData\\Local\\Temp';
process.env.TEMP = validTemp;
process.env.TMP  = validTemp;

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ─── Config ─────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID   = String(process.env.CHAT_ID);
const ADMIN_USER      = process.env.SAVEETHA_USER;
const ADMIN_PASS      = process.env.SAVEETHA_PASS;

if (!TELEGRAM_TOKEN || !ADMIN_CHAT_ID || !ADMIN_USER || !ADMIN_PASS) {
    console.error('[FATAL] Missing required env vars. Check your .env file.');
    process.exit(1);
}

// ─── User Storage ─────────────────────────────────────────────────────────────
const USERS_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error('Error loading users.json:', e.message);
    }
    return {};
}

function saveUsers(users) {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (e) {
        console.error('Error saving users.json:', e.message);
    }
}

// Get all users including admin
function getAllUsers() {
    const users = loadUsers();
    // Add admin to the list dynamically (overwrites if admin is in JSON, which is fine)
    users[ADMIN_CHAT_ID] = {
        saveethaUser: ADMIN_USER,
        saveethaPass: ADMIN_PASS,
        isAdmin: true
    };
    return users;
}

// ─── Telegram Bot ─────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Pending OTP callbacks: Map<chatId, resolve fn>
const pendingOtpCallbacks = new Map();

// Scheduled timers: kept so we can clear on re-fetch
const activeTimers = {}; // Map of chatId -> array of timeouts

// ─── Helpers ──────────────────────────────────────────────────────────────────
function log(msg) {
    const ts = new Date().toLocaleTimeString('en-IN', { hour12: false });
    console.log(`[${ts}] ${msg}`);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function sendTelegram(chatId, text) {
    try {
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (e) {
        log(`[Telegram] Send error for ${chatId}: ${e.message}`);
    }
}

async function sendScreenshotToTelegram(page, caption, chatId) {
    const tmpPath = path.join(__dirname, `_otp_screenshot_${Date.now()}.png`);
    try {
        await page.screenshot({ path: tmpPath, fullPage: false });
        await bot.sendPhoto(chatId, tmpPath, { caption });
        log(`[Telegram] Screenshot sent to ${chatId}.`);
    } catch (e) {
        log(`[Telegram] Screenshot error for ${chatId}: ${e.message}`);
        await sendTelegram(chatId, `📸 Could not send screenshot: ${e.message}`);
    } finally {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
}

const SCHEDULE_URL    = 'https://learner.saveetha.in/academics/people_schedule/';
const LOGIN_URL       = 'https://learner.saveetha.in/';
const ALERT_BEFORE_MS = 10 * 60 * 1000; // 10 minutes

// ─── Browser helpers ──────────────────────────────────────────────────────────
async function launchBrowser() {
    log('[Browser] Launching Chrome...');
    return chromium.launch({
        headless: false,
        channel: 'chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
}

function isLoginPage(url) {
    return url.includes('/login') ||
           url.includes('/authorize') ||
           url.includes('/accounts/') ||
           url.includes('/account/');
}

async function doLogin(page, user, pass) {
    log(`[Login] Entering credentials for ${user}...`);
    try {
        await page.waitForSelector(
            'input[type="text"], input[name="uid"], #username, input[type="email"]',
            { timeout: 15000 }
        );
    } catch (_) {}

    // Fill username
    const userInput = page.locator(
        'input[type="text"], input[name="uid"], #username, input[type="email"]'
    ).first();
    await userInput.fill(String(user)).catch(() => {});

    // Fill password
    const passInput = page.locator('input[type="password"]').first();
    await passInput.fill(String(pass)).catch(() => {});

    // Click login
    const loginBtn = page.locator(
        'button[type="submit"], input[type="submit"],' +
        'button:has-text("Login"), button:has-text("Sign in"), button:has-text("Log in")'
    ).first();

    const loginBtnCount = await loginBtn.count();
    if (loginBtnCount > 0) {
        await loginBtn.click();
    } else {
        await page.keyboard.press('Enter');
    }

    // Wait for navigation away from login page
    try {
        await page.waitForURL(
            u => !isLoginPage(u.href),
            { timeout: 20000 }
        );
    } catch (_) {}

    await sleep(1000);
    log('[Login] Done. Current URL: ' + page.url());
}

async function ensureLoggedIn(page, user, pass) {
    if (isLoginPage(page.url())) {
        await doLogin(page, user, pass);
    }
}

// ─── Schedule Parsing ─────────────────────────────────────────────────────────
async function fetchTodaySchedule(page, user, pass) {
    log(`[Schedule] Navigating to schedule page for ${user}...`);
    await page.goto(SCHEDULE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await ensureLoggedIn(page, user, pass);

    if (isLoginPage(page.url())) {
        throw new Error('Still on login page after login attempt.');
    }

    // Re-navigate after login if needed
    if (!page.url().includes('people_schedule')) {
        await page.goto(SCHEDULE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    await sleep(3000); // let dynamic content render

    // Take screenshot to help debug
    const debugPath = path.join(__dirname, '_schedule_debug.png');
    await page.screenshot({ path: debugPath }).catch(() => {});
    log(`[Schedule] Debug screenshot saved: ${debugPath}`);

    const rawText = await page.evaluate(() => document.body.innerText).catch(() => '');
    log(`[Schedule] Page text preview: ${rawText.substring(0, 300).replace(/\n/g, ' | ')}`);

    // ── The schedule page shows a weekly calendar view.
    //    Today's column is highlighted. Each class entry under it is a div block with:
    //      - Bold subject name (e.g. "19CS570 – Entrepreneurship and Small Business Development")
    //      - SLOT : 26OD1160
    //      - Time range: "10:00 AM - 11:59 AM"
    //      - VENUE : Not Available
    //      - Button: "VIEW ATTENDANCE" or "VIEW EVENT"
    // ────────────────────────────────────────────────────────────────────────────

    const classes = await page.evaluate(() => {
        const results = [];

        function parseTimeRange(text) {
            // Match: "10:00 AM - 11:59 AM" or "1:00 PM - 2:59 PM" or "10:00-11:00"
            const m = text.match(
                /(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*[-–—]\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i
            );
            if (!m) return null;
            return { start: m[1].trim(), end: m[2].trim() };
        }

        // ── Strategy 1: Find all "VIEW ATTENDANCE" / "VIEW EVENT" buttons
        //    and walk up to their containing card div ──────────────────────────
        const viewBtns = Array.from(document.querySelectorAll('a, button, input[type="button"]')).filter(el => {
            if (el.offsetParent === null) return false;
            const t = (el.innerText || el.value || '').trim().toUpperCase();
            return t === 'VIEW ATTENDANCE' || t === 'VIEW EVENT' || t.startsWith('VIEW');
        });

        for (const btn of viewBtns) {
            // Walk up to find a card-like container
            let card = null;
            let el = btn;
            for (let i = 0; i < 12; i++) {
                el = el.parentElement;
                if (!el || el === document.body) break;
                const rect = el.getBoundingClientRect();
                // A reasonable card: tall enough to contain name+time+button
                if (rect.height > 60 && rect.height < 600 && rect.width > 100) {
                    const hasTime = parseTimeRange(el.innerText || '');
                    if (hasTime) { card = el; break; }
                }
            }

            if (!card) continue;

            const cardText  = card.innerText || '';
            const timeRange = parseTimeRange(cardText);
            if (!timeRange) continue;

            // Extract subject name: first long line that isn't SLOT/VENUE/time/button
            const lines = cardText.split('\n').map(l => l.trim()).filter(l => l.length > 3);
            let name = '';
            for (const line of lines) {
                if (
                    !line.match(/^\d{1,2}:\d{2}/) &&
                    !line.toUpperCase().startsWith('SLOT') &&
                    !line.toUpperCase().startsWith('VENUE') &&
                    !line.toUpperCase().startsWith('TYPE') &&
                    !line.toUpperCase().startsWith('PURPOSE') &&
                    !line.toUpperCase().startsWith('CANCELLATION') &&
                    !line.toUpperCase().startsWith('VIEW') &&
                    !line.toUpperCase().startsWith('FEEDBACK')
                ) {
                    name = line;
                    break;
                }
            }

            // Extract SLOT number
            const slotMatch = cardText.match(/SLOT\s*:\s*(\S+)/i);
            const slot = slotMatch ? slotMatch[1] : '';

            // Get the view href (if it's an anchor tag)
            const viewHref = btn.tagName === 'A' ? (btn.getAttribute('href') || null) : null;
            const btnLabel = (btn.innerText || '').trim();

            results.push({
                name:      name.substring(0, 120) || `Class ${slot}`,
                slot,
                startTime: timeRange.start,
                endTime:   timeRange.end,
                viewHref:  viewHref ? (viewHref.startsWith('http') ? viewHref : 'https://learner.saveetha.in' + viewHref) : null,
                btnLabel,
                cardText:  cardText.replace(/\n+/g, ' | ').substring(0, 300),
            });
        }

        // ── Strategy 2 fallback: scan all divs for time ranges ─────────────
        if (results.length === 0) {
            const allEls = Array.from(document.querySelectorAll('div, li, article, section'));
            for (const el of allEls) {
                // Only direct containers (not large wrappers)
                const childDivs = el.querySelectorAll('div');
                if (childDivs.length > 20) continue;
                const text = el.innerText || '';
                const timeRange = parseTimeRange(text);
                if (!timeRange) continue;
                const viewBtn = [...el.querySelectorAll('a, button')].find(b => {
                    const t = (b.innerText || '').trim().toUpperCase();
                    return t.startsWith('VIEW');
                });
                const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
                const name = lines.find(l =>
                    !l.match(/^\d{1,2}:\d{2}/) &&
                    !l.toUpperCase().startsWith('SLOT') &&
                    !l.toUpperCase().startsWith('VENUE') &&
                    !l.toUpperCase().startsWith('VIEW')
                ) || '';
                const href = viewBtn && viewBtn.tagName === 'A' ? viewBtn.getAttribute('href') : null;
                results.push({
                    name:      name.substring(0, 120),
                    slot:      '',
                    startTime: timeRange.start,
                    viewHref:  href ? (href.startsWith('http') ? href : 'https://learner.saveetha.in' + href) : null,
                    btnLabel:  viewBtn ? (viewBtn.innerText || '').trim() : '',
                    cardText:  text.replace(/\n+/g, ' | ').substring(0, 300),
                });
            }
        }

        // ── Deduplicate by name+startTime ───────────────────────────────────
        const seen = new Set();
        return results.filter(c => {
            const key = `${c.name}|${c.startTime}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

    }, { todayDMY, todayISO, todayShort });

    log(`[Schedule] Parsed ${classes.length} class(es) today.`);
    classes.forEach((c, i) =>
        log(`  [${i + 1}] "${c.name}" | ${c.startTime} – ${c.endTime} | href=${c.viewHref}`)
    );

    return classes;
}

// ─── Time Parsing ─────────────────────────────────────────────────────────────
function parseTimeToday(timeStr) {
    if (!timeStr) return null;
    const now = new Date();

    // Normalise separators and whitespace
    const cleaned = timeStr.replace(/\./g, ':').replace(/\s+/g, '').toUpperCase();

    // 12h with colon: "9:30AM"
    const m12c = cleaned.match(/^(\d{1,2}):(\d{2})(AM|PM)$/);
    if (m12c) {
        let h = parseInt(m12c[1], 10);
        const min = parseInt(m12c[2], 10);
        if (m12c[3] === 'PM' && h !== 12) h += 12;
        if (m12c[3] === 'AM' && h === 12) h = 0;
        const d = new Date(now); d.setHours(h, min, 0, 0); return d;
    }

    // 12h no colon: "9AM"
    const m12 = cleaned.match(/^(\d{1,2})(AM|PM)$/);
    if (m12) {
        let h = parseInt(m12[1], 10);
        if (m12[2] === 'PM' && h !== 12) h += 12;
        if (m12[2] === 'AM' && h === 12) h = 0;
        const d = new Date(now); d.setHours(h, 0, 0, 0); return d;
    }

    // 24h with colon: "14:30"
    const m24 = cleaned.match(/^(\d{1,2}):(\d{2})$/);
    if (m24) {
        const d = new Date(now);
        d.setHours(parseInt(m24[1], 10), parseInt(m24[2], 10), 0, 0);
        return d;
    }

    // 24h no colon: "1430"
    const m24n = cleaned.match(/^(\d{2})(\d{2})$/);
    if (m24n) {
        const d = new Date(now);
        d.setHours(parseInt(m24n[1], 10), parseInt(m24n[2], 10), 0, 0);
        return d;
    }

    return null;
}

// ─── OTP Window Detection ─────────────────────────────────────────────────────
/**
 * Polls the page every 3s for a visible OTP input modal.
 * Returns true if found within timeoutMs, false otherwise.
 */
async function waitForOtpWindow(page, timeoutMs = 15 * 60 * 1000) {
    log('[OTP] Polling for OTP window...');
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const found = await page.evaluate(() => {
                // 1. Explicit OTP-named containers
                const otpContainers = document.querySelectorAll(
                    '[class*="otp" i], [id*="otp" i], [class*="attendance" i],' +
                    '[class*="verify" i], .modal, [role="dialog"], .swal2-container,' +
                    '.popup, .overlay'
                );
                for (const c of otpContainers) {
                    if (c.offsetParent === null && !document.body.contains(c)) continue;
                    const style = window.getComputedStyle(c);
                    if (style.display === 'none' || style.visibility === 'hidden') continue;
                    // Must contain an input
                    const inp = c.querySelector('input[type="text"], input[type="number"], input[maxlength]');
                    if (inp && inp.offsetParent !== null) return true;
                }

                // 2. Any visible input that smells like OTP
                const inputs = document.querySelectorAll(
                    'input[maxlength="6"], input[maxlength="4"], input[maxlength="8"]'
                );
                for (const inp of inputs) {
                    if (inp.offsetParent === null) continue;
                    return true;
                }

                // 3. Any visible input with OTP-related text nearby
                const allInputs = document.querySelectorAll('input[type="text"], input[type="number"]');
                for (const inp of allInputs) {
                    if (inp.offsetParent === null) continue;
                    const placeholder = (inp.placeholder || '').toLowerCase();
                    const name       = (inp.name || inp.id || '').toLowerCase();
                    const container  = inp.closest('form, .modal, [role="dialog"], div');
                    const nearby     = (container ? container.innerText : '').toLowerCase();
                    if (
                        placeholder.includes('otp') || name.includes('otp') ||
                        nearby.includes('otp') || nearby.includes('one time') ||
                        nearby.includes('verify') || nearby.includes('attendance code') ||
                        (nearby.includes('enter') && nearby.includes('digit'))
                    ) return true;
                }
                return false;
            });

            if (found) {
                log('[OTP] OTP window DETECTED!');
                return true;
            }
        } catch (e) {
            log(`[OTP] Eval error: ${e.message}`);
        }
        await sleep(3000);
    }

    log('[OTP] Timeout — no OTP window appeared.');
    return false;
}

// ─── Ask User for OTP via Telegram ───────────────────────────────────────────
function askOtpViaTelegram(className, phase, chatId, timeoutMs = 5 * 60 * 1000) {
    return new Promise(async (resolve) => {
        const emoji = phase === 'start' ? '📥' : '📤';
        const label = phase === 'start' ? 'Entry' : 'Exit';
        await sendTelegram(chatId,
            `🔔 *OTP Window is Open!*\n\n` +
            `${emoji} *${label} OTP* for:\n*${className}*\n\n` +
            `Please reply with the *6-digit OTP* now:`
        );

        pendingOtpCallbacks.set(String(chatId), resolve);

        // Auto-expire
        setTimeout(() => {
            if (pendingOtpCallbacks.has(String(chatId))) {
                pendingOtpCallbacks.delete(String(chatId));
                resolve(null);
            }
        }, timeoutMs);
    });
}

// ─── Enter OTP on Page ────────────────────────────────────────────────────────
async function enterOtpOnPage(page, otp) {
    log(`[OTP] Entering OTP: ${otp}`);

    // Find the OTP input via Playwright locators (more reliable than evaluate)
    const otpInputSelectors = [
        'input[maxlength="6"]',
        'input[maxlength="4"]',
        'input[maxlength="8"]',
        '[class*="otp" i] input',
        '[id*="otp" i] input',
        '.modal input[type="text"]',
        '.modal input[type="number"]',
        '[role="dialog"] input[type="text"]',
        '[role="dialog"] input[type="number"]',
        '.swal2-container input',
        'input[placeholder*="OTP" i]',
        'input[placeholder*="otp" i]',
        'input[name*="otp" i]',
    ];

    let inputLocator = null;
    for (const sel of otpInputSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.count() > 0) {
            const visible = await loc.isVisible().catch(() => false);
            if (visible) {
                inputLocator = loc;
                log(`[OTP] Found input with selector: ${sel}`);
                break;
            }
        }
    }

    if (!inputLocator) {
        log('[OTP] Could not find OTP input field.');
        return { success: false, reason: 'OTP input not found' };
    }

    // Clear and fill
    await inputLocator.click();
    await inputLocator.fill('');
    await inputLocator.fill(otp);
    await sleep(500);

    // Find and click submit button
    const submitSelectors = [
        'button:has-text("Submit")', 'button:has-text("Confirm")',
        'button:has-text("Verify")', 'button:has-text("OK")',
        'button:has-text("Accept")', 'button:has-text("Attend")',
        'button:has-text("Enter")',
        '.swal2-confirm',
        '[class*="submit" i]', '[class*="confirm" i]',
        '.modal button[type="submit"]',
        '[role="dialog"] button[type="submit"]',
        'input[type="submit"]',
    ];

    for (const sel of submitSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
            await loc.click();
            log(`[OTP] Clicked submit: ${sel}`);
            return { success: true };
        }
    }

    // Last resort: press Enter
    await inputLocator.press('Enter');
    log('[OTP] Pressed Enter to submit.');
    return { success: true };
}

// ─── Class OTP Flow ───────────────────────────────────────────────────────────
async function handleClassOtp(classInfo, phase, userContext) {
    const { chatId, saveethaUser, saveethaPass } = userContext;
    const label = phase === 'start' ? 'Class Starting (Entry)' : 'Class Ending (Exit)';
    log(`[Flow] Starting ${label} OTP for: ${classInfo.name} (User: ${saveethaUser})`);

    await sendTelegram(chatId,
        `⏰ *10 minutes until ${phase === 'start' ? 'class starts' : 'class ends'}*\n\n` +
        `📚 *${classInfo.name}*\n` +
        `🕐 ${classInfo.startTime} – ${classInfo.endTime}\n\n` +
        `Opening class page and watching for OTP window...`
    );

    let browser = null;
    let page    = null;

    try {
        browser = await launchBrowser();
        const context = await browser.newContext();
        page = await context.newPage();

        // ── Navigate to schedule page ──────────────────────────────────────
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await ensureLoggedIn(page, saveethaUser, saveethaPass);

        // ── Click "View" for this class ────────────────────────────────────
        if (classInfo.viewHref) {
            log(`[Flow] Going directly to: ${classInfo.viewHref}`);
            await page.goto(classInfo.viewHref, { waitUntil: 'domcontentloaded', timeout: 20000 });
        } else {
            // Navigate to schedule and find the View link
            await page.goto(SCHEDULE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await sleep(2000);

            // Find View button near the class name
            const viewClicked = await page.evaluate((clsName) => {
                const links = Array.from(document.querySelectorAll('a, button'));
                for (const link of links) {
                    if (!/^view$/i.test((link.innerText || '').trim())) continue;
                    const row = link.closest('tr, .card, .list-group-item, li, div');
                    if (row && row.innerText.toLowerCase().includes(
                        clsName.toLowerCase().substring(0, 10)
                    )) {
                        link.click();
                        return true;
                    }
                }
                // Fallback: click first View link
                const first = links.find(l => /^view$/i.test((l.innerText || '').trim()));
                if (first) { first.click(); return true; }
                return false;
            }, classInfo.name);

            if (!viewClicked) {
                await sendTelegram(chatId,
                    `⚠️ Could not find the *View* button for *${classInfo.name}*.\n` +
                    `Please open it manually — I'll still watch for the OTP window.`
                );
            }
            await sleep(2000);
        }

        // ── Wait for OTP window (up to 15 minutes) ────────────────────────
        const otpFound = await waitForOtpWindow(page, 15 * 60 * 1000);

        if (!otpFound) {
            await sendTelegram(chatId,
                `ℹ️ No OTP window appeared for *${classInfo.name}* (${label}).\n` +
                `Moving on.`
            );
            return;
        }

        // Take "before" screenshot
        await sendScreenshotToTelegram(page, `📸 OTP window detected for ${classInfo.name}`, chatId);

        // ── Ask user for OTP ───────────────────────────────────────────────
        const otp = await askOtpViaTelegram(classInfo.name, phase, chatId, 5 * 60 * 1000);

        if (!otp) {
            await sendTelegram(chatId,
                `⚠️ OTP not received within 5 minutes for *${classInfo.name}*. Session expired.`
            );
            return;
        }

        // ── Enter OTP ─────────────────────────────────────────────────────
        const result = await enterOtpOnPage(page, otp);
        log(`[Flow] Enter result: ${JSON.stringify(result)}`);

        if (!result.success) {
            await sendTelegram(chatId, `⚠️ Could not enter OTP: ${result.reason}`);
            await sendScreenshotToTelegram(page, `⚠️ OTP entry failed for ${classInfo.name}`, chatId);
            return;
        }

        await sleep(2500);

        // ── Send confirmation screenshot ───────────────────────────────────
        await sendScreenshotToTelegram(
            page,
            `✅ OTP *${otp}* submitted for *${classInfo.name}* (${label})`,
            chatId
        );

        // Check for success text on page
        const confirmText = await page.evaluate(() => {
            const selectors = [
                '.alert', '.toast', '.message',
                '[class*="success" i]', '[class*="confirm" i]',
                '.swal2-popup', '[role="alert"]'
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.offsetParent !== null && el.innerText.trim().length > 0) {
                    return el.innerText.trim().substring(0, 200);
                }
            }
            return '';
        }).catch(() => '');

        if (confirmText) {
            await sendTelegram(chatId, `✅ *Confirmed!*\n\n"${confirmText}"`);
        } else {
            await sendTelegram(chatId, `✅ OTP submitted for *${classInfo.name}*.\nCheck the screenshot above for confirmation.`);
        }

    } catch (err) {
        log(`[Flow] Error: ${err.message}`);
        await sendTelegram(chatId, `❌ Error during OTP for *${classInfo.name}*:\n${err.message}`);
        if (page) {
            await sendScreenshotToTelegram(page, `❌ Error state for ${classInfo.name}`, chatId).catch(() => {});
        }
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// ─── Schedule Timers ──────────────────────────────────────────────────────────
function scheduleClassTimers(classes, userContext) {
    const { chatId } = userContext;
    // Clear old timers for this user
    if (activeTimers[chatId]) {
        while (activeTimers[chatId].length > 0) {
            clearTimeout(activeTimers[chatId].pop());
        }
    } else {
        activeTimers[chatId] = [];
    }

    const now = Date.now();
    let count = 0;

    for (const cls of classes) {
        const startDt = parseTimeToday(cls.startTime);
        const endDt   = parseTimeToday(cls.endTime);

        if (startDt) {
            const alertAt = startDt.getTime() - ALERT_BEFORE_MS;
            const delay   = alertAt - now;
            const minLeft = Math.round(delay / 60000);
            if (delay > 0) {
                log(`[Timer][${chatId}] "${cls.name}" START alert in ${minLeft} min (at ${startDt.toLocaleTimeString()})`);
                activeTimers[chatId].push(setTimeout(() => handleClassOtp(cls, 'start', userContext), delay));
                count++;
            } else {
                log(`[Timer][${chatId}] "${cls.name}" START time already passed.`);
            }
        }

        if (endDt) {
            const alertAt = endDt.getTime() - ALERT_BEFORE_MS;
            const delay   = alertAt - now;
            const minLeft = Math.round(delay / 60000);
            if (delay > 0) {
                log(`[Timer][${chatId}] "${cls.name}" END alert in ${minLeft} min (at ${endDt.toLocaleTimeString()})`);
                activeTimers[chatId].push(setTimeout(() => handleClassOtp(cls, 'end', userContext), delay));
                count++;
            } else {
                log(`[Timer][${chatId}] "${cls.name}" END time already passed.`);
            }
        }
    }

    return count;
}

// ─── Daily Re-fetch at Midnight ───────────────────────────────────────────────
function scheduleMidnightRefetch() {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 30, 0);
    const delay = next.getTime() - now.getTime();
    log(`[Scheduler] Next daily schedule fetch in ${Math.round(delay / 60000)} min`);
    setTimeout(async () => {
        await runDailyInit();
        scheduleMidnightRefetch();
    }, delay);
}

// ─── Daily Init ───────────────────────────────────────────────────────────────
async function runDailyInitForUser(userContext) {
    const { chatId, saveethaUser, saveethaPass } = userContext;
    log(`[Init] Running daily schedule fetch for ${saveethaUser} (${chatId})...`);
    await sendTelegram(chatId, '🔄 Fetching today\'s class schedule from Saveetha...');

    let browser = null;
    let page    = null;

    try {
        browser = await launchBrowser();
        const context = await browser.newContext();
        page = await context.newPage();

        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await ensureLoggedIn(page, saveethaUser, saveethaPass);

        const classes = await fetchTodaySchedule(page, saveethaUser, saveethaPass);
        await page.close();
        await browser.close();
        browser = null;

        if (classes.length === 0) {
            await sendTelegram(chatId,
                '📅 *No classes found for today.*\n\n' +
                'This could mean:\n' +
                '• No classes are scheduled today\n' +
                '• The schedule page layout could not be parsed\n\n' +
                'Use /schedule to retry, or /help for commands.'
            );
            return;
        }

        // Build schedule summary
        const today = new Date().toLocaleDateString('en-IN');
        let summary = `📅 *Today's Schedule* — ${today}\n\n`;
        classes.forEach((cls, i) => {
            summary += `${i + 1}. *${cls.name}*\n`;
            if (cls.startTime || cls.endTime) {
                summary += `   🕐 ${cls.startTime || '?'} → ${cls.endTime || '?'}\n`;
            }
            summary += '\n';
        });
        summary += `\n⏰ I will alert you *10 minutes before* each class starts and ends.`;
        await sendTelegram(chatId, summary);

        const timerCount = scheduleClassTimers(classes, userContext);
        await sendTelegram(chatId, `✅ *${timerCount} alert(s)* scheduled for today.`);

    } catch (err) {
        log(`[Init] Fatal error for ${chatId}: ${err.message}`);
        await sendTelegram(chatId, `❌ Schedule fetch failed:\n\`${err.message}\`\n\nUse /schedule to retry.`);
        if (page)    await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
}

async function runDailyInit() {
    log('[Init] Running global daily schedule fetch for all users...');
    const allUsers = getAllUsers();
    for (const [chatId, userData] of Object.entries(allUsers)) {
        await runDailyInitForUser({ chatId, ...userData });
        await sleep(5000); // Wait 5 seconds between users to avoid rate limiting / browser crashing
    }
    log('[Init] Global daily schedule fetch complete.');
}

// ─── Telegram Command Handler ─────────────────────────────────────────────────
bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text   = (msg.text || '').trim();

    log(`[Telegram] Message from ${chatId}: "${text}"`);

    // ── Pending OTP reply ──────────────────────────────────────────────────
    if (pendingOtpCallbacks.has(chatId)) {
        const digits = text.replace(/\D/g, '');
        if (digits.length >= 4 && digits.length <= 8) {
            const cb = pendingOtpCallbacks.get(chatId);
            pendingOtpCallbacks.delete(chatId);
            await sendTelegram(chatId, `✅ Got OTP: *${digits}* — entering now...`);
            cb(digits);
            return;
        } else {
            await bot.sendMessage(chatId, '⚠️ That doesn\'t look like a valid OTP (need 4–8 digits). Please try again:');
            return;
        }
    }

    // ── Check Access ───────────────────────────────────────────────────────
    const allUsers = getAllUsers();
    const isRegistered = !!allUsers[chatId];
    const isAdmin = chatId === ADMIN_CHAT_ID;

    // ── Commands ───────────────────────────────────────────────────────────
    if (text.toLowerCase() === '/myid') {
        return bot.sendMessage(chatId, `🆔 Your Telegram Chat ID is: \`${chatId}\`\n\nGive this to the admin to register your account.`, { parse_mode: 'Markdown' });
    }

    if (text.toLowerCase().startsWith('/adduser')) {
        if (!isAdmin) return bot.sendMessage(chatId, '⛔ Admin only command.');
        const parts = text.split(' ');
        if (parts.length < 4) return bot.sendMessage(chatId, 'Usage: `/adduser <chat_id> <saveetha_user> <saveetha_pass>`', { parse_mode: 'Markdown' });
        const targetChatId = parts[1];
        const targetUser = parts[2];
        const targetPass = parts[3];
        
        const users = loadUsers();
        users[targetChatId] = { saveethaUser: targetUser, saveethaPass: targetPass };
        saveUsers(users);
        
        await bot.sendMessage(chatId, `✅ Added user ${targetUser} with Chat ID ${targetChatId}. Fetching their schedule now...`);
        // Trigger fetch for this new user
        runDailyInitForUser({ chatId: targetChatId, saveethaUser: targetUser, saveethaPass: targetPass });
        return;
    }

    if (text.toLowerCase().startsWith('/removeuser')) {
        if (!isAdmin) return bot.sendMessage(chatId, '⛔ Admin only command.');
        const parts = text.split(' ');
        if (parts.length < 2) return bot.sendMessage(chatId, 'Usage: `/removeuser <chat_id>`', { parse_mode: 'Markdown' });
        const targetChatId = parts[1];
        
        const users = loadUsers();
        if (users[targetChatId]) {
            delete users[targetChatId];
            saveUsers(users);
            if (activeTimers[targetChatId]) {
                while (activeTimers[targetChatId].length > 0) clearTimeout(activeTimers[targetChatId].pop());
            }
            return bot.sendMessage(chatId, `✅ Removed user with Chat ID ${targetChatId}.`);
        } else {
            return bot.sendMessage(chatId, `⚠️ Chat ID ${targetChatId} not found.`);
        }
    }

    if (text.toLowerCase() === '/listusers') {
        if (!isAdmin) return bot.sendMessage(chatId, '⛔ Admin only command.');
        const users = getAllUsers();
        let msgStr = '👥 *Registered Users:*\n\n';
        for (const [uid, udata] of Object.entries(users)) {
            msgStr += `• ID: \`${uid}\` | User: ${udata.saveethaUser} ${udata.isAdmin ? '(Admin)' : ''}\n`;
        }
        return bot.sendMessage(chatId, msgStr, { parse_mode: 'Markdown' });
    }

    if (text.toLowerCase() === '/start' || text.toLowerCase() === '/help') {
        return bot.sendMessage(chatId, [
            '🎓 *Saveetha Schedule OTP Bot*',
            '',
            'I automatically:',
            '• Fetch your class schedule daily',
            '• Alert you 10 min before each class starts/ends',
            '• Watch for the OTP attendance window',
            '• Ask you for the OTP and submit it',
            '• Send you a screenshot of the result',
            '',
            '*User Commands:*',
            '/myid     — Get your Chat ID to give to the admin',
            isRegistered ? '/schedule — Re-fetch today\'s schedule now' : '',
            isRegistered ? '/status   — Show active alert count' : '',
            '/help     — Show this message',
            '',
            isAdmin ? '*Admin Commands:*' : '',
            isAdmin ? '/adduser <id> <user> <pass>' : '',
            isAdmin ? '/removeuser <id>' : '',
            isAdmin ? '/listusers' : ''
        ].filter(Boolean).join('\n'), { parse_mode: 'Markdown' });
    }

    if (text.toLowerCase() === '/schedule') {
        if (!isRegistered) return bot.sendMessage(chatId, '⛔ You are not registered. Ask the admin to add you.');
        await runDailyInitForUser({ chatId, ...allUsers[chatId] });
        return;
    }

    if (text.toLowerCase() === '/status') {
        if (!isRegistered) return bot.sendMessage(chatId, '⛔ You are not registered.');
        const timersCount = activeTimers[chatId] ? activeTimers[chatId].length : 0;
        await sendTelegram(chatId,
            `📊 *Bot Status*\n\n` +
            `Active alerts for you: *${timersCount}*\n` +
            `Pending OTP: *${pendingOtpCallbacks.has(chatId) ? 'Yes' : 'No'}*\n\n` +
            `Use /schedule to re-fetch today's classes.`
        );
        return;
    }

    // Default catch-all
    if (text.startsWith('/')) {
        await bot.sendMessage(chatId, 'Unknown command. Use /help to see what I can do.');
    }
});

bot.on('polling_error', (err) => {
    log(`[Telegram] Polling error: ${err.message}`);
});

// ─── Startup ──────────────────────────────────────────────────────────────────
(async () => {
    log('========================================');
    log(' Saveetha Schedule OTP Bot — Starting');
    log(`  Admin chat_id : ${ADMIN_CHAT_ID}`);
    log(`  Admin user    : ${ADMIN_USER}`);
    log(`  Temp dir      : ${validTemp}`);
    log(`  Total users   : ${Object.keys(getAllUsers()).length}`);
    log('========================================');

    await runDailyInit();
    scheduleMidnightRefetch();

    log('[Bot] Running. Send /help on Telegram. Press Ctrl+C to stop.');
})();
