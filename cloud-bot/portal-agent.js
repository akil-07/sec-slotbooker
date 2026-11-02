/**
 * Saveetha Portal Autonomous Agent (portal-agent.js)
 * 
 * Capable of surfing and executing jobs directly inside learner.saveetha.in:
 * 1. Leave & OD Applications (Leave Application + Approval Flow + Class overlap check)
 * 2. University Circulars scraping & AI query answering
 * 3. Student Reward Points & Coin balance checking
 * 4. Workflow Requests & Approvals tracking (checking teacher remarks/approvals)
 * 5. General navigation & autonomous exploration
 */

const path = require('path');
const fs = require('fs');

const MODULE_URLS = {
    schedule: 'https://learner.saveetha.in/academics/people_schedule/',
    circulars: 'https://learner.saveetha.in/academics/circulars/',
    workflow_requests: 'https://learner.saveetha.in/academics/workflow-requests/',
    workflow_approvals: 'https://learner.saveetha.in/academics/workflow-approvals/',
    rewards: 'https://learner.saveetha.in/rewards/my-reward-points/',
    subjects: 'https://learner.saveetha.in/academics/studentsubjects/',
    events: 'https://learner.saveetha.in/academicevents/event-booking/',
    services: 'https://learner.saveetha.in/academics/services/',
    profile: 'https://learner.saveetha.in/people/profile/',
    college_hours: 'https://learner.saveetha.in/attendance/my-college-hours/'
};

// Leave type mappings from natural language to exact portal dropdown values
const LEAVE_TYPE_MAP = {
    'od': 'OnDuty-Students',
    'onduty': 'OnDuty-Students',
    'on-duty': 'OnDuty-Students',
    'medical': 'Medical Leave - Students',
    'sick': 'Medical Leave - Students',
    'fever': 'Medical Leave - Students',
    'leave': 'Leave-Students',
    'personal': 'Leave-Students',
    'hostel': 'HostelGatePass',
    'gatepass': 'HostelGatePass',
    'gate pass': 'HostelGatePass',
    'emergency': 'EmergencyHostelGatePass',
    'placement': 'PlacementInternshipRequest',
    'internship': 'PlacementInternshipRequest',
    'interview': 'Placement Interview',
    'placement training': 'PlacementTrainingLeaveRequest'
};

async function ensurePortalSession(page, session) {
    if (!session || !session.config) throw new Error('Invalid user session');
    const curUrl = page.url();
    if (curUrl === 'about:blank' || curUrl.includes('/login') || curUrl.includes('/secauth/login/')) {
        console.log('[PortalAgent] Session expired or blank, logging in...');
        await page.goto('https://learner.saveetha.in/academics/people_schedule/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (page.url().includes('/login')) {
            const doLogin = session.doLogin;
            if (typeof doLogin === 'function') {
                await doLogin(page, session.config.user, session.config.pass);
            }
        }
        await page.waitForTimeout(1500);
    }
}

/**
 * Normalizes user requested leave type into exact portal dropdown string
 */
function resolveLeaveType(inputStr) {
    if (!inputStr) return 'Leave-Students';
    const low = inputStr.toLowerCase().trim();
    for (const [kw, exactVal] of Object.entries(LEAVE_TYPE_MAP)) {
        if (low.includes(kw)) return exactVal;
    }
    return 'Leave-Students';
}

/**
 * Format date/time to portal format: DD/MM/YYYY hh:mm A (e.g. 03/11/2026 08:00 AM)
 */
function formatPortalDateTime(dateObj, hour = 8, minute = 0, ampm = 'AM') {
    const d = new Date(dateObj);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const h = String(hour).padStart(2, '0');
    const m = String(minute).padStart(2, '0');
    return `${day}/${month}/${year} ${h}:${m} ${ampm.toUpperCase()}`;
}

/**
 * 1. AUTOMATED LEAVE & OD APPLICATION DRAFTING & SUBMISSION
 */
