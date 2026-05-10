const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Helper: take a screenshot and send it directly to WhatsApp
async function sendScreenshot(page, message, caption) {
    const tmpPath = path.join(__dirname, '_tmp_screenshot.png');
    try {
        await page.screenshot({ path: tmpPath, fullPage: false });
        const media = MessageMedia.fromFilePath(tmpPath);
        await message.reply(media, null, { caption });
    } catch (e) {
        console.log('[Screenshot] Could not send via WhatsApp:', e.message);
    } finally {
        try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
}

const SAVEETHA_USER = process.env.SAVEETHA_USER;
const SAVEETHA_PASS = process.env.SAVEETHA_PASS;

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', // Standard Windows path
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    console.log('Scan this QR code with your WhatsApp to link the bot:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp Bot is ready and listening for commands!');
});

// Listen to all incoming messages AND messages you send (to yourself/groups)
client.on('message_create', async (message) => {
    const text = message.body.trim();
    
    // Command format: !book <keyword>
    if (text.toLowerCase().startsWith('!book')) {
        const keyword = text.substring(5).trim();
        console.log(`[Command Received] Starting Saveetha Auto-Booker for: "${keyword}"`);
        message.reply(`⏳ Starting Saveetha Cloud Bot for "${keyword}"... Please wait.`);
        
        try {
            await runBookingBot(keyword, message);
        } catch (err) {
            console.error('[Error in Booking Bot]', err);
            message.reply(`❌ Error occurred: ${err.message}`);
        }
    }
});

