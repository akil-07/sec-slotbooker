const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const SAVEETHA_USER = process.env.SAVEETHA_USER;
const SAVEETHA_PASS = process.env.SAVEETHA_PASS;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
let KEYWORD_ENV = process.env.KEYWORD || '';

let KEYWORD = KEYWORD_ENV;
let TARGET_TIME = '';

if (KEYWORD_ENV.includes('@')) {
    const parts = KEYWORD_ENV.split('@');
    KEYWORD = parts[0].trim();
    TARGET_TIME = parts[1].trim();
}

// ── Telegram Helper ────────────────────────────────────────────────────────────
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
        const res = await fetch(url, {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (!data.ok) console.error('[Telegram] Error sending photo:', data.description);
        else console.log('[Telegram] Photo sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send photo:', e.message);
    }
}

// ── Main Booking Bot ───────────────────────────────────────────────────────────
async function runBookingBot() {
    if (!SAVEETHA_USER || !SAVEETHA_PASS) {
        console.error('[Bot] SAVEETHA_USER or SAVEETHA_PASS not set!');
        process.exit(1);
    }
    if (!TELEGRAM_BOT_TOKEN || !CHAT_ID) {
        console.error('[Bot] TELEGRAM_BOT_TOKEN or CHAT_ID not set!');
        process.exit(1);
    }

    console.log(`[Bot] Starting booking for: "${KEYWORD}"${TARGET_TIME ? ` at "${TARGET_TIME}"` : ''}`);
    await sendTelegram(`⏳ Starting booking bot for *${KEYWORD || 'any slot'}*${TARGET_TIME ? ` at *${TARGET_TIME}*` : ''}...\nScanning Saveetha portal...`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // ── LOGIN ────────────────────────────────────────────────────────────
        console.log('[Bot] Navigating to login...');
        await page.goto('https://learner.saveetha.in/login', { waitUntil: 'domcontentloaded', timeout: 60000 });

        await page.waitForSelector('input[type="text"], input[name="uid"], #username', { timeout: 15000 });

        const userInputs = await page.$$('input[type="text"], input[name="uid"], #username');
        if (userInputs.length > 0) await userInputs[0].fill(SAVEETHA_USER);

        const passInputs = await page.$$('input[type="password"]');
        if (passInputs.length > 0) await passInputs[0].fill(SAVEETHA_PASS);

        const loginBtns = await page.$$('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in")');
        if (loginBtns.length > 0) await loginBtns[0].click();
        else await page.keyboard.press('Enter');

        console.log('[Bot] Logged in, waiting for redirect...');
        await page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => null);

        // ── NAVIGATE TO BOOKING ───────────────────────────────────────────────
        console.log('[Bot] Navigating to Event Booking page...');
        await page.goto('https://learner.saveetha.in/academicevents/event-booking/', { waitUntil: 'domcontentloaded', timeout: 60000 });

        console.log(`[Bot] Scanning for slots...`);

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
                return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
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

                // Extract summary for available slots list
                let summary = fullTextRaw.replace(/\n+/g, ' | ').trim();
                if (summary.length > 80) summary = summary.substring(0, 80) + '...';
                allAvailable.push(summary);

                let matchKeyword = !kwNorm || fullTextNorm.includes(kwNorm);
                let matchTime = !timeNorm || fullTextNorm.includes(timeNorm);

                if (matchKeyword && matchTime) {
                    results.push({ index: i, fullText: fullTextNorm, isWaitlist });
                }
            }
            return { slotsFound: results, availableSlots: [...new Set(allAvailable)] };
        }, { kw: KEYWORD, time: TARGET_TIME });

        const slotsFound = evaluation.slotsFound;
        const availableSlots = evaluation.availableSlots;

            if (slotsFound.length > 0) {
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

                if (tagged.success) {
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
                    const currentUrl = page.url();
                    console.log(`[Bot] Final URL: ${currentUrl}`);

                    const actionStr = slotsFound[0].isWaitlist ? '📋 Waitlisted' : '✅ Booked';
                    
                    // Take screenshot
                    const tmpPath = path.join(__dirname, '_tmp_screenshot.png');
                    await page.screenshot({ path: tmpPath, fullPage: false });

                    await sendTelegramPhoto(
                        tmpPath,
                        `${actionStr} Successfully!\n\n🎯 Slot: ${KEYWORD}${TARGET_TIME ? ` at ${TARGET_TIME}` : ''}\n🔗 URL: ${currentUrl}\n\nThe booking process is complete! 🎉`
                    );

                    try { fs.unlinkSync(tmpPath); } catch (_) {}
                } else {
                    console.log(`[Bot] Tagging failed: ${tagged.reason}`);
                    await sendTelegram(`⚠️ Found the slot but failed to book: ${tagged.reason}`);
                }

            } else {
                console.log('[Bot] No slot found.');
                const availableMsg = availableSlots.length > 0 
                    ? `\n\n*Available Slots:*\n` + availableSlots.map(s => `- ${s}`).join('\n') 
                    : '\n\nNo slots are currently available on the page.';
                await sendTelegram(`⚠️ No slot found for *"${KEYWORD}"*${TARGET_TIME ? ` at *${TARGET_TIME}*` : ''}.${availableMsg}`);
            }

    } catch (err) {
        console.error('[Bot] Error:', err);
        await sendTelegram(`❌ *Error occurred:*\n${err.message}`);
    } finally {
        await browser.close();
        console.log('[Bot] Browser closed. Done.');
    }
}

runBookingBot();