async function draftLeaveApplication(session, leaveData, chatId, sendTelegram, sendTelegramPhoto, pendingConfirmations) {
    const page = await session.context.newPage();
    const screenshotPath = path.join(__dirname, `_leave_draft_${Date.now()}.png`);

    try {
        await ensurePortalSession(page, session);
        await sendTelegram(`⏳ *Opening Workflow Engine on Saveetha Portal...*`, chatId);

        // 1. Navigate to Workflow Requests
        await page.goto(MODULE_URLS.workflow_requests, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        // 2. Click "New Application ▼" dropdown
        console.log('[PortalAgent] Locating New Application dropdown button...');
        const newAppBtn = await page.locator('button:has-text("New Application"), a:has-text("New Application"), .dropdown-toggle:has-text("Application")').first();
        await newAppBtn.waitFor({ state: 'visible', timeout: 15000 });
        await newAppBtn.click();
        await page.waitForTimeout(800);

        // 3. Click "New Leave Application"
        console.log('[PortalAgent] Selecting New Leave Application...');
        const leaveAppOption = await page.locator('a:has-text("New Leave Application"), button:has-text("New Leave Application")').first();
        await leaveAppOption.waitFor({ state: 'visible', timeout: 10000 });
        await leaveAppOption.click();
        await page.waitForTimeout(2500);

        // 4. Fill Form Fields
        const resolvedType = resolveLeaveType(leaveData.type || leaveData.leaveType);
        const title = leaveData.title || (resolvedType === 'OnDuty-Students' ? 'On-Duty Application' : 'Leave Application');
        const subject = leaveData.subject || (resolvedType === 'OnDuty-Students' ? 'Request for On-Duty (OD) Attendance' : 'Application for Leave');
        const reason = leaveData.reason || leaveData.content || (resolvedType === 'OnDuty-Students' ? 'Participating in technical event/symposium representing college.' : 'Unable to attend classes due to personal/medical reasons.');

        console.log(`[PortalAgent] Filling Leave Form: Type=${resolvedType}, Title="${title}"`);

        // A. Leave Title
        const titleInput = page.locator('input[name*="title" i], input[placeholder*="title" i], #id_title').first();
        if (await titleInput.isVisible()) {
            await titleInput.fill(title);
        }

        // B. Leave Type Dropdown
        const typeSelect = page.locator('select[name*="leave_type" i], select[name*="type" i], select#id_leave_type').first();
        if (await typeSelect.isVisible()) {
            // Find option matching resolvedType
            const options = await typeSelect.locator('option').allTextContents();
            const matchedOpt = options.find(o => o.trim().toLowerCase() === resolvedType.toLowerCase()) || resolvedType;
            await typeSelect.selectOption({ label: matchedOpt }).catch(async () => {
                await typeSelect.selectOption({ value: resolvedType }).catch(() => {});
            });
        }

        // C. Dates: From and To
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const targetDate = leaveData.date ? new Date(leaveData.date) : (leaveData.isTomorrow ? tomorrow : today);
        const fromStr = leaveData.fromTime || formatPortalDateTime(targetDate, 8, 0, 'AM');
        const toStr = leaveData.toTime || formatPortalDateTime(targetDate, 5, 0, 'PM');

        const fromInput = page.locator('input[name*="from" i], input[placeholder*="from" i], #id_leave_from').first();
        if (await fromInput.isVisible()) {
            await fromInput.fill(fromStr);
            await fromInput.dispatchEvent('change');
        }

        const toInput = page.locator('input[name*="to" i], input[placeholder*="to" i], #id_leave_to').first();
        if (await toInput.isVisible()) {
            await toInput.fill(toStr);
            await toInput.dispatchEvent('change');
        }

        // D. Subject
        const subjectInput = page.locator('input[name*="subject" i], input[placeholder*="subject" i], #id_subject').first();
        if (await subjectInput.isVisible()) {
            await subjectInput.fill(subject);
        }

        // E. Content (Rich text editor or standard textarea)
        const contentArea = page.locator('textarea[name*="content" i], textarea[name*="reason" i], div[contenteditable="true"]').first();
        if (await contentArea.isVisible()) {
            const isEditableDiv = await contentArea.evaluate(el => el.getAttribute('contenteditable') === 'true');
            if (isEditableDiv) {
                await contentArea.evaluate((el, text) => { el.innerText = text; }, reason);
            } else {
                await contentArea.fill(reason);
            }
        }

        // Allow live timetable query to trigger and populate Schedules During Leave
        await page.waitForTimeout(3000);

        // 5. Scrape Overlapping Schedules
        console.log('[PortalAgent] Checking overlapping schedules during leave duration...');
        const overlappingClasses = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('table tbody tr'));
            const scheduleRows = rows.filter(r => r.innerText.includes('Academic') || r.innerText.includes('Student : Class') || /\d{2}:\d{2}/.test(r.innerText));
            return scheduleRows.map(r => {
                const text = r.innerText.replace(/\s+/g, ' ').trim();
                return text;
            });
        });

        // 6. Switch to "Approval Flow" tab and inspect available workflows
        console.log('[PortalAgent] Checking Approval Flow tab...');
        const approvalTab = page.locator('a:has-text("Approval Flow"), button:has-text("Approval Flow"), [data-bs-target*="approval" i]').first();
        let workflowOptions = [];
        if (await approvalTab.isVisible()) {
            await approvalTab.click();
            await page.waitForTimeout(1500);

            const workflowSelect = page.locator('select[name*="workflow" i], select#id_workflow').first();
            if (await workflowSelect.isVisible()) {
                workflowOptions = await workflowSelect.locator('option').allTextContents();
                workflowOptions = workflowOptions.map(o => o.trim()).filter(o => o && !o.includes('----'));
                // Select first valid workflow option if available
                if (workflowOptions.length > 0) {
                    await workflowSelect.selectOption({ label: workflowOptions[0] }).catch(() => {});
                    await page.waitForTimeout(800);
                }
            }
        }

        // 7. Save Draft
        console.log('[PortalAgent] Saving draft to portal...');
        const saveDraftBtn = page.locator('button:has-text("Save Draft"), input[value*="Save Draft"]').first();
        if (await saveDraftBtn.isVisible()) {
            await saveDraftBtn.click();
            await page.waitForTimeout(2000);
        }

        // 8. Capture Full Verification Screenshot
        await page.screenshot({ path: screenshotPath, fullPage: true });

        // 9. Format Telegram Report for Student
        let classListStr = '';
        if (overlappingClasses.length > 0) {
            classListStr = `\n📚 *Classes Covered During This Leave (${overlappingClasses.length}):*\n` +
                overlappingClasses.slice(0, 6).map(c => `• ${c}`).join('\n');
            if (overlappingClasses.length > 6) {
                classListStr += `\n• _+${overlappingClasses.length - 6} more classes_`;
            }
        } else {
            classListStr = `\nℹ️ *Overlapping Classes:* None detected for this specific window.`;
        }

        const workflowStr = workflowOptions.length > 0 ? `\n🔄 *Assigned Approval Flow:* \`${workflowOptions[0]}\`` : '';

        const confirmationMsg = 
            `📝 *Leave / OD Application Prepared & Drafted!*\n\n` +
            `• *Type:* \`${resolvedType}\`\n` +
            `• *Title:* *${title}*\n` +
            `• *Subject:* ${subject}\n` +
            `• *From:* \`${fromStr}\`\n` +
            `• *To:* \`${toStr}\`\n` +
            workflowStr + `\n` +
            classListStr + `\n\n` +
            `⚠️ *Ready for Official Submission:*\n` +
            `The draft has been populated on your Saveetha portal. Check the attached screenshot!\n\n` +
            `👉 Reply *submit* or *apply* to officially route this to your Mentor/HOD.\n` +
            `👉 Reply *cancel* to keep it as an unsubmitted draft.`;

        if (sendTelegramPhoto) {
            await sendTelegramPhoto(screenshotPath, confirmationMsg, chatId);
        } else {
            await sendTelegram(confirmationMsg, chatId);
        }

        // Store pending submission context
        if (pendingConfirmations) {
            pendingConfirmations.set(chatId, {
                action: 'confirm_leave_submission',
                resolvedType,
                title,
                targetUrl: page.url()
            });
        }

        return { success: true, type: resolvedType, classesCount: overlappingClasses.length };
    } catch (err) {
        console.error('[PortalAgent] Error drafting leave application:', err);
        await sendTelegram(`⚠️ Error preparing leave application: ${err.message}`, chatId);
        return { success: false, error: err.message };
    } finally {
        try { fs.unlinkSync(screenshotPath); } catch (_) {}
        await page.close().catch(() => {});
    }
}

