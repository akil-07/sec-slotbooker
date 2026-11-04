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

const MONTH_NAMES = {
    january: 0, jan: 0,
    february: 1, feb: 1,
    march: 2, mar: 2,
    april: 3, apr: 3,
    may: 4,
    june: 5, jun: 5,
    july: 6, jul: 6,
    august: 7, aug: 7,
    september: 8, sept: 8, sep: 8,
    october: 9, oct: 9,
    november: 10, nov: 10,
    december: 11, dec: 11
};

/**
 * Normalizes time strings like "6pm", "10 pm", "6:00 pm", "18:00" into "06:00 PM"
 */
function parseTimeString(str) {
    if (!str) return null;
    const s = String(str).trim().toLowerCase();
    const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!m) return null;
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = m[3] ? m[3].toUpperCase() : null;

    if (ampm) {
        if (ampm === 'PM' && hour < 12) hour += 12;
        if (ampm === 'AM' && hour === 12) hour = 0;
    }
    const h12 = (hour % 12) === 0 ? 12 : (hour % 12);
    const resolvedAmPm = hour >= 12 ? 'PM' : 'AM';
    return `${String(h12).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${resolvedAmPm}`;
}

/**
 * Helper to parse Indian DD/MM/YYYY date strings and named month dates (e.g. "6th november", "nov 10") into JS Date objects
 */
function parseIndianDate(dateStr) {
    if (!dateStr) return null;
    if (dateStr instanceof Date && !isNaN(dateStr.getTime())) return dateStr;
    const s = String(dateStr).trim().toLowerCase().replace(/(st|nd|rd|th)/g, '');

    const now = new Date();
    const curYear = now.getFullYear();

    if (s === 'today') {
        return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    if (s === 'tomorrow') {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        d.setDate(d.getDate() + 1);
        return d;
    }
    if (s.includes('day after tomorrow')) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        d.setDate(d.getDate() + 2);
        return d;
    }

    // Match "6 november [2026]" or "6 nov"
    const dmMatch = s.match(/(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?/i);
    if (dmMatch && MONTH_NAMES[dmMatch[2].toLowerCase()] !== undefined) {
        const day = parseInt(dmMatch[1], 10);
        const month = MONTH_NAMES[dmMatch[2].toLowerCase()];
        const year = dmMatch[3] ? parseInt(dmMatch[3], 10) : curYear;
        return new Date(year, month, day);
    }

    // Match "november 6 [2026]" or "nov 6"
    const mdMatch = s.match(/([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?/i);
    if (mdMatch && MONTH_NAMES[mdMatch[1].toLowerCase()] !== undefined) {
        const month = MONTH_NAMES[mdMatch[1].toLowerCase()];
        const day = parseInt(mdMatch[2], 10);
        const year = mdMatch[3] ? parseInt(mdMatch[3], 10) : curYear;
        return new Date(year, month, day);
    }

    // Match DD/MM/YYYY or DD-MM-YYYY
    const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{4}))?/);
    if (dmy) {
        const day = parseInt(dmy[1], 10);
        const month = parseInt(dmy[2], 10) - 1;
        const year = dmy[3] ? parseInt(dmy[3], 10) : curYear;
        return new Date(year, month, day);
    }

    // Match YYYY-MM-DD
    const ymd = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (ymd) {
        const year = parseInt(ymd[1], 10);
        const month = parseInt(ymd[2], 10) - 1;
        const day = parseInt(ymd[3], 10);
        return new Date(year, month, day);
    }

    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
}

/**
 * Extracts date range and custom times from text
 * Supports natural patterns: "from 6th november 6pm to 10th november 10 pm" or "06/11/2026 to 10/11/2026"
 */
function extractDateRangeFromText(text) {
    if (!text) return null;
    const str = String(text);

    const monthKeys = Object.keys(MONTH_NAMES);
    monthKeys.sort((a, b) => b.length - a.length); // Longer month words match first
    const monthWords = monthKeys.join('|');

    const datePattern = `(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${monthWords})(?:\\s+\\d{4})?|\\d{1,2}[\\/\\-]\\d{1,2}(?:[\\/\\-]\\d{4})?)`;
    const timePattern = `(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm))`;

    const naturalRangeRegex = new RegExp(
        `(?:from\\s+)?(${datePattern})(?:\\s+(${timePattern}))?\\s+(?:to|-|until)\\s+(${datePattern})(?:\\s+(${timePattern}))?`,
        'i'
    );

    const nm = str.match(naturalRangeRegex);
    if (nm) {
        const d1 = parseIndianDate(nm[1]);
        const d2 = parseIndianDate(nm[3]);
        const t1 = nm[2] ? parseTimeString(nm[2]) : null;
        const t2 = nm[4] ? parseTimeString(nm[4]) : null;
        if (d1 && d2) {
            return { from: d1, to: d2, fromTime: t1, toTime: t2 };
        }
    }

    // Standard DD/MM/YYYY to DD/MM/YYYY fallback
    const rangeMatch = str.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})\s*(?:to|-|until)\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/i);
    if (rangeMatch) {
        const d1 = parseIndianDate(rangeMatch[1]);
        const d2 = parseIndianDate(rangeMatch[2]);
        if (d1 && d2) return { from: d1, to: d2 };
    }
    const shortRangeMatch = str.match(/(\d{1,2}[\/\-]\d{1,2})\s*(?:to|-|until)\s*(\d{1,2}[\/\-]\d{1,2})/i);
    if (shortRangeMatch) {
        const d1 = parseIndianDate(shortRangeMatch[1]);
        const d2 = parseIndianDate(shortRangeMatch[2]);
        if (d1 && d2) return { from: d1, to: d2 };
    }
    const singleMatch = str.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/);
    if (singleMatch) {
        const d = parseIndianDate(singleMatch[1]);
        if (d) return { from: d, to: d };
    }
    return null;
}

/**
 * Formats a Date object with custom or default time: DD/MM/YYYY hh:mm AM/PM
 */
function formatDateTimeWithCustomTime(dateObj, timeStr, defaultHour = 8, defaultMinute = 0, defaultAmPm = 'AM') {
    const d = (dateObj instanceof Date && !isNaN(dateObj.getTime())) ? dateObj : new Date();
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const datePrefix = `${day}/${month}/${year}`;

    if (timeStr) {
        const parsedTime = parseTimeString(timeStr);
        if (parsedTime) {
            return `${datePrefix} ${parsedTime}`;
        }
    }
    return formatPortalDateTime(d, defaultHour, defaultMinute, defaultAmPm);
}

/**
 * Format date/time to strictly compliant Saveetha format: DD/MM/YYYY hh:mm A (e.g. 06/11/2026 08:00 AM)
 * Always normalizes 24-hour hours (e.g. 20 -> 08:00 PM) to avoid invalid formats like 20:00 PM.
 */
function formatPortalDateTime(dateObj, hour = 8, minute = 0, ampm = null) {
    const d = (dateObj instanceof Date && !isNaN(dateObj.getTime())) ? dateObj : new Date();
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();

    let resolvedHour = Number(hour) || 0;
    let resolvedAmPm = ampm ? String(ampm).toUpperCase() : null;

    if (!resolvedAmPm) {
        resolvedAmPm = resolvedHour >= 12 ? 'PM' : 'AM';
    }

    let h12 = resolvedHour % 12;
    if (h12 === 0) h12 = 12;

    const hStr = String(h12).padStart(2, '0');
    const mStr = String(minute).padStart(2, '0');
    return `${day}/${month}/${year} ${hStr}:${mStr} ${resolvedAmPm}`;
}

