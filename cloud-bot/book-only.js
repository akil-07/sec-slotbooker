const { chromium } = require('playwright');
require('dotenv').config();

const SAVEETHA_USER = process.env.SAVEETHA_USER;
const SAVEETHA_PASS = process.env.SAVEETHA_PASS;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const KEYWORD = process.env.KEYWORD || '';

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

    console.log(`[Bot] Starting booking for: "${KEYWORD}"`);
    await sendTelegram(`⏳ Starting booking bot for *${KEYWORD || 'any slot'}*...\nScanning Saveetha portal...`);

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

        let isBooked = false;
        let attempts = 0;

        // ── SCAN LOOP ─────────────────────────────────────────────────────────
        while (!isBooked && attempts < 120) {
            attempts++;
            console.log(`[Bot] Scan attempt #${attempts}...`);

            const slotsFound = await page.evaluate((kw) => {
                const results = [];
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

                    const fullText = card ? normalize(card.innerText) : normalize(btn.innerText);
                    const btnText = (btn.innerText || btn.value || '').trim().toLowerCase();
                    const isWaitlist = btnText.includes('waitlist');

                    if (!kwNorm || fullText.includes(kwNorm)) {
                        results.push({ index: i, fullText, isWaitlist });
                    }
                }
                return results;
            }, KEYWORD);

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
                    await sendTelegram(
                        `${actionStr} Successfully!\n\n` +
                        `🎯 *Slot:* ${KEYWORD}\n` +
                        `🔗 *URL:* ${currentUrl}\n\n` +
                        `The booking process is complete! 🎉`
                    );

                    isBooked = true;
                } else {
                    console.log(`[Bot] Tagging failed: ${tagged.reason} — reloading...`);
                    await page.waitForTimeout(3000);
                    await page.reload({ waitUntil: 'domcontentloaded' });
                }

            } else {
                console.log('[Bot] No slot found yet, reloading in 5 seconds...');
                if (attempts % 20 === 0) {
                    await sendTelegram(`🔍 Still scanning... (attempt ${attempts}/120)\nSearching for: *${KEYWORD}*`);
                }
                await page.waitForTimeout(5000);
                await page.reload({ waitUntil: 'domcontentloaded' });
            }
        }

        if (!isBooked) {
            await sendTelegram(`⚠️ *Timeout!*\nCould not find *"${KEYWORD}"* after 120 scans.\n\nTry again with:\n\`!book ${KEYWORD}\``);
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