async function runBookingBot(targetKeyword, message) {
    console.log('[Playwright] Launching browser...');
    // Running headful in the background (headless: true)
    const browser = await chromium.launch({ 
        headless: true,
        channel: 'chrome' // Use the system's Google Chrome
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        console.log('[Playwright] Navigating to login...');
        await page.goto('https://learner.saveetha.in/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // --- LOGIN ---
        console.log('[Playwright] Entering credentials...');
        await page.waitForSelector('input[type="text"], input[name="uid"], #username', { timeout: 15000 });
        
        const userInputs = await page.$$('input[type="text"], input[name="uid"], #username');
        if (userInputs.length > 0) {
            await userInputs[0].fill(SAVEETHA_USER);
        }
        
        const passInputs = await page.$$('input[type="password"]');
        if (passInputs.length > 0) {
            await passInputs[0].fill(SAVEETHA_PASS);
        }
        
        // Find and click login button
        const loginBtns = await page.$$('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign in")');
        if (loginBtns.length > 0) {
            await loginBtns[0].click();
        } else {
            await page.keyboard.press('Enter');
        }
        
        console.log('[Playwright] Logged in, waiting for redirect...');
        await page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => null);
        
        // Go to events booking
        console.log('[Playwright] Navigating to Event Booking page...');
        await page.goto('https://learner.saveetha.in/academicevents/event-booking/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
        // Fast-scan loop
        let isBooked = false;
        let attempts = 0;

        while (!isBooked) {
            attempts++;
            console.log(`[Playwright] Scan attempt #${attempts}...`);
            
            // Re-evaluate the page content inside the browser context
            const slotsFound = await page.evaluate((kw) => {
                const results = [];
                const allClickable = document.querySelectorAll('a, button, input[type="button"], input[type="submit"]');
                const btns = Array.from(allClickable).filter(el => {
                    if (el.offsetParent === null) return false;
                    const text = (el.innerText || el.value || el.textContent || '').trim().toLowerCase();
                    return text === 'book' || text === 'book now' || text === 'register' || text === 'book slot' || text === 'enroll' || text.startsWith('book') || text.includes('waitlist');
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
                    // Walk up to find card container
                    for (let d = 0; d < 10; d++) {
                        if (!current || current === document.body) break;
                        current = current.parentElement;
                        if (!current) break;
                        const hasHeading = current.querySelector('h1,h2,h3,h4,h5,strong,b,[class*="title"],[class*="heading"]');
                        const rect = current.getBoundingClientRect();
                        // Assume a card is between 50px and 2500px tall
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
            }, targetKeyword);

            if (slotsFound.length > 0) {
                console.log(`[Playwright] Match found: ${slotsFound[0].fullText.substring(0, 60)}...`);
                
                // Tag the button and its card with data attributes using evaluate
                const tagged = await page.evaluate((targetData) => {
                    // Remove old tags first
                    document.querySelectorAll('[data-saveetha-btn],[data-saveetha-input]').forEach(el => {
                        el.removeAttribute('data-saveetha-btn');
                        el.removeAttribute('data-saveetha-input');
                    });

                    const allClickable = document.querySelectorAll('a, button, input[type="button"], input[type="submit"]');
                    const btns = Array.from(allClickable).filter(el => {
                        if (el.offsetParent === null) return false;
                        const text = (el.innerText || el.value || el.textContent || '').trim().toLowerCase();
                        return text === 'book' || text === 'book now' || text === 'register' || text === 'book slot' || text === 'enroll' || text.startsWith('book') || text.includes('waitlist');
                    });
                    
                    const btn = btns[targetData.index];
                    if (!btn) return { success: false, reason: 'Button vanished' };
                    
                    // Walk up to find card
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
                            if (p.includes('purpose') || p.includes('reason') || p.includes('attend') || n.includes('purpose') || a.includes('purpose')) {
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
                
                console.log(`[Playwright] Tag result: success=${tagged.success}, purposeFound=${tagged.purposeFound}`);

                if (tagged.success) {
                    const bookBtn = page.locator('[data-saveetha-btn="target"]');
                    await bookBtn.scrollIntoViewIfNeeded();
                    await page.waitForTimeout(500);

                    if (tagged.purposeFound) {
                        const purposeInput = page.locator('[data-saveetha-input="purpose"]');
                        console.log('[Playwright] Focusing purpose input...');
                        await purposeInput.scrollIntoViewIfNeeded();
                        await purposeInput.click({ force: true });
                        await page.waitForTimeout(400);
                        await page.keyboard.press('Control+A');
                        await page.keyboard.press('Delete');
                        await page.waitForTimeout(200);
                        await purposeInput.pressSequentially('To attend as part of academic curriculum', { delay: 50 });
                        await page.waitForTimeout(600);
                        const inputVal = await purposeInput.inputValue().catch(() => '?');
                        console.log(`[Playwright] Purpose field value after typing: "${inputVal}"`);
                    } else {
                        console.log('[Playwright] No purpose field — clicking Book Now directly.');
                    }

                    console.log('[Playwright] Clicking Book Now...');
                    await bookBtn.scrollIntoViewIfNeeded();
                    await page.waitForTimeout(300);
                    await bookBtn.click({ force: true });
                    console.log('[Playwright] Book Now clicked!');

                    await page.waitForTimeout(2000);

                    // Handle SweetAlert2 / modals
                    try {
                        const swal2Confirm = page.locator('.swal2-confirm');
                        if (await swal2Confirm.count() > 0) {
                            console.log('[Playwright] SweetAlert2 confirm found — clicking...');
                            await swal2Confirm.first().click();
                            await page.waitForTimeout(1500);
                        } else {
                            const modalBtns = page.locator('.modal button, [role="dialog"] button, .swal-button');
                            const count = await modalBtns.count();
                            for (let i = 0; i < count; i++) {
                                const t = (await modalBtns.nth(i).innerText().catch(() => '')).toLowerCase().trim();
                                if (t === 'ok' || t === 'confirm' || t === 'yes' || t === 'book') {
                                    console.log(`[Playwright] Modal button "${t}" — clicking...`);
                                    await modalBtns.nth(i).click();
                                    await page.waitForTimeout(1500);
                                    break;
                                }
                            }
                        }
                    } catch (modalErr) {
                        console.log('[Playwright] Modal check (may have navigated):', modalErr.message);
                    }

                    await page.waitForTimeout(1500);
                    const currentUrl = page.url();
                    console.log(`[Playwright] Final URL: ${currentUrl}`);
                    console.log('[Playwright] Sending screenshot 4 (final result)...');
                    await sendScreenshot(page, message, `🎉 Step 4: Final result! URL: ${currentUrl}`);

                    const actionStr = slotsFound[0].isWaitlist ? 'Waitlisted' : 'Booked';
                    message.reply(`✅ ${actionStr}: *${targetKeyword}*\n📸 Screenshots sent above show the full booking process.`);
                    isBooked = true;
                    break;
                } else {
                    console.log(`[Playwright] Tagging failed: ${tagged.reason} — reloading...`);
                    await page.waitForTimeout(3000);
                    await page.reload({ waitUntil: 'domcontentloaded' });
                }
            } else {
                console.log('[Playwright] No slot found yet, reloading in 5 seconds...');
                await page.waitForTimeout(5000);
                await page.reload({ waitUntil: 'domcontentloaded' });
            }
            
            // Limit to 120 attempts to prevent infinite loops
            if (attempts > 120) {
                message.reply(`⚠️ Timeout: Could not find "${targetKeyword}" after 120 scans.`);
                break;
            }
        }
        
    } catch (err) {
        console.error(err);
        message.reply(`❌ Playwright error: ${err.message}`);
    } finally {
        await browser.close();
    }
}

client.initialize();