/**
 * Fetches overlapping timetable schedules for a leave window directly from Saveetha's
 * schedules endpoint (/academics/workflow-requests/leave-applications/schedules/)
 * and falls back to inspecting the DOM table.
 */
async function fetchLeaveSchedulesFromPortal(page, fromStr, toStr) {
    let classes = [];

    // Approach 1: Directly query Saveetha's schedule preview JSON endpoint via page context
    try {
        const scheduleUrl = `/academics/workflow-requests/leave-applications/schedules/?leave_date_from=${encodeURIComponent(fromStr)}&leave_date_to=${encodeURIComponent(toStr)}`;
        const result = await page.evaluate(async (url) => {
            try {
                const res = await fetch(url, {
                    cache: 'no-store',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' }
                });
                if (!res.ok) return { ok: false, status: res.status };
                const text = await res.text();
                try {
                    const data = JSON.parse(text);
                    return { ok: true, html: (data && data.html) ? data.html : '' };
                } catch (_) {
                    return { ok: false, error: 'Non-JSON schedule response from server' };
                }
            } catch (e) {
                return { ok: false, error: e.message };
            }
        }, scheduleUrl);

        if (result && result.ok && result.html) {
            classes = await page.evaluate((html) => {
                const div = document.createElement('div');
                div.innerHTML = html;
                const rows = Array.from(div.querySelectorAll('tr'));
                return rows
                    .map(r => r.innerText.replace(/\s+/g, ' ').trim())
                    .filter(t => t.length > 0 && !t.toLowerCase().startsWith('type schedule role') && (t.includes('Academic') || t.includes('Student') || /\d{2}:\d{2}/.test(t)));
            }, result.html);

            if (classes.length > 0) {
                console.log(`[PortalAgent] Fetched ${classes.length} overlapping classes directly from schedule endpoint.`);
                return classes;
            }
        }
    } catch (err) {
        console.warn('[PortalAgent] Direct schedule fetch failed, falling back to DOM:', err.message);
    }

    // Approach 2: DOM fallback - wait for UI to update and scrape table
    await page.waitForTimeout(2500);
    classes = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tbody tr, [data-leave-schedule-preview] table tr'));
        const scheduleRows = rows.filter(r => {
            const txt = r.innerText.trim();
            return !txt.toLowerCase().startsWith('type schedule role') && (txt.includes('Academic') || txt.includes('Student') || /\d{2}:\d{2}/.test(txt));
        });
        return scheduleRows.map(r => r.innerText.replace(/\s+/g, ' ').trim());
    });

    console.log(`[PortalAgent] Fetched ${classes.length} overlapping classes from DOM table.`);
    return classes;
}

/**
 * Simplifies a raw Saveetha timetable schedule row into a clean, human-readable line:
 * "• 19AI305 — Advanced C Programming (Nov 02, 09:45 - 11:14)"
 */
function simplifyScheduleRow(row) {
    if (!row) return '';
    const str = String(row).replace(/\s+/g, ' ').trim();

    // 1. Extract course code & name: e.g. "19AI305 — Advanced C Programming"
    let subject = '';
    const codeNameMatch = str.match(/\b([0-9]{2}[A-Z]{2,4}[0-9]{3}[A-Z]?|[A-Z]+-[A-Z]+-[A-Z0-9]+|[A-Z]{3,4})\s*[-—–]\s*([A-Za-z0-9&/ ]+?)(?=\s+[0-9]{2}[A-Z0-9]{4,8}|\s+Student|\s+Nov|\s+Dec|\s+Jan|\s+Feb|\s+Mar|\s+Apr|\s+May|\s+Jun|\s+Jul|\s+Aug|\s+Sep|\s+Oct|$)/i);

    if (codeNameMatch) {

        subject = `${codeNameMatch[1].toUpperCase()} — ${codeNameMatch[2].trim()}`;
    } else {
        // Fallback: strip noise words
        subject = str.replace(/Academic|Student\s*·\s*Class|Student\s*:\s*Class|\d{4}/gi, '').trim();
    }

    // 2. Extract date & start-end times
    const times = str.match(/([A-Za-z]{3}\s+\d{1,2}(?:,\s*\d{4})?)\s+(\d{1,2}:\d{2})/g);
    let timeSnippet = '';
    if (times && times.length >= 2) {
        const dMatch = times[0].match(/([A-Za-z]{3}\s+\d{1,2})/);
        const t1 = times[0].match(/\d{1,2}:\d{2}/)[0];
        const t2 = times[1].match(/\d{1,2}:\d{2}/)[0];
        const datePart = dMatch ? dMatch[1] : '';
        timeSnippet = datePart ? `(${datePart}, ${t1} - ${t2})` : `(${t1} - ${t2})`;
    } else {
        const anyTimes = str.match(/\d{2}:\d{2}/g);
        if (anyTimes && anyTimes.length >= 2) {
            timeSnippet = `(${anyTimes[0]} - ${anyTimes[1]})`;
        }
    }

    return timeSnippet ? `• ${subject} ${timeSnippet}` : `• ${subject}`;
}

function formatOrdinalDate(dateObj) {
    const d = new Date(dateObj);
    const day = d.getDate();
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const month = months[d.getMonth()];
    const year = d.getFullYear();

    let suffix = 'th';
    if (day % 10 === 1 && day !== 11) suffix = 'st';
    else if (day % 10 === 2 && day !== 12) suffix = 'nd';
    else if (day % 10 === 3 && day !== 13) suffix = 'rd';

    return `${day}${suffix} ${month} ${year}`;
}

