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
    
    // Command format: !book <keyword> [@ time] [# start time]
    if (text.toLowerCase().startsWith('!book')) {
        let keyword = text.substring(5).trim();
        let targetTime = '';
        let targetDate = '';
        let startTime = '';
        
        if (keyword.includes('#')) {
            const parts = keyword.split('#');
            keyword = parts[0].trim();
            startTime = parts[1].trim();
        }
        
        if (keyword.includes('~')) {
            const parts = keyword.split('~');
            keyword = parts[0].trim();
            targetDate = parts[1].trim();
        }

        if (keyword.includes('@')) {
            const parts = keyword.split('@');
            keyword = parts[0].trim();
            targetTime = parts[1].trim();
        }
        
        console.log(`[Command Received] Starting Saveetha Auto-Booker for: "${keyword}"${targetDate ? ` on "${targetDate}"` : ''}${targetTime ? ` at "${targetTime}"` : ''}${startTime ? ` | starts at ${startTime}` : ''}`);
        
        try {
            await runBookingBot(keyword, targetTime, targetDate, startTime, message);
        } catch (err) {
            console.error('[Error in Booking Bot]', err);
            message.reply(`❌ Error occurred: ${err.message}`);
        }
    }
});

async function runBookingBot(targetKeyword, targetTime, targetDate, startTime, message) {
    if (startTime) {
        // Calculate delay
        const now = new Date();
        const match = startTime.match(/(\d{1,2})(?:[\.:]\s*(\d{2}))?\s*(AM|PM|am|pm)?/i);
        if (match) {
            let hours = parseInt(match[1], 10);
            const mins = match[2] ? parseInt(match[2], 10) : 0;
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
            
            const delayMins = Math.round(diff / 60000);
            message.reply(`⏱️ *Timer Mode Active*\nWaiting ${delayMins} minute(s) before starting the booking process for *${targetKeyword}* (Starts at ${startTime}).`);
            await new Promise(resolve => setTimeout(resolve, diff));
        }
    }

    message.reply(`⏳ Starting Saveetha Cloud Bot for "${targetKeyword}"${targetDate ? ` on ${targetDate}` : ''}${targetTime ? ` at ${targetTime}` : ''}... Please wait.`);

    console.log('[Playwright] Launching browser...');
    // Running headful in the background (headless: true)
    const browser = await chromium.launch({ 
        headless: true,
        channel: 'chrome' // Use the system's Google Chrome
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        console.log('[Playwright] Navigating to Event Booking page...');
        await page.goto('https://learner.saveetha.in/academicevents/event-booking/', { waitUntil: 'networkidle', timeout: 60000 });
        
        if (page.url().includes('/login') || page.url().includes('/authorize')) {
            console.log('[Playwright] Entering credentials...');
            await page.waitForSelector('input[type="text"], input[name="uid"], #username', { timeout: 15000 });
            
            const userInputs = await page.$$('input[type="text"], input[name="uid"], #username');
            if (userInputs.length > 0) {
                await userInputs[0].fill(String(SAVEETHA_USER));
            }
            
            const passInputs = await page.$$('input[type="password"]');
            if (passInputs.length > 0) {
                await passInputs[0].fill(String(SAVEETHA_PASS));
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
            
            try {
                await page.waitForURL(url => !url.href.includes('/login') && !url.href.includes('/authorize'), { timeout: 15000 });
            } catch (e) {}
            await page.waitForTimeout(2000);
        }
        
        console.log(`[Playwright] Scanning for slots...`);
        
        // Re-evaluate the page content inside the browser context
        const evaluation = await page.evaluate((params) => {
            const { kw, time, date } = params;
            const results = [];
            const allAvailable = [];
            const allClickable = document.querySelectorAll('a, button, input[type="button"], input[type="submit"]');
            const btns = Array.from(allClickable).filter(el => {
                if (el.offsetParent === null) return false;
                const text = (el.innerText || el.value || el.textContent || '').trim().toLowerCase();
                return text === 'book' || text === 'book now' || text === 'register' || text === 'book slot' || text === 'enroll' || text.startsWith('book') || text.includes('waitlist');
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
            const dateNorm = normalize(date);

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

                let matchDate = true;
                if (dateNorm) {
                    matchDate = fullTextNorm.includes(dateNorm) || titleTextNorm.includes(dateNorm);
                }

                // ⛔ Check "Opening Soon" or "Already Booked" status
                const isOpeningSoon = /opening\s*soon/i.test(fullTextRaw);
                const isAlreadyBooked = /booked|registered|enrolled|joined/i.test(btnText) && !btnText.includes('book');

                if (matchKeyword && matchTime && matchDate) {
                    if (isOpeningSoon) {
                        results.push({ index: i, fullText: fullTextNorm, isWaitlist, isOpeningSoon: true });
                    } else if (isAlreadyBooked) {
                        results.push({ index: i, fullText: fullTextNorm, isWaitlist, isAlreadyBooked: true });
                    } else {
                        results.push({ index: i, fullText: fullTextNorm, isWaitlist });
                    }
                }
            }
            return { slotsFound: results, availableSlots: [...new Set(allAvailable)] };
        }, { kw: targetKeyword, time: targetTime, date: targetDate });

        const slotsFound = evaluation.slotsFound;
        const availableSlots = evaluation.availableSlots;

        // Filter out non-bookable results for the actual booking logic, but keep them for reporting
        const bookableSlots = slotsFound.filter(s => !s.isOpeningSoon && !s.isAlreadyBooked);

        if (bookableSlots.length > 0) {
            console.log(`[Playwright] Match found: ${bookableSlots[0].fullText.substring(0, 60)}...`);
                
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
                }, bookableSlots[0]);
                
                console.log(`[Playwright] Tag result: success=${tagged.success}, purposeFound=${tagged.purposeFound}`);

                if (tagged.success) {
                    const bookBtn = page.locator('[data-saveetha-btn="target"]');
                    await bookBtn.scrollIntoViewIfNeeded();
                    await page.waitForTimeout(200);

                    if (tagged.purposeFound) {
                        const purposeInput = page.locator('[data-saveetha-input="purpose"]');
                        console.log('[Playwright] Focusing purpose input...');
                        await purposeInput.scrollIntoViewIfNeeded();
                        await purposeInput.click({ force: true });
                        await page.waitForTimeout(100);
                        await page.keyboard.press('Control+A');
                        await page.keyboard.press('Delete');
                        await page.waitForTimeout(100);
                        await purposeInput.pressSequentially('To attend as part of academic curriculum', { delay: 10 });
                        await page.waitForTimeout(200);
                        const inputVal = await purposeInput.inputValue().catch(() => '?');
                        console.log(`[Playwright] Purpose field value after typing: "${inputVal}"`);
                    } else {
                        console.log('[Playwright] No purpose field — clicking Book Now directly.');
                    }

                    console.log('[Playwright] Clicking Book Now...');
                    await bookBtn.scrollIntoViewIfNeeded();
                    await page.waitForTimeout(100);
                    await bookBtn.click({ force: true });
                    console.log('[Playwright] Book Now clicked!');

                    await page.waitForTimeout(500);

                    // Handle SweetAlert2 / modals
                    try {
                        const swal2Confirm = page.locator('.swal2-confirm');
                        if (await swal2Confirm.count() > 0) {
                            console.log('[Playwright] SweetAlert2 confirm found — clicking...');
                            await swal2Confirm.first().click();
                            await page.waitForTimeout(500);
                        } else {
                            const modalBtns = page.locator('.modal button, [role="dialog"] button, .swal-button');
                            const count = await modalBtns.count();
                            for (let i = 0; i < count; i++) {
                                const t = (await modalBtns.nth(i).innerText().catch(() => '')).toLowerCase().trim();
                                if (t === 'ok' || t === 'confirm' || t === 'yes' || t === 'book') {
                                    console.log(`[Playwright] Modal button "${t}" — clicking...`);
                                    await modalBtns.nth(i).click();
                                    await page.waitForTimeout(500);
                                    break;
                                }
                            }
                        }
                    } catch (modalErr) {
                        console.log('[Playwright] Modal check (may have navigated):', modalErr.message);
                    }

                    await page.waitForTimeout(500);

                    // Verify booking by checking for a success/info banner message
                    const bannerFound = await page.evaluate(() => {
                        const alerts = document.querySelectorAll('.alert, .toast, .message, .notification, [class*="alert"], [class*="success"], [class*="msg"]');
                        let text = '';
                        alerts.forEach(el => {
                            if (el.offsetParent !== null && el.innerText.trim().length > 0) {
                                text += el.innerText.trim() + ' ';
                            }
                        });
                        const lower = text.toLowerCase();
                        if (lower.includes('booked') || lower.includes('cancelled') || lower.includes('waitlisted') || lower.includes('success')) {
                            return { found: true, text: text.trim() };
                        }
                        return { found: false, text: text.trim() };
                    });

                    if (!bannerFound.found) {
                        console.log(`[Playwright] Expected confirmation banner not found. Text was: "${bannerFound.text}". Misunderstood click.`);
                        message.reply(`⚠️ Attempted to book *"${targetKeyword}"*, but could not verify success (no banner found). The bot may have misunderstood the button.`);
                        return false;
                    }
                    console.log(`[Playwright] Confirmed via banner: ${bannerFound.text}`);

                    const currentUrl = page.url();
                    console.log(`[Playwright] Final URL: ${currentUrl}`);
                    console.log('[Playwright] Sending screenshot 4 (final result)...');
                    await sendScreenshot(page, message, `🎉 Step 4: Final result! URL: ${currentUrl}`);

                    message.reply(`✅ ${actionStr}: *${targetKeyword}*${targetTime ? ` at ${targetTime}` : ''}\n📸 Screenshots sent above show the full booking process.`);
                } else {
                    console.log(`[Playwright] Tagging failed: ${tagged.reason}`);
                    message.reply(`⚠️ Found the slot but failed to book: ${tagged.reason}`);
                }
        } else {
            console.log('[Playwright] No bookable slot found.');
            let reasonMsg = '';
            const openingSoon = slotsFound.find(s => s.isOpeningSoon);
            const alreadyBooked = slotsFound.find(s => s.isAlreadyBooked);

            if (openingSoon) {
                reasonMsg = `\n\n🕒 *Status:* Found the slot, but it says "Opening Soon".`;
            } else if (alreadyBooked) {
                reasonMsg = `\n\n✅ *Status:* You are already booked/registered for this slot.`;
            } else {
                const displayedSlots = availableSlots.slice(0, 15);
                const moreCount = availableSlots.length - displayedSlots.length;
                reasonMsg = availableSlots.length > 0 
                    ? `\n\n*Available Slots:*\n` + displayedSlots.map(s => `- ${s}`).join('\n') + (moreCount > 0 ? `\n_...and ${moreCount} more slots_` : '')
                    : '\n\nNo slots are currently available on the page.';
            }
            message.reply(`⚠️ No bookable slot found for "${targetKeyword}"${targetDate ? ` on ${targetDate}` : ''}${targetTime ? ` at ${targetTime}` : ''}.${reasonMsg}`);
        }
        
    } catch (err) {
        console.error(err);
        message.reply(`❌ Playwright error: ${err.message}`);
    } finally {
        await browser.close();
    }
}

client.initialize();