/**
 * 2. SUBMIT / APPLY CONFIRMED DRAFT
 */
async function officiallySubmitLeave(session, chatId, sendTelegram, sendTelegramPhoto) {
    const page = await session.context.newPage();
    const screenshotPath = path.join(__dirname, `_leave_submitted_${Date.now()}.png`);

    try {
        await ensurePortalSession(page, session);
        await sendTelegram(`🚀 *Submitting your leave application to the approval flow...*`, chatId);

        await page.goto(MODULE_URLS.workflow_requests, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        // Click on the most recent draft item
        const draftItem = page.locator('a:has-text("Draft"), tr:has-text("Draft") a').first();
        if (await draftItem.isVisible()) {
            await draftItem.click();
            await page.waitForTimeout(2000);
        }

        // Go to Approval Flow tab
        const approvalTab = page.locator('a:has-text("Approval Flow"), button:has-text("Approval Flow")').first();
        if (await approvalTab.isVisible()) {
            await approvalTab.click();
            await page.waitForTimeout(1500);
        }

        // Click "Apply" button
        const applyBtn = page.locator('button:has-text("Apply"), input[value="Apply"]').first();
        if (await applyBtn.isVisible()) {
            await applyBtn.click();
            await page.waitForTimeout(3000);
        }

        await page.screenshot({ path: screenshotPath, fullPage: false });

        const successMsg = 
            `🎉 *Leave Application Officially Submitted!*\n\n` +
            `Your request has been routed to your Mentor / Faculty in-charge for review.\n` +
            `You can track its status anytime by asking:\n` +
            `👉 *"Check my workflow approvals"* or sending \`!workflow\`.`;

        if (sendTelegramPhoto) {
            await sendTelegramPhoto(screenshotPath, successMsg, chatId);
        } else {
            await sendTelegram(successMsg, chatId);
        }
        return { success: true };
    } catch (err) {
        console.error('[PortalAgent] Error officially submitting leave:', err);
        await sendTelegram(`⚠️ Error submitting leave request: ${err.message}`, chatId);
        return { success: false, error: err.message };
    } finally {
        try { fs.unlinkSync(screenshotPath); } catch (_) {}
        await page.close().catch(() => {});
    }
}

/**
 * 3. UNIVERSITY CIRCULARS & NOTICES SCRAPER
 */
async function browseCirculars(session, query, chatId, sendTelegram, callSmartAI) {
    const page = await session.context.newPage();
    try {
        await ensurePortalSession(page, session);
        await sendTelegram(`📢 *Fetching latest University Circulars & Notices...*`, chatId);

        await page.goto(MODULE_URLS.circulars, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);

        const circulars = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.card, tr, .list-group-item, .accordion-item'));
            return items.slice(0, 15).map(item => {
                const text = item.innerText.replace(/\s+/g, ' ').trim();
                const link = item.querySelector('a') ? item.querySelector('a').href : null;
                return { text, link };
            }).filter(i => i.text.length > 15);
        });

        if (!circulars || circulars.length === 0) {
            await sendTelegram(`ℹ️ No recent circulars found on your portal.`, chatId);
            return;
        }

        // If user asked a specific question, use AI to analyze circulars
        if (query && callSmartAI) {
            const prompt = `You are Saveetha University Student Assistant.
The student asked: "${query}".
Here are the latest official circulars scraped directly from learner.saveetha.in:
${JSON.stringify(circulars, null, 2)}

Provide a clear, direct answer with dates, holiday info, exam details, or whatever the student requested. Use emojis and clean Telegram markdown.`;

            const aiReply = await callSmartAI(prompt, [], query, false);
            await sendTelegram(`📢 *Circulars Intel:*\n\n${aiReply || 'Here are the latest circulars on your portal.'}`, chatId);
        } else {
            // General overview of latest circulars
            let summary = `📢 *Latest Saveetha University Circulars:*\n\n`;
            circulars.slice(0, 5).forEach((c, idx) => {
                summary += `${idx + 1}️⃣ ${c.text.substring(0, 160)}...\n\n`;
            });
            await sendTelegram(summary, chatId);
        }
    } catch (err) {
        console.error('[PortalAgent] Error browsing circulars:', err);
        await sendTelegram(`⚠️ Error reading circulars: ${err.message}`, chatId);
    } finally {
        await page.close().catch(() => {});
    }
}