function formatShortDate(dateObj) {
    const d = new Date(dateObj);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${day}/${month}/${d.getFullYear()}`;
}

/**
 * Formulate official Saveetha Engineering College letter matching the exact college format
 */
function buildOfficialLeaveLetter({ leaveType, rawReason, fromDate, toDate, studentName, department }) {
    const fromOrd = formatOrdinalDate(fromDate);
    const toOrd = formatOrdinalDate(toDate);
    const datePhrase = fromOrd === toOrd ? `on ${fromOrd}` : `from ${fromOrd} to ${toOrd}`;
    const todayShort = formatShortDate(new Date());

    const isGatePass = (leaveType || '').includes('GatePass');
    const isOd = leaveType === 'OnDuty-Students';
    const isMedical = leaveType === 'Medical Leave - Students';

    let toRecipient = 'The Class Advisor / HOD\nSaveetha Engineering College\nChennai';
    let subjectLine = 'Request for Leave Permission';
    let p1 = `I am writing to request permission for leave ${datePhrase} due to ${rawReason || 'personal reasons'}.`;
    let p2 = `I kindly request you to grant me leave for the above-mentioned period. I will ensure that I catch up on all academic topics and resume my regular academic activities on ${toOrd}.`;

    if (isGatePass) {
        toRecipient = 'The Hostel Warden\nSaveetha Engineering College\nChennai';
        subjectLine = 'Request for Hostel Gate Pass';
        p1 = `I am writing to request permission to leave the hostel ${datePhrase} due to ${rawReason || 'personal reasons'}.`;
        p2 = `I kindly request you to grant me a gate pass for the above-mentioned period. I will return to the hostel on ${toOrd} and resume my regular hostel and academic activities.`;
    } else if (isOd) {
        toRecipient = 'The Head of the Department\nSaveetha Engineering College\nChennai';
        subjectLine = 'Request for On-Duty (OD) Permission';
        p1 = `I am writing to request On-Duty (OD) permission ${datePhrase} to participate in ${rawReason || 'an official college symposium / technical event'}.`;
        p2 = `I kindly request you to grant me On-Duty attendance for the above-mentioned period. I will ensure that I catch up on all academic topics and complete all coursework promptly.`;
    } else if (isMedical) {
        toRecipient = 'The Class Advisor / HOD\nSaveetha Engineering College\nChennai';
        subjectLine = 'Request for Medical Leave';
        p1 = `I am writing to request medical leave ${datePhrase} due to ${rawReason || 'ill health and medical rest'}.`;
        p2 = `I kindly request you to grant me medical leave for the above-mentioned period. I will ensure that I catch up on all missed academic topics and resume regular classes on ${toOrd}.`;
    }

    const p3 = 'I shall be grateful for your kind consideration and approval.';

    let formattedName = studentName || 'Akil S.';
    if (!formattedName || formattedName.toLowerCase().startsWith('user') || formattedName.includes('25013635') || formattedName.toLowerCase().includes('akil')) {
        formattedName = 'Akil S.';
    }
    const deptLine = department || 'B.Tech – Information Technology';

    return {
        subject: subjectLine,
        letterText: `To\n${toRecipient}\n\nSubject: ${subjectLine}\n\nRespected Sir,\n\n${p1}\n\n${p2}\n\n${p3}\n\nThank you.\n\nYours obediently,\n${formattedName}\n${deptLine}\nSaveetha Engineering College\nDate: ${todayShort}`
    };
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 80% ATTENDANCE IMPACT ENGINE
 * ─────────────────────────────────────────────────────────────────────────────
 * Computes whether taking leave during a given date window will cause any subject
 * to drop below Saveetha's mandatory 80% attendance rule.
 */
function calculateAttendanceLeaveImpact(attendanceRecords, overlappingClasses, options = {}) {
    if (!Array.isArray(attendanceRecords) || attendanceRecords.length === 0) {
        return {
            hasRecords: false,
            summaryMsg: '⚠️ _Could not cross-reference attendance records (no subjects loaded)._'
        };
    }

    const isGlobalOd = Boolean(options.isOd);
    const odTargetCount = Number(options.odCount) || 0;
    const odTargetSubject = options.odSubject ? String(options.odSubject).toLowerCase() : null;
    let remainingOdBudget = odTargetCount;

    // 1. Group overlapping classes by subject identifier
    const missedCounts = {}; // subjectKey -> count

    (overlappingClasses || []).forEach(cls => {
        const str = String(cls).trim();
        // Look for course code e.g. 19AI305, 19EY709, ECA-SCOFT-M, 19CS404
        const codeMatch = str.match(/\b(\d{2}[A-Z]{2,4}\d{3}[A-Z]?|[A-Z]+-[A-Z]+-[A-Z0-9]+)\b/i);
        const code = codeMatch ? codeMatch[1].toUpperCase() : null;

        const namePart = str.replace(/Academic|Student\s*·\s*Class|\d{2}:\d{2}|[0-9]{4}/gi, ' ').trim().toLowerCase();

        let matchedRecord = null;
        if (code) {
            matchedRecord = attendanceRecords.find(r => (r.subject || '').toUpperCase().includes(code));
        }
        if (!matchedRecord) {
            matchedRecord = attendanceRecords.find(r => {
                const subLow = (r.subject || '').toLowerCase();
                const subWords = subLow.split(/\s+/).filter(w => w.length > 3);
                return subWords.some(w => namePart.includes(w));
            });
        }

        const key = matchedRecord ? matchedRecord.subject : (code || str);
        missedCounts[key] = (missedCounts[key] || 0) + 1;
    });

    const analysis = [];
    let criticalDropCount = 0;
    let semCriticalDropCount = 0;
    let totalMissedSessions = 0;
    let totalOdSessions = 0;

    for (const record of attendanceRecords) {
        const subName = record.subject;
        const k = missedCounts[subName] || 0;
        totalMissedSessions += k;

        let attended = parseFloat(record.attended);
        let total = parseFloat(record.total);
        let currentPct = parseFloat(String(record.percent || '').replace('%', ''));

        if ((isNaN(attended) || isNaN(total)) && !isNaN(currentPct)) {
            total = 20;
            attended = Math.round((currentPct / 100) * total);
        }

        if (isNaN(attended) || isNaN(total) || total <= 0) {
            continue;
        }

        // On-Duty (OD) resolution for this subject:
        let kOd = 0;
        if (isGlobalOd) {
            kOd = k; // all classes in this window are credited as OD
        } else if (odTargetSubject && subName.toLowerCase().includes(odTargetSubject)) {
            kOd = odTargetCount > 0 ? Math.min(k, odTargetCount) : k;
        } else if (remainingOdBudget > 0 && k > 0) {
            kOd = Math.min(k, remainingOdBudget);
            remainingOdBudget -= kOd;
        }
        totalOdSessions += kOd;
        const kReg = Math.max(0, k - kOd); // unexcused absences if any

        // In Saveetha, 1 class = 2 credit hours (e.g. 4/8 on portal means 2 classes attended / 4 conducted)
        const kHours = k * 2;
        const kOdHours = kOd * 2;
        const kRegHours = kReg * 2;

        // Under Saveetha OD policy: OD sessions count as PRESENT (attended increases)!
        const projectedAttended = attended + kOdHours;
        const newTotal = total + kHours;
        const projectedPercent = (projectedAttended / newTotal) * 100;
        const currentPercent = (attended / total) * 100;
        const pctDiff = projectedPercent - currentPercent;

        const isCurrentBelow80 = currentPercent < 80.0;
        const isProjectedBelow80 = projectedPercent < 80.0;
        const dropsBelow80 = !isCurrentBelow80 && isProjectedBelow80;

        // Consecutive classes (each = 2 hrs) needed to recover back to 80% immediately:
        // (projectedAttended + R*2) / (newTotal + R*2) >= 0.8  =>  2*R >= 4*newTotal - 5*projectedAttended
        let recoveryClassesNeeded = 0;
        if (isProjectedBelow80) {
            recoveryClassesNeeded = Math.max(0, Math.ceil((4 * newTotal - 5 * projectedAttended) / 2));
        }

        // Buffer classes remaining immediately if projected >= 80%:
        let bufferRemaining = 0;
        if (!isProjectedBelow80) {
            bufferRemaining = Math.max(0, Math.floor((5 * projectedAttended - 4 * newTotal) / 8));
        }

        if (isProjectedBelow80 && kReg > 0) {
            criticalDropCount++;
        }

        // ── Whole Semester Projection ──
        const pastMissedHours = Math.max(0, total - attended);
        const totalMissedHoursWithLeave = pastMissedHours + kRegHours;

        // Total semester classes (Saveetha courses typically have ~41-45 classes = ~82-90 hrs)
        let semTotalClasses = 41;
        if (record.totalSessions && !isNaN(parseFloat(record.totalSessions))) {
            const raw = parseFloat(record.totalSessions);
            semTotalClasses = raw > 60 ? Math.round(raw / 2) : Math.round(raw);
        } else if (total >= 40) {
            semTotalClasses = Math.max(41, Math.round(total / 2) + 12);
        } else {
            semTotalClasses = Math.max(41, Math.round(total / 2) + 25);
        }

        const semTotalHours = semTotalClasses * 2;
        const conductedClasses = Math.round(total / 2);
        const remainingSemClasses = Math.max(0, semTotalClasses - conductedClasses - k);
        const maxSemAttendedHours = projectedAttended + (remainingSemClasses * 2);
        const endOfSemMaxPercent = Math.round(((maxSemAttendedHours / semTotalHours) * 100) * 10) / 10;
        const maxAllowedSemAbsenceHours = Math.floor(0.20 * semTotalHours);
        const willDropBelow80WholeSem = totalMissedHoursWithLeave > maxAllowedSemAbsenceHours;
        const minRequiredToAttendTillSemEnd = Math.max(0, Math.ceil((0.80 * semTotalHours - projectedAttended) / 2));
        const semBunkCushion = Math.max(0, Math.floor((maxAllowedSemAbsenceHours - totalMissedHoursWithLeave) / 2));

        // Bunk / Cutoff bonus gained from OD:
        const odCutoffBonus = kOd;

        if (willDropBelow80WholeSem && kReg > 0) {
            semCriticalDropCount++;
        }

        analysis.push({
            subject: subName,
            missedCount: k,
            kOd,
            kReg,
            odCutoffBonus,
            currentAttended: attended,
            currentTotal: total,
            currentPercent: Math.round(currentPercent * 10) / 10,
            projectedAttended,
            projectedTotal: newTotal,
            projectedPercent: Math.round(projectedPercent * 10) / 10,
            pctDiff: Math.round(pctDiff * 10) / 10,
            isCurrentBelow80,
            isProjectedBelow80,
            dropsBelow80,
            recoveryClassesNeeded,
            bufferRemaining,
            // Whole semester stats
            semTotal,
            remainingSemClasses,
            pastMissed,
            totalMissedWithLeave,
            endOfSemMaxPercent,
            maxAllowedSemAbsences,
            willDropBelow80WholeSem,
            minRequiredToAttendTillSemEnd,
            semBunkCushion
        });
    }

    // Sort:
    analysis.sort((a, b) => {
        if (a.missedCount > 0 && b.missedCount === 0) return -1;
        if (a.missedCount === 0 && b.missedCount > 0) return 1;
        if (a.willDropBelow80WholeSem && !b.willDropBelow80WholeSem) return -1;
        if (!a.willDropBelow80WholeSem && b.willDropBelow80WholeSem) return 1;
        if (a.isProjectedBelow80 && !b.isProjectedBelow80) return -1;
        if (!a.isProjectedBelow80 && b.isProjectedBelow80) return 1;
        return a.projectedPercent - b.projectedPercent;
    });

    return {
        hasRecords: true,
        isOd: Boolean(isGlobalOd || totalOdSessions > 0),
        totalOdSessions,
        criticalDropCount,
        semCriticalDropCount,
        totalMissedSessions,
        items: analysis
    };
}

function formatAttendanceImpactMessage(impact, fromStr = '', toStr = '') {
    if (!impact || !impact.hasRecords) {
        return impact ? impact.summaryMsg : '';
    }

    const { isOd, totalOdSessions, criticalDropCount, semCriticalDropCount, items } = impact;
    const impactedItems = items.filter(it => it.missedCount > 0);
    const untouchedCount = items.length - impactedItems.length;

    if (impactedItems.length === 0) {
        return `✅ *Safe to Leave:* No classes fall into this leave window. Your attendance is completely unaffected.`;
    }

    let msg = isOd
        ? `📊 *On-Duty (OD) Attendance & Bunk Cutoff Analysis*\n`
        : `📊 *80% Attendance Impact Analysis*\n`;

    // High level verdict banner
    if (isOd) {
        msg += `🎯 *Verdict:* 🎖️ *Protected under On-Duty (OD)!* (${totalOdSessions} class(es) credited as Present)\n`;
    } else if (semCriticalDropCount > 0) {
        msg += `🎯 *Verdict:* 🚨 *Permanent Shortage in ${semCriticalDropCount} subject(s)!*\n`;
    } else if (criticalDropCount > 0) {
        msg += `🎯 *Verdict:* ⚠️ *Temporary Dip, but Safe on Whole Sem!* (Recoverable)\n`;
    } else {
        msg += `🎯 *Verdict:* ✅ *Safe to take leave!* All subjects stay ≥80% through semester end.\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    // Clean, crisp per-subject breakdown
    for (const it of impactedItems) {
        const subDisplay = it.subject.replace(/([_*`\[\]])/g, '').replace(/\s+/g, ' ').trim();
        const dropSign = it.pctDiff >= 0 ? `+${it.pctDiff}%` : `${it.pctDiff}%`;
        const trendIcon = it.pctDiff >= 0 ? '🔼' : '🔻';

        let icon = '✅';
        if (it.kOd > 0) {
            icon = '🎖️';
        } else if (it.willDropBelow80WholeSem) {
            icon = '🚨';
        } else if (it.isProjectedBelow80) {
            icon = '⚠️';
        }

        msg += `${icon} *${subDisplay}*\n`;

        if (it.kOd > 0) {
            msg += `• *OD Credit:* ${it.kOd} class(es) marked 100% Present!${it.kReg > 0 ? ` (${it.kReg} regular absence)` : ''}\n`;
            msg += `• *Attendance:* ${it.currentPercent}% ➔ *${it.projectedPercent}%* ${trendIcon} [${dropSign}]\n`;
            msg += `• *Bunk Cutoff Bonus:* You gain *+${it.odCutoffBonus} extra class(es)* you can safely cutoff/bunk later!\n`;
            msg += `• *Sem Outlook:* Up to *${it.endOfSemMaxPercent}%* (Cushion: *${it.semBunkCushion} more bunks* allowed this sem)\n\n`;
        } else if (it.willDropBelow80WholeSem) {
            msg += `• *Classes Missed:* ${it.missedCount}\n`;
            msg += `• *Attendance:* ${it.currentPercent}% ➔ *${it.projectedPercent}%* 🔻 [${dropSign}]\n`;
            msg += `• *Sem Outlook:* Max *${it.endOfSemMaxPercent}%* (Permanent Shortage 🚨)\n`;
            msg += `• ⚠️ Exceeds semester limit (${it.totalMissedWithLeave}/${it.maxAllowedSemAbsences} missed). Cannot reach 80% even with 100% future attendance.\n\n`;
        } else if (it.isProjectedBelow80) {
            msg += `• *Classes Missed:* ${it.missedCount}\n`;
            msg += `• *Attendance:* ${it.currentPercent}% ➔ *${it.projectedPercent}%* 🔻 [${dropSign}]\n`;
            msg += `• *Sem Outlook:* Up to *${it.endOfSemMaxPercent}%* (Safe ✅)\n`;
            msg += `• *Cushion:* Can still miss *${it.semBunkCushion} more class(es)* this sem (Needs ${it.recoveryClassesNeeded} classes to recover immediately).\n\n`;
        } else {
            msg += `• *Classes Missed:* ${it.missedCount}\n`;
            msg += `• *Attendance:* ${it.currentPercent}% ➔ *${it.projectedPercent}%* 🔻 [${dropSign}]\n`;
            msg += `• *Sem Outlook:* Up to *${it.endOfSemMaxPercent}%* (Safe ✅)\n`;
            msg += `• *Bunk Cushion:* Can still miss *${it.semBunkCushion} more class(es)* this semester.\n\n`;
        }
    }

    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    if (isOd) {
        msg += `💡 *OD Advantage:* Because OD classes are credited as Attended, you don't lose percentage and you unlock *+${totalOdSessions} extra bunk(s)* later in the sem!\n`;
    } else if (impactedItems.length > 0) {
        const totalMissed = impactedItems.reduce((acc, i) => acc + i.missedCount, 0);
        msg += `💡 *OD Tip:* If you apply for On-Duty (OD) instead of leave for these classes, you gain *+${totalMissed} extra class(es)* you can safely bunk later!\n`;
    }
    if (untouchedCount > 0) {
        msg += `ℹ️ _${untouchedCount} other subject(s) have no classes during this leave._\n`;
    }

    return msg.trim();
}

/**
 * 1. AUTOMATED LEAVE & OD APPLICATION DRAFTING & SUBMISSION
 */
async function draftLeaveApplication(session, leaveData, chatId, sendTelegram, sendTelegramPhoto, pendingConfirmations, callSmartAI = null, fetchAttendanceFn = null) {
    let page;
    try {
        page = await session.context.newPage();
    } catch (err) {
        console.error('[PortalAgent] Failed to open new tab:', err.message);
        await sendTelegram(`⚠️ Could not open browser tab: ${err.message}`, chatId);
        return { success: false, error: err.message };
    }
    await page.setViewportSize({ width: 1400, height: 900 }).catch(() => { });
    const screenshotPath = path.join(__dirname, `_leave_draft_${Date.now()}.png`);

    try {
        await ensurePortalSession(page, session);
        await sendTelegram(`⏳ *Opening Workflow Engine on Saveetha Portal...*`, chatId);

        // 1. Navigate directly to Leave Application creation form
        console.log('[PortalAgent] Navigating to Leave Application form...');
        try {
            await page.goto('https://learner.saveetha.in/academics/workflow-requests/leave-applications/create/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (_) {
            await page.goto(MODULE_URLS.workflow_requests, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(2000);
            const newAppBtn = await page.locator('button:has-text("New Application"), a:has-text("New Application"), .dropdown-toggle:has-text("Application")').first();
            await newAppBtn.waitFor({ state: 'visible', timeout: 15000 });
            await newAppBtn.click();
            await page.waitForTimeout(800);
            const leaveAppOption = await page.locator('a:has-text("New Leave Application"), button:has-text("New Leave Application")').first();
            await leaveAppOption.waitFor({ state: 'visible', timeout: 10000 });
            await leaveAppOption.click();
        }
        await page.waitForTimeout(2500);

        // 2. Parse Leave Type & Target Workflow
        const rawTypeStr = (leaveData.type || leaveData.leaveType || '').toLowerCase();
        const rawReasonStr = (leaveData.reason || leaveData.content || '').toLowerCase();
        const isHostel = rawTypeStr.includes('hostel') || rawTypeStr.includes('gatepass') || rawReasonStr.includes('hostel') || rawReasonStr.includes('gate pass');
        const isOd = rawTypeStr.includes('od') || rawTypeStr.includes('onduty') || rawTypeStr.includes('on-duty');
        const isMedical = rawTypeStr.includes('medical') || rawTypeStr.includes('sick') || rawTypeStr.includes('fever');

        // Strictly select HostelGatePass (NOT EmergencyHostelGatePass) or Leave-Students or OnDuty-Students
        let targetWorkflow = 'Leave-Students';
        let formLeaveTypeValue = 'Leave';
        if (isHostel) {
            targetWorkflow = 'HostelGatePass'; // Strictly non-emergency per college policy
            formLeaveTypeValue = 'GatePass';
        } else if (isOd) {
            targetWorkflow = 'OnDuty-Students';
            formLeaveTypeValue = 'OD';
        } else if (isMedical) {
            targetWorkflow = 'Medical Leave - Students';
            formLeaveTypeValue = 'ML';
        }

        const resolvedType = targetWorkflow;

        // 3. Parse Dates & Times (support fromDate/toDate and natural regex extraction from text)
        const textToScan = `${leaveData.title || ''} ${leaveData.reason || ''} ${leaveData.content || ''} ${leaveData.query || ''} ${leaveData.rawText || ''}`;
        const extractedRange = extractDateRangeFromText(textToScan);

        let targetDate = leaveData.fromDate ? parseIndianDate(leaveData.fromDate) : (leaveData.date ? parseIndianDate(leaveData.date) : null);
        let targetDateTo = leaveData.toDate ? parseIndianDate(leaveData.toDate) : null;

        // If user query/text contains an explicit date range (e.g. 6th november to 10th november), prioritize it
        if (extractedRange && extractedRange.from && extractedRange.to) {
            targetDate = extractedRange.from;
            targetDateTo = extractedRange.to;
        } else if (!targetDate && extractedRange) {
            targetDate = extractedRange.from;
            if (!targetDateTo) targetDateTo = extractedRange.to;
        }

        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        if (!targetDate) {
            targetDate = leaveData.isTomorrow ? tomorrow : today;
        }
        if (!targetDateTo) {
            targetDateTo = targetDate;
        }

        // Custom hours/times support (e.g. 6pm, 10 pm, 18:00)
        const fromTimeVal = leaveData.fromTime || extractedRange?.fromTime || null;
        const toTimeVal = leaveData.toTime || extractedRange?.toTime || null;

        const fromStr = formatDateTimeWithCustomTime(targetDate, fromTimeVal, 8, 0, 'AM');
        const toStr = formatDateTimeWithCustomTime(targetDateTo, toTimeVal, 8, 0, 'PM');

        // Extract clean meaningful reason (e.g. "for diwali" -> "Diwali celebrations with family")
        let reason = leaveData.reason || leaveData.content || '';
        const diwaliMatch = textToScan.match(/diwali/i);
        if (diwaliMatch) {
            reason = 'Diwali celebrations with family';
        } else if (!reason || reason.includes('from') || reason.includes('to') || reason.length < 5) {
            const forMatch = textToScan.match(/(?:for|due to|because of)\s+([a-zA-Z0-9\s]+?)(?:\.|$)/i);
            if (forMatch && forMatch[1].trim().length > 2) {
                reason = forMatch[1].trim();
            } else {
                reason = isHostel ? 'Need permission to leave hostel for personal reasons.' : (isOd ? 'Participating in technical event/symposium representing college.' : 'Unable to attend classes due to personal reasons.');
            }
        }

        const fromDStr = `${String(targetDate.getDate()).padStart(2, '0')}/${String(targetDate.getMonth() + 1).padStart(2, '0')}/${targetDate.getFullYear()}`;
        const toDStr = `${String(targetDateTo.getDate()).padStart(2, '0')}/${String(targetDateTo.getMonth() + 1).padStart(2, '0')}/${targetDateTo.getFullYear()}`;
        let title = (isHostel ? `Hostel Gate Pass ${fromDStr}` : (isOd ? `OD ${fromDStr} to ${toDStr}` : `Leave ${fromDStr} to ${toDStr}`));
        if (title.length > 50) title = title.substring(0, 50);

        let subject = leaveData.subject || (isHostel ? 'Request for Hostel Gate Pass' : (isOd ? 'Request for On-Duty (OD) Attendance' : 'Request for Leave Permission'));

        console.log(`[PortalAgent] Filling Leave Form: Type=${formLeaveTypeValue}, Workflow=${targetWorkflow}, From=${fromStr}, To=${toStr}`);

        // A. Short Title *
        const titleInput = page.locator('#id_short_title, input[name="short_title"], input[placeholder*="title" i]').first();
        if (await titleInput.isVisible()) {
            await titleInput.fill(title);
            await titleInput.evaluate((el, val) => {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }, title);
        }

        // B. Leave Type * Dropdown (#id_leavetype)
        const typeSelect = page.locator('#id_leavetype, select[name="leavetype"]').first();
        if (await typeSelect.isVisible()) {
            console.log(`[PortalAgent] Selecting Leave Type value: ${formLeaveTypeValue}`);
            await typeSelect.selectOption(formLeaveTypeValue).catch(async () => {
                await typeSelect.selectOption({ label: formLeaveTypeValue }).catch(() => { });
            });
            await page.waitForTimeout(500);
        }

        // C. Dates: From and To (Strict Saveetha format: DD/MM/YYYY hh:mm A)
        const fromInput = page.locator('#id_leave_date_from, input[name="leave_date_from"]').first();
        if (await fromInput.isVisible()) {
            await fromInput.click();
            await fromInput.fill(fromStr);
            await fromInput.evaluate((el, val) => {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
            }, fromStr);
        }

        const toInput = page.locator('#id_leave_date_to, input[name="leave_date_to"]').first();
        if (await toInput.isVisible()) {
            await toInput.click();
            await toInput.fill(toStr);
            await toInput.evaluate((el, val) => {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
            }, toStr);
        }

        // Generate exact official letter matching Saveetha format
        let studentName = session.config ? (session.config.name || 'Akil S.') : 'Akil S.';
        if (!studentName || studentName.toLowerCase().startsWith('user') || studentName.includes('25013635')) {
            studentName = 'Akil S.';
        }
        const department = session.config ? (session.config.department || 'B.Tech – Information Technology') : 'B.Tech – Information Technology';
        const officialDoc = buildOfficialLeaveLetter({
            leaveType: targetWorkflow,
            rawReason: reason,
            fromDate: targetDate,
            toDate: targetDateTo,
            studentName,
            department
        });
        const letterBody = officialDoc.letterText;
        if (!leaveData.subject) {
            subject = officialDoc.subject;
        }

        // D. Subject * (fill with resolved official subject)
        const subjectInput = page.locator('#id_subject, input[name="subject"]').first();
        if (await subjectInput.isVisible()) {
            await subjectInput.fill(subject);
            await subjectInput.evaluate((el, val) => {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }, subject);
        }

        // E. Content * (Saveetha uses TinyMCE for #id_content)
        await page.evaluate((text) => {
            const html = text
                .split(/\n\s*\n/)
                .filter(p => p.trim().length > 0)
                .map(para => `<p>${para.trim().replace(/\n/g, '<br>')}</p>`)
                .join('');

            if (window.tinymce && window.tinymce.get('id_content')) {
                window.tinymce.get('id_content').setContent(html);
                window.tinymce.triggerSave();
            }
            const textarea = document.querySelector('#id_content');
            if (textarea) {
                textarea.value = html;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const iframe = document.querySelector('#id_content_ifr');
            if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
                iframe.contentDocument.body.innerHTML = html;
            }
        }, letterBody);

        // Allow live timetable query to trigger and populate Schedules During Leave
        await page.waitForTimeout(3000);

        // 4. Scrape Overlapping Schedules
        console.log('[PortalAgent] Checking overlapping schedules during leave duration...');
        const overlappingClasses = await fetchLeaveSchedulesFromPortal(page, fromStr, toStr);

        // 5. STEP 3: Click "Save Draft" button on the Leave Application form!
        console.log('[PortalAgent] Submitting "Save Draft" button...');
        const saveDraftBtn = page.locator('button[type="submit"]:has-text("Save Draft"), button:has-text("Save Draft"), input[value*="Save Draft"]').first();
        if (await saveDraftBtn.isVisible()) {
            await page.evaluate(() => {
                if (window.tinymce) {
                    try { window.tinymce.triggerSave(); } catch (_) { }
                }
            });

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 35000 }).catch(e => {
                    console.warn('[PortalAgent] Navigation wait after Save Draft:', e.message);
                }),
                saveDraftBtn.click({ force: true })
            ]);
            console.log('[PortalAgent] "Save Draft" submitted. Current URL:', page.url());
            await page.waitForTimeout(2000);
        }

        // Verify draft was successfully created and not stopped by validation errors
        let leaveIdMatch = page.url().match(/\/leave-applications\/(\d+)\//);
        let leaveAppId = leaveIdMatch ? leaveIdMatch[1] : null;

        if (!leaveAppId && page.url().includes('/leave-applications/create/')) {
            // Check for REAL Django form validation errors (strictly exclude live schedule preview box)
            const realFormErrors = await page.evaluate(() => {
                const previewSec = document.querySelector('#leave-schedule-preview-section');
                const alterationSec = document.querySelector('#staff-leave-alteration-section');

                const errNodes = Array.from(document.querySelectorAll('.invalid-feedback, ul.errorlist, .alert-danger, .has-error'));
                return errNodes.filter(node => {
                    if (previewSec && previewSec.contains(node)) return false;
                    if (alterationSec && alterationSec.contains(node)) return false;
                    if (node.getAttribute('data-leave-schedule-error') !== null) return false;
                    if (node.id === 'alteration-live-error') return false;
                    const txt = (node.innerText || '').trim();
                    if (!txt || txt.includes('Unable to load schedules') || txt.includes('not valid JSON')) return false;
                    return true;
                }).map(node => node.innerText.trim());
            });

            if (realFormErrors.length > 0) {
                throw new Error(`Saveetha portal rejected leave draft: ${realFormErrors.join(' | ')}`);
            }

            // If no form errors on create page, check if the draft was created on the dashboard
            console.log('[PortalAgent] Checking dashboard to confirm if draft was saved...');
            await page.goto(MODULE_URLS.workflow_requests, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2000);

            const dashboardDraftId = await page.evaluate(() => {
                const openLinks = Array.from(document.querySelectorAll('a[href*="/leave-applications/"], button[onclick*="/leave-applications/"]'));
                for (const l of openLinks) {
                    const href = l.getAttribute('href') || l.getAttribute('onclick') || '';
                    const m = href.match(/\/leave-applications\/(\d+)\//);
                    if (m) return m[1];
                }
                return null;
            });

            if (dashboardDraftId) {
                leaveAppId = dashboardDraftId;
                console.log(`[PortalAgent] Found saved draft ID #${leaveAppId} on dashboard.`);
            } else {
                throw new Error('Saveetha portal server did not respond in time to create the draft. Please try again.');
            }
        }

        let assignedWorkflow = targetWorkflow;
        if (leaveAppId) {
            console.log(`[PortalAgent] Navigating to Approval Flow tab for draft #${leaveAppId}...`);
            await page.goto(`https://learner.saveetha.in/academics/workflow-requests/leave-applications/${leaveAppId}/?tab=workflow`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(1500);

            const workflowSelect = page.locator('#id_approval_workflow, select[name="approval_workflow"]').first();
            if (await workflowSelect.isVisible()) {
                const availableWorkflows = (await workflowSelect.locator('option').allTextContents()).map(o => o.trim());
                console.log('[PortalAgent] Available Approval Workflows:', availableWorkflows);

                const matched = availableWorkflows.find(w => w.toLowerCase() === targetWorkflow.toLowerCase()) || targetWorkflow;
                console.log(`[PortalAgent] Selecting Approval Workflow: ${matched}`);
                await workflowSelect.selectOption({ label: matched }).catch(async () => {
                    await workflowSelect.selectOption({ value: matched }).catch(() => { });
                });
                assignedWorkflow = matched;
                await page.waitForTimeout(800);

                // Click "Save Workflow" button on Approval Flow tab
                const saveWorkflowBtn = page.locator('button[type="submit"][value="select_workflow"], button:has-text("Save Workflow")').first();
                if (await saveWorkflowBtn.isVisible()) {
                    console.log('[PortalAgent] Clicking "Save Workflow" button...');
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
                        saveWorkflowBtn.click()
                    ]);
                    await page.waitForTimeout(1500);
                }
            }

            // Return to confirmed draft view (?tab=leave) displaying complete details & "Leave draft saved" alert
            await page.goto(`https://learner.saveetha.in/academics/workflow-requests/leave-applications/${leaveAppId}/?tab=leave`, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(1500);
        } else {
            console.log('[PortalAgent] Navigating to Workflow Requests dashboard...');
            await page.goto(MODULE_URLS.workflow_requests, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2000);
        }

        // Clean up screenshot view: dismiss overlapping sidebar and hide irrelevant staff-only alteration box
        await page.evaluate(() => {
            document.body.classList.remove('sb-sidenav-toggled');
            const nav = document.querySelector('#layoutSidenav_nav');
            if (nav) nav.style.display = 'none';
            const alterationSec = document.querySelector('#staff-leave-alteration-section');
            if (alterationSec) alterationSec.style.display = 'none';
        }).catch(() => { });

        // Capture clean full page screenshot of the verified draft application!
        await page.screenshot({ path: screenshotPath, fullPage: true });

        // 8. 80% Attendance Impact Analysis
        let attendanceImpactStr = '';
        let criticalDropCount = 0;
        try {
            let attendanceRecords = [];
            if (fetchAttendanceFn && session && session.context) {
                console.log('[PortalAgent] Cross-referencing 80% attendance impact...');
                attendanceRecords = await fetchAttendanceFn(session.context, session.config).catch(() => []);
            }
            if (attendanceRecords && attendanceRecords.length > 0) {
                const impact = calculateAttendanceLeaveImpact(attendanceRecords, overlappingClasses);
                criticalDropCount = impact.criticalDropCount || 0;
                attendanceImpactStr = '\n' + formatAttendanceImpactMessage(impact, fromStr, toStr) + '\n';
            }
        } catch (e) {
            console.warn('[PortalAgent] Attendance impact calculation skipped:', e.message);
        }

        // 9. Format Telegram Report for Student
        let classListStr = '';
        if (overlappingClasses.length > 0) {
            classListStr = `\n📚 *Scheduled Classes Covered (${overlappingClasses.length}):*\n` +
                overlappingClasses.map(c => simplifyScheduleRow(c)).join('\n');
        } else {
            classListStr = `\nℹ️ *Overlapping Classes:* None detected for this specific window.`;
        }

        const workflowStr = assignedWorkflow ? `\n🔄 *Assigned Approval Flow:* \`${assignedWorkflow}\`` : '';

        // Format complete user-facing report with the exact drafted letter included
        const fullReportMsg =
            `📝 *Leave / OD Application Prepared & Drafted!*\n\n` +
            `• *Type:* \`${resolvedType}\`\n` +
            `• *Title:* *${title}*\n` +
            `• *Subject:* ${subject}\n` +
            `• *From:* \`${fromStr}\`\n` +
            `• *To:* \`${toStr}\`\n` +
            workflowStr + `\n` +
            classListStr + `\n` +
            attendanceImpactStr + `\n` +
            `📄 *Drafted Application Letter:*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `${letterBody}\n` +
            `━━━━━━━━━━━━━━━━━━━━\n\n` +
            `⚠️ *Ready for Official Submission:*\n` +
            `The draft has been populated on your Saveetha portal. Check the attached screenshot!\n\n` +
            `👉 Reply *submit* or *apply* to officially route this to your Mentor/HOD.\n` +
            `👉 Reply *cancel* to keep it as an unsubmitted draft.`;

        // Send photo with concise caption (avoiding Telegram 1024 char caption limit), then send complete letter in message
        if (sendTelegramPhoto) {
            const riskWarning = criticalDropCount > 0
                ? `• ⚠️ *WARNING:* ${criticalDropCount} subject(s) will drop below 80%!\n`
                : `• ✅ *80% Rule:* All subjects remain safe (≥ 80%)\n`;

            const photoCaption =
                `📝 *Leave / OD Drafted on Portal*\n\n` +
                `• *Type:* \`${resolvedType}\`\n` +
                `• *Duration:* \`${fromStr}\` ➔ \`${toStr}\`\n` +
                `• *Classes Covered:* ${overlappingClasses.length}\n` +
                riskWarning + `\n` +
                `👉 _See the full attendance impact & letter below!_`;
            await sendTelegramPhoto(screenshotPath, photoCaption, chatId);
        }
        await sendTelegram(fullReportMsg, chatId);

        // Store pending submission context with exact draft ID
        if (pendingConfirmations) {
            pendingConfirmations.set(chatId, {
                action: 'confirm_leave_submission',
                resolvedType,
                title,
                draftId: leaveAppId,
                targetUrl: page.url()
            });
        }

        return { success: true, type: resolvedType, classesCount: overlappingClasses.length, draftId: leaveAppId };
    } catch (err) {
        console.error('[PortalAgent] Error drafting leave application:', err);
        await sendTelegram(`⚠️ Error preparing leave application: ${err.message}`, chatId);
        return { success: false, error: err.message };
    } finally {
        try { fs.unlinkSync(screenshotPath); } catch (_) { }
        if (page && !page.isClosed()) {
            await page.close().catch(() => { });
        }
    }
}

/**
 * 2. SUBMIT / APPLY CONFIRMED DRAFT
 */
async function officiallySubmitLeave(session, chatId, sendTelegram, sendTelegramPhoto, draftId = null) {
    let page;
    try {
        page = await session.context.newPage();
    } catch (err) {
        console.error('[PortalAgent] Failed to open new tab:', err.message);
        await sendTelegram(`⚠️ Could not open browser tab: ${err.message}`, chatId);
        return { success: false, error: err.message };
    }
    const screenshotPath = path.join(__dirname, `_leave_submitted_${Date.now()}.png`);

    try {
        await ensurePortalSession(page, session);
        await sendTelegram(`🚀 *Submitting your leave application to the approval flow...*`, chatId);

        if (draftId) {
            console.log(`[PortalAgent] Directly opening draft #${draftId} workflow tab...`);
            await page.goto(`https://learner.saveetha.in/academics/workflow-requests/leave-applications/${draftId}/?tab=workflow`, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(2000);
        } else {
            console.log('[PortalAgent] Navigating to Workflow Requests dashboard...');
            await page.goto(MODULE_URLS.workflow_requests, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(2000);

            // Click on the most recent draft item [Open] button
            const draftItem = page.locator('.card:has-text("Draft") button:has-text("Open"), .card:has-text("Draft") a:has-text("Open"), button:has-text("Open"), a:has-text("Open"), a:has-text("Draft"), tr:has-text("Draft") a').first();
            if (await draftItem.isVisible()) {
                await draftItem.click();
                await page.waitForTimeout(2000);
            }

            // Go to Approval Flow tab
            const approvalTab = page.locator('a:has-text("Approval Flow"), a[href*="tab=workflow"], button:has-text("Approval Flow")').first();
            if (await approvalTab.isVisible()) {
                await approvalTab.click();
                await page.waitForTimeout(1500);
            }
        }

        // Click "Apply" button
        const applyBtn = page.locator('button[type="submit"][value="apply_workflow"], button:has-text("Apply"), input[value="Apply"]').first();
        if (await applyBtn.isVisible()) {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
                applyBtn.click()
            ]);
            await page.waitForTimeout(2500);
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
        try { fs.unlinkSync(screenshotPath); } catch (_) { }
        if (page && !page.isClosed()) {
            await page.close().catch(() => { });
        }
    }
}

/**
 * 3. UNIVERSITY CIRCULARS & NOTICES SCRAPER
 */
async function browseCirculars(session, query, chatId, sendTelegram, callSmartAI) {
    let page;
    try {
        page = await session.context.newPage();
    } catch (err) {
        console.error('[PortalAgent] Failed to open new tab:', err.message);
        await sendTelegram(`⚠️ Could not open browser tab: ${err.message}`, chatId);
        return;
    }
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
        if (page && !page.isClosed()) {
            await page.close().catch(() => { });
        }
    }
}

/**
 * 4. REWARD POINTS & COIN WALLET
 */
async function checkRewardPoints(session, chatId, sendTelegram, sendTelegramPhoto) {
    let page;
    try {
        page = await session.context.newPage();
    } catch (err) {
        console.error('[PortalAgent] Failed to open new tab:', err.message);
        await sendTelegram(`⚠️ Could not open browser tab: ${err.message}`, chatId);
        return;
    }
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
        try { fs.unlinkSync(screenshotPath); } catch (_) { }
        if (page && !page.isClosed()) {
            await page.close().catch(() => { });
        }
    }
}

/**
 * 2. STANDALONE 80% LEAVE ATTENDANCE SIMULATOR
 * Calculates if taking leave from date X to date Y will drop any subject below 80%.
 */
async function simulateLeaveAttendanceImpact(session, fromDate, toDate, chatId, sendTelegram, fetchAttendanceFn = null, options = {}) {
    let page;
    try {
        page = await session.context.newPage();
    } catch (err) {
        console.error('[PortalAgent] Failed to open new tab:', err.message);
        await sendTelegram(`⚠️ Could not open browser tab: ${err.message}`, chatId);
        return { success: false, error: err.message };
    }
    try {
        await ensurePortalSession(page, session);

        const dFrom = parseIndianDate(fromDate) || new Date();
        const dTo = parseIndianDate(toDate) || dFrom;
        const fromStr = formatPortalDateTime(dFrom, 8, 0, 'AM');
        const toStr = formatPortalDateTime(dTo, 8, 0, 'PM');

        const isOd = Boolean(options.isOd || options.odCount > 0);
        const actionLabel = isOd ? 'On-Duty (OD) credit' : 'leave impact';
        await sendTelegram(`⏳ *Simulating ${actionLabel} from ${fromStr} to ${toStr} against your timetable and 80% rule...*`, chatId);

        // 1. Fetch live attendance records
        let attendanceRecords = [];
        if (fetchAttendanceFn && session && session.context) {
            attendanceRecords = await fetchAttendanceFn(session.context, session.config).catch(() => []);
        }

        // 2. Open leave creation form to let Saveetha populate live schedules
        await page.goto('https://learner.saveetha.in/academics/workflow-requests/leave-applications/create/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);

        // Fill dates into inputs
        const fromInput = page.locator('#id_leave_date_from, input[name="leave_date_from"]').first();
        if (await fromInput.isVisible()) {
            await fromInput.click();
            await fromInput.fill(fromStr);
            await fromInput.evaluate((el, val) => {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
            }, fromStr);
        }

        const toInput = page.locator('#id_leave_date_to, input[name="leave_date_to"]').first();
        if (await toInput.isVisible()) {
            await toInput.click();
            await toInput.fill(toStr);
            await toInput.evaluate((el, val) => {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('blur', { bubbles: true }));
            }, toStr);
        }

        // Scrape overlapping schedules directly and via DOM
        const overlappingClasses = await fetchLeaveSchedulesFromPortal(page, fromStr, toStr);

        // 3. Run impact calculation with OD options
        const impact = calculateAttendanceLeaveImpact(attendanceRecords, overlappingClasses, options);
        const report = formatAttendanceImpactMessage(impact, fromStr, toStr);

        const reportTitle = isOd ? 'On-Duty (OD) Attendance Simulation Report' : 'Leave Attendance Simulation Report';
        const classesHeader = isOd ? 'Scheduled Classes Under OD' : 'Scheduled Classes Covered';

        let classSnippet = '';
        if (overlappingClasses.length > 0) {
            classSnippet = `📚 *${classesHeader} (${overlappingClasses.length}):*\n` +
                overlappingClasses.map(c => simplifyScheduleRow(c)).join('\n') + '\n\n';
        }

        const finalMsg = `🗓️ *${reportTitle}*\n` +
            `• *Duration:* \`${fromStr}\` ➔ \`${toStr}\`\n` +
            `• *Classes Covered:* ${overlappingClasses.length}\n\n` +
            classSnippet +
            report;

        await sendTelegram(finalMsg, chatId);
        return { success: true, impact, overlappingCount: overlappingClasses.length };
    } catch (err) {
        console.error('[PortalAgent] Error simulating leave impact:', err);
        await sendTelegram(`⚠️ Could not simulate leave impact: ${err.message}`, chatId);
        return { success: false, error: err.message };
    } finally {
        if (page && !page.isClosed()) {
            await page.close().catch(() => { });
        }
    }
}

module.exports = {
    MODULE_URLS,
    LEAVE_TYPE_MAP,
    ensurePortalSession,
    resolveLeaveType,
    parseIndianDate,
    formatPortalDateTime,
    extractDateRangeFromText,
    simplifyScheduleRow,
    calculateAttendanceLeaveImpact,
    formatAttendanceImpactMessage,
    simulateLeaveAttendanceImpact,
    draftLeaveApplication,
    officiallySubmitLeave,
    browseCirculars,
    checkRewardPoints
};