/**
 * 4. REWARD POINTS & COIN WALLET
 */
async function checkRewardPoints(session, chatId, sendTelegram, sendTelegramPhoto) {
    const page = await session.context.newPage();
    const screenshotPath = path.join(__dirname, `_rewards_${Date.now()}.png`);
    try {
        await ensurePortalSession(page, session);
        await sendTelegram(`🪙 *Checking your Saveetha Reward Points & Coins...*`, chatId);

        await page.goto(MODULE_URLS.rewards, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);

        const rewardInfo = await page.evaluate(() => {
            const body = document.body.innerText;
            const pointsMatch = body.match(/(\d+(?:\.\d+)?)\s*(?:points|coins|reward points)/i) || body.match(/total\s*points\s*:\s*(\d+)/i);
            return {
                points: pointsMatch ? pointsMatch[1] : null,
                snippet: body.substring(0, 400).replace(/\s+/g, ' ').trim()
            };
        });

        await page.screenshot({ path: screenshotPath });

        let msg = `🪙 *Saveetha Reward Points Status*\n\n`;
        if (rewardInfo.points) {
            msg += `💰 *Available Balance:* \`${rewardInfo.points}\` Points\n\n`;
        }
        msg += `You can claim or redeem your points under the *New Application ➔ New Reward Claim* menu on your portal.`;

        if (sendTelegramPhoto) {
            await sendTelegramPhoto(screenshotPath, msg, chatId);
        } else {
            await sendTelegram(msg, chatId);
        }
    } catch (err) {
        console.error('[PortalAgent] Error checking rewards:', err);
        await sendTelegram(`⚠️ Error checking reward points: ${err.message}`, chatId);
    } finally {
        try { fs.unlinkSync(screenshotPath); } catch (_) {}
        await page.close().catch(() => {});
    }
}

module.exports = {
    MODULE_URLS,
    LEAVE_TYPE_MAP,
    ensurePortalSession,
    resolveLeaveType,
    draftLeaveApplication,
    officiallySubmitLeave,
    browseCirculars,
    checkRewardPoints
};
