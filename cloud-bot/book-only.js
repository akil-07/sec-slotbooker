process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (error) => {
    console.error('UNCAUGHT EXCEPTION:', error);
});

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Fix for Playwright temp dir permission issue
const localTemp = path.join(__dirname, 'temp');
if (!fs.existsSync(localTemp)) fs.mkdirSync(localTemp);
process.env.TEMP = localTemp;
process.env.TMP = localTemp;
process.env.TMPDIR = localTemp;

require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const aiClient = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

const CHAT_ID = process.env.CHAT_ID;
const SAVEETHA_USER = process.env.SAVEETHA_USER;
const SAVEETHA_PASS = process.env.SAVEETHA_PASS;
const ACCOUNTS_JSON = process.env.ACCOUNTS_JSON;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || process.env.CHAT_ID || '6374825608';
// User Registry
let ACCOUNTS = {};
let USER_SESSIONS = new Map(); // chatId -> { context, config, persistentPage, isBusy }
let apiRequest = null; // Playwright request context for bypassing Node fetch blocks
let superAdminNotificationsEnabled = true; // Added for super admin notifications toggle
const pendingOtpRequests = new Map(); // chatId -> callback function
const pendingTimeConfirmations = new Map(); // chatId -> { params, unusualTime, isTooEarly }

function isSuperAdmin(chatId) {
    if (!chatId) return false;
    const cid = String(chatId);
    if (cid === String(ADMIN_CHAT_ID)) return true;
    if (cid === String(process.env.CHAT_ID)) return true;
    if (cid === '8581009274' || cid === '6374825608') return true;
    const superAdminChatId = Object.keys(ACCOUNTS).find(id => ACCOUNTS[id] && ACCOUNTS[id].user === '25013635');
    if (superAdminChatId && cid === String(superAdminChatId)) return true;
    return false;
}

function getNowIST() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

// ─── Persistent Task State (Gist-backed for GitHub Actions survival) ─────────
const TASKS_FILE = path.join(__dirname, 'active_tasks.json');
const GIST_TOKEN = process.env.GIST_TOKEN;
const GIST_ID = process.env.GIST_ID;
const GIST_FILENAME = 'saveetha_bot_tasks.json';

const BLOCKED_USERS_FILE = path.join(__dirname, 'blocked_users.json');
let blockedUsers = new Set();
try {
    if (fs.existsSync(BLOCKED_USERS_FILE)) {
        const raw = fs.readFileSync(BLOCKED_USERS_FILE, 'utf-8');
        const list = JSON.parse(raw);
        blockedUsers = new Set(list);
    }
} catch (e) {
    console.error('[Persist] Failed to load blocked users:', e.message);
}

function saveBlockedUsers() {
    try {
        fs.writeFileSync(BLOCKED_USERS_FILE, JSON.stringify(Array.from(blockedUsers), null, 2), 'utf-8');
    } catch (e) {
        console.error('[Persist] Failed to save blocked users:', e.message);
    }
    syncBlockedToGist().catch(e => console.error(e));
}

async function syncBlockedToGist() {
    if (!GIST_TOKEN || !GIST_ID) return;
    try {
        const https = require('https');
        const body = JSON.stringify({
            files: {
                'saveetha_blocked.json': {
                    content: JSON.stringify(Array.from(blockedUsers), null, 2)
                }
            }
        });
        await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.github.com',
                path: `/gists/${GIST_ID}`,
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${GIST_TOKEN}`,
                    'User-Agent': 'saveetha-bot',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'Accept': 'application/vnd.github.v3+json',
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            }, (res) => {
                res.on('data', () => {});
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve();
                    else reject(new Error(`Gist save failed: ${res.statusCode}`));
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        console.log('[Persist] Synced blocked users to Gist.');
    } catch (e) {
        console.error('[Persist] Failed to sync blocked users:', e.message);
    }
}

// Save tasks to local file AND to GitHub Gist (so they survive runner restarts)
let gistSaveTimeout = null;
let pendingGistData = null;
let isSyncing = false;

async function syncToGist() {
    if (!GIST_TOKEN || !GIST_ID || !pendingGistData) return;
    const dataToSync = pendingGistData;
    isSyncing = true;

    let retries = 3;
    while (retries > 0) {
        try {
            const https = require('https');
            const body = JSON.stringify({
                files: {
                    [GIST_FILENAME]: {
                        content: JSON.stringify(dataToSync, null, 2)
                    }
                }
            });
            await new Promise((resolve, reject) => {
                const req = https.request({
                    hostname: 'api.github.com',
                    path: `/gists/${GIST_ID}`,
                    method: 'PATCH',
                    headers: {
                        'Authorization': `Bearer ${GIST_TOKEN}`,
                        'User-Agent': 'saveetha-bot',
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body),
                        'Accept': 'application/vnd.github.v3+json',
                        'X-GitHub-Api-Version': '2022-11-28'
                    }
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve();
                        } else {
                            reject(new Error(`Gist save failed: ${res.statusCode}`));
                        }
                    });
                });
                req.on('error', reject);
                req.write(body);
                req.end();
            });
            // Success
            break;
        } catch (e) {
            console.error(`[Persist] Gist save failed, retries left: ${retries - 1}. Error:`, e.message);
            if (e.message.includes('403')) {
                console.error('[Persist] GitHub API 403 Secondary Rate Limit hit. Stopping aggressive retries to let the API cooldown.');
                break;
            }
            retries--;
            if (retries > 0) {
                await new Promise(r => setTimeout(r, 5000)); // wait 5s before retry
            }
        }
    }
    isSyncing = false;

    // If more changes arrived while syncing, trigger again
    if (pendingGistData !== dataToSync && !gistSaveTimeout) {
        gistSaveTimeout = setTimeout(() => {
            gistSaveTimeout = null;
            syncToGist();
        }, 5000);
    }
}

async function saveTasksToGist(tasksData) {
    // Always save locally first (instantly)
    try {
        fs.writeFileSync(TASKS_FILE, JSON.stringify(tasksData, null, 2), 'utf-8');
    } catch (e) {
        console.error('[Persist] Failed to save tasks locally:', e.message);
    }

    if (!GIST_TOKEN || !GIST_ID) return;

    // Check if tasks were removed (length is less than before)
    const isDeletion = pendingGistData && tasksData.tasks && pendingGistData.tasks && tasksData.tasks.length < pendingGistData.tasks.length;

    pendingGistData = tasksData;

    // If it's a deletion, try to save faster to ensure finished tasks are cleared, otherwise wait longer
    const delay = isDeletion ? 3000 : 20000;

    if (!gistSaveTimeout && !isSyncing) {
        gistSaveTimeout = setTimeout(() => {
            gistSaveTimeout = null;
            syncToGist();
        }, delay);
    }
}

// Load tasks from Gist first (cross-runner), fall back to local file
async function loadTasksFromGist() {
    // Try Gist first
    if (GIST_TOKEN && GIST_ID) {
        try {
            const https = require('https');
            const data = await new Promise((resolve, reject) => {
                const req = https.request({
                    hostname: 'api.github.com',
                    path: `/gists/${GIST_ID}?t=${Date.now()}`,
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${GIST_TOKEN}`,
                        'User-Agent': 'saveetha-bot',
                        'Accept': 'application/vnd.github.v3+json',
                        'X-GitHub-Api-Version': '2022-11-28'
                    }
                }, (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(body);
                        } else {
                            reject(new Error(`Gist load failed: ${res.statusCode}`));
                        }
                    });
                });
                req.on('error', reject);
                req.end();
            });
            const gist = JSON.parse(data);
            if (gist.files && gist.files[GIST_FILENAME] && gist.files[GIST_FILENAME].content) {
                const tasks = JSON.parse(gist.files[GIST_FILENAME].content);
                console.log(`[Persist] Loaded tasks from Gist: counter=${tasks.counter}, ${(tasks.tasks || []).length} task(s).`);
                return tasks;
            }
        } catch (e) {
            console.error('[Persist] Failed to load from Gist:', e.message);
        }
    }

    // Fallback to local file
    try {
        if (fs.existsSync(TASKS_FILE)) {
            const raw = fs.readFileSync(TASKS_FILE, 'utf-8');
            const tasks = JSON.parse(raw);
            console.log(`[Persist] Loaded tasks from local file: counter=${tasks.counter}, ${(tasks.tasks || []).length} task(s).`);
            return tasks;
        }
    } catch (e) {
        console.error('[Persist] Failed to load tasks locally:', e.message);
    }
    return null;
}

function clearPersistedTasks() {
    try {
        if (fs.existsSync(TASKS_FILE)) fs.unlinkSync(TASKS_FILE);
    } catch (_) { }
    // Also clear Gist
    saveTasksToGist({ counter: 0, tasks: [] }).catch(() => { });
}


// ─── Account Initialization ──────────────────────────────────────────────────

async function initAccounts() {
    // 1. Always load the primary user first
    if (CHAT_ID && SAVEETHA_USER && SAVEETHA_PASS) {
        ACCOUNTS[CHAT_ID] = { user: SAVEETHA_USER, pass: SAVEETHA_PASS, name: 'Primary User' };
    }

    // 2. Load additional dynamic users from JSON
    try {
        if (ACCOUNTS_JSON) {
            const additionalAccounts = JSON.parse(ACCOUNTS_JSON);
            Object.assign(ACCOUNTS, additionalAccounts);
            console.log('[Bot] Loaded additional JSON accounts:', Object.keys(additionalAccounts).join(', '));
        }
    } catch (e) {
        console.error('[Bot] ACCOUNTS_JSON parse error:', e.message);
    }

    try {
        if (GIST_TOKEN && GIST_ID) {
            const https = require('https');
            const data = await new Promise((resolve, reject) => {
                const req = https.request({
                    hostname: 'api.github.com',
                    path: `/gists/${GIST_ID}?t=${Date.now()}`,
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${GIST_TOKEN}`,
                        'User-Agent': 'saveetha-bot',
                        'Accept': 'application/vnd.github.v3+json',
                        'X-GitHub-Api-Version': '2022-11-28'
                    }
                }, (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => resolve(body));
                });
                req.on('error', reject);
                req.end();
            });
            const gist = JSON.parse(data);
            if (gist.files && gist.files['saveetha_accounts.json'] && gist.files['saveetha_accounts.json'].content) {
                const gistAccounts = JSON.parse(gist.files['saveetha_accounts.json'].content);
                Object.assign(ACCOUNTS, gistAccounts);
                console.log('[Bot] Loaded Gist accounts:', Object.keys(gistAccounts).length);
            }
            if (gist.files && gist.files['saveetha_blocked.json'] && gist.files['saveetha_blocked.json'].content) {
                const gistBlocked = JSON.parse(gist.files['saveetha_blocked.json'].content);
                gistBlocked.forEach(id => blockedUsers.add(id));
                console.log('[Bot] Loaded Gist blocked users:', gistBlocked.length);
            }
        }
    } catch (e) {
        console.error('[Bot] Gist accounts parse error:', e.message);
    }

    console.log('[Bot] Total authorized users:', Object.keys(ACCOUNTS).length);
}

async function syncAccountsToGist() {
    if (!GIST_TOKEN || !GIST_ID) return;
    try {
        const https = require('https');
        const dataToSync = Object.assign({}, ACCOUNTS);
        if (CHAT_ID) delete dataToSync[CHAT_ID];

        const body = JSON.stringify({
            files: {
                'saveetha_accounts.json': {
                    content: JSON.stringify(dataToSync, null, 2)
                }
            }
        });
        await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.github.com',
                path: `/gists/${GIST_ID}`,
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${GIST_TOKEN}`,
                    'User-Agent': 'saveetha-bot',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'Accept': 'application/vnd.github.v3+json',
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve();
                    else reject(new Error(`Gist save failed: ${res.statusCode}`));
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
        console.log('[Persist] Synced accounts to Gist.');
    } catch (e) {
        console.error('[Persist] Failed to sync accounts to Gist:', e.message);
    }
}

function getUserConfig(chatId) {
    return ACCOUNTS[chatId] || null;
}

async function fetchGistCommands() {
    if (!GIST_TOKEN || !GIST_ID) return [];
    try {
        const https = require('https');
        // 1. Fetch commands
        const data = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: 'api.github.com',
                path: `/gists/${GIST_ID}`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${GIST_TOKEN}`,
                    'User-Agent': 'saveetha-bot',
                    'Accept': 'application/vnd.github.v3+json',
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => resolve(body));
            });
            req.on('error', reject);
            req.end();
        });
        const gist = JSON.parse(data);
        if (gist.files && gist.files['saveetha_commands.json'] && gist.files['saveetha_commands.json'].content) {
            const contentObj = JSON.parse(gist.files['saveetha_commands.json'].content);
            const commands = contentObj.commands || [];

            if (commands.length > 0) {
                // 2. Clear commands from Gist
                await new Promise((resolve, reject) => {
                    const req = https.request({
                        hostname: 'api.github.com',
                        path: `/gists/${GIST_ID}`,
                        method: 'PATCH',
                        headers: {
                            'Authorization': `Bearer ${GIST_TOKEN}`,
                            'User-Agent': 'saveetha-bot',
                            'Accept': 'application/vnd.github.v3+json',
                            'X-GitHub-Api-Version': '2022-11-28'
                        }
                    }, resolve);
                    req.on('error', reject);
                    req.write(JSON.stringify({
                        files: {
                            'saveetha_commands.json': { content: '{"commands":[]}' }
                        }
                    }));
                    req.end();
                });
                return commands;
            }
        }
    } catch (e) {
        console.error('[Gist] Failed to fetch commands:', e.message);
    }
    return [];
}

// ─── Telegram Helpers ────────────────────────────────────────────────────────

async function sendTelegram(text, chatId = CHAT_ID) {
    if (!apiRequest) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const res = await apiRequest.post(url, {
            data: { chat_id: chatId, text, parse_mode: 'Markdown' }
        });
        const data = await res.json();
        if (!data.ok) console.error('[Telegram] Error:', data.description);
        else console.log('[Telegram] Message sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send:', e.message);
    }
}

async function sendTelegramPhoto(photoPath, caption, chatId = CHAT_ID) {
    if (!apiRequest) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
        const res = await apiRequest.post(url, {
            multipart: {
                chat_id: chatId,
                caption: caption,
                photo: {
                    name: 'screenshot.png',
                    mimeType: 'image/png',
                    buffer: fs.readFileSync(photoPath)
                }
            }
        });
        const data = await res.json();
        if (!data.ok) console.error('[Telegram] Photo error:', data.description);
        else console.log('[Telegram] Photo sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send photo:', e.message);
    }
}

async function getTelegramUpdates(offset) {
    if (!apiRequest) return [];
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=20&offset=${offset}`;
        const res = await apiRequest.get(url, { timeout: 40000 });
        const data = await res.json();
        if (!data.ok) {
            console.error('[Telegram] API Error:', data);
            return [];
        }
        return data.result || [];
    } catch (e) {
        console.error('[Telegram] getUpdates error:', e.message);

        // Sleep to prevent infinite loop spam if context crashes
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Attempt native fetch fallback if Playwright context died
        try {
            if (typeof fetch !== 'undefined') {
                const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=20&offset=${offset}`;
                const fetchRes = await fetch(url);
                const data = await fetchRes.json();
                if (!data.ok) return [];
                return data.result || [];
            }
        } catch (fallbackErr) {
            // Silently ignore fallback fetch errors to avoid more console spam
        }

        return [];
    }
}

// ─── Time Helper ─────────────────────────────────────────────────────────────

function getDelayMsUntil(timeStr) {
    if (!timeStr) return 0;
    const now = new Date();
    const match = timeStr.match(/(\d{1,2})(?:[\.:]\s*(\d{2}))?\s*(AM|PM|am|pm)?/i);
    if (!match) return 0;

    let hours = parseInt(match[1], 10);
    const mins = match[2] ? parseInt(match[2], 10) : 0;
    const isPM = match[3] && match[3].toLowerCase() === 'pm';
    const isAM = match[3] && match[3].toLowerCase() === 'am';

    if (isPM && hours < 12) hours += 12;
    if (isAM && hours === 12) hours = 0;

    const target = new Date(now);
    target.setHours(hours, mins, 0, 0);
    let diff = target.getTime() - now.getTime();
    if (diff < -12 * 60 * 60 * 1000) {
        target.setDate(target.getDate() + 1);
        diff = target.getTime() - now.getTime();
    } else if (diff < 0) {
        diff = 0;
    }
    return diff;
}

function levenshtein(a, b) {
    if (!a || !b) return (a || b || '').length;
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
    }
    return dp[m][n];
}

function inspectTimeString(rawTimeStr) {
    if (!rawTimeStr) return null;
    const str = rawTimeStr.trim();

    const hasDigits = /\d/.test(str);
    if (!hasDigits) {
        return {
            isValid: false,
            isTypo: false,
            error: `Invalid time "${rawTimeStr}". No numbers found.`
        };
    }

    const match = str.match(/^(\d{1,2})(?:[:\.](\d{2}))?\s*([a-zA-Z\.]*)$/);
    if (!match) {
        return {
            isValid: false,
            isTypo: false,
            error: `Could not parse time "${rawTimeStr}".`
        };
    }

    const hours = parseInt(match[1], 10);
    const minsStr = match[2] || '00';
    const mins = parseInt(minsStr, 10);
    const rawSuffix = match[3] || '';
    const cleanSuffix = rawSuffix.toLowerCase().replace(/[^a-z]/g, '');

    if (hours < 0 || hours > 23 || mins < 0 || mins > 59) {
        return {
            isValid: false,
            isTypo: false,
            error: `Invalid time range in "${rawTimeStr}".`
        };
    }

    if (!cleanSuffix) {
        return {
            isValid: true,
            hours,
            mins,
            meridian: null,
            formatted: `${hours}:${minsStr}`
        };
    }

    if (cleanSuffix === 'am' || cleanSuffix === 'pm') {
        return {
            isValid: true,
            hours,
            mins,
            meridian: cleanSuffix.toUpperCase(),
            formatted: `${hours}:${minsStr} ${cleanSuffix.toUpperCase()}`
        };
    }

    // Suffix is misspelled (e.g. "pn", "an", "om", "qm")
    const pmTypos = ['pn', 'om', 'on', 'qm', 'pl', 'pj', 'pk', 'p', 'pmm', 'pmn', 'pms'];
    const amTypos = ['an', 'sm', 'sn', 'wm', 'al', 'aj', 'ak', 'a', 'amm', 'amn', 'ams', 'em', 'im'];

    let suggestedMeridian = null;
    if (pmTypos.includes(cleanSuffix) || cleanSuffix.startsWith('p')) {
        suggestedMeridian = 'PM';
    } else if (amTypos.includes(cleanSuffix) || cleanSuffix.startsWith('a')) {
        suggestedMeridian = 'AM';
    } else if (cleanSuffix.includes('n')) {
        if (cleanSuffix.includes('p')) suggestedMeridian = 'PM';
        else if (cleanSuffix.includes('a')) suggestedMeridian = 'AM';
        else suggestedMeridian = 'PM';
    } else {
        if (levenshtein(cleanSuffix, 'pm') <= 1) suggestedMeridian = 'PM';
        else if (levenshtein(cleanSuffix, 'am') <= 1) suggestedMeridian = 'AM';
    }

    const suggestedTime = suggestedMeridian ? `${hours}:${minsStr} ${suggestedMeridian}` : null;

    return {
        isValid: false,
        isTypo: true,
        rawTime: rawTimeStr,
        wrongSuffix: rawSuffix,
        suggestedMeridian,
        suggestedTime
    };
}

function parseTimeHoursMinutes(timeStr) {
    if (!timeStr) return null;
    const match = timeStr.trim().match(/(\d{1,2})(?:[\.:]\s*(\d{2}))?\s*(am|pm)?/i);
    if (!match) return null;

    let hours = parseInt(match[1], 10);
    const mins = match[2] ? parseInt(match[2], 10) : 0;
    const meridian = match[3] ? match[3].toLowerCase() : null;

    if (meridian === 'pm') {
        if (hours < 12) hours += 12;
    } else if (meridian === 'am') {
        if (hours === 12) hours = 0;
    } else {
        if (hours >= 1 && hours <= 6) {
            hours += 12;
        }
    }

    return { hours, mins, totalMinutes: hours * 60 + mins };
}

function isOutsideNormalHours(timeStr) {
    if (!timeStr) return null;
    const parsed = parseTimeHoursMinutes(timeStr);
    if (!parsed) return null;

    const startMins = 8 * 60; // 08:00 AM (480 mins)
    const endMins = 18 * 60;  // 06:00 PM (1080 mins)

    if (parsed.totalMinutes < startMins) {
        return { isTooEarly: true, isTooLate: false, timeStr, parsed };
    }
    if (parsed.totalMinutes > endMins) {
        return { isTooEarly: false, isTooLate: true, timeStr, parsed };
    }
    return null;
}

// ─── Booking Logic ────────────────────────────────────────────────────────────

async function runBookingOnPage(page, targetKeyword, targetTime, targetVenue, targetDate, silent = false, chatId = CHAT_ID) {
    console.log(`[Bot] Navigating to Event Booking page...`);
    // Cache-busting query param ensures a fresh page load every scan
    const cacheBuster = `_cb=${Date.now()}`;
    await page.goto(`https://learner.saveetha.in/academicevents/event-booking/?${cacheBuster}`, {
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

    console.log(`[Bot] Scanning for slots matching: "${targetKeyword}"${targetTime ? ` at "${targetTime}"` : ''}${targetVenue ? ` in "${targetVenue}"` : ''}...`);

    const evaluation = await page.evaluate((params) => {
        const { kw, time, venue, date } = params;
        const results = [];
        const allAvailable = [];

        // Clean up any stale tags from previous runs
        document.querySelectorAll('[data-saveetha-btn],[data-saveetha-input],[data-saveetha-cancel]').forEach(el => {
            el.removeAttribute('data-saveetha-btn');
            el.removeAttribute('data-saveetha-input');
            el.removeAttribute('data-saveetha-cancel');
        });

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
                .replace(/([ap])\s*\.?\s*m\.?/gi, '$1m')
                .replace(/[-_/·•]/g, ' ')
                .replace(/[^a-z0-9\s:]/g, '')
                .replace(/\s+/g, ' ')
                .replace(/(\d)(am|pm)/g, '$1 $2')
                .trim();
        }

        function parseMinutes(str) {
            if (!str) return null;
            const cleaned = str.toLowerCase()
                .replace(/([ap])\s*\.?\s*m\.?/gi, '$1m')
                .replace(/\s+/g, ' ')
                .trim();
            const match = cleaned.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
            if (!match) return null;
            let hour = parseInt(match[1], 10);
            const minute = match[2] ? parseInt(match[2], 10) : 0;
            const meridian = match[3];

            if (meridian === 'pm') {
                if (hour < 12) hour += 12;
            } else if (meridian === 'am') {
                if (hour === 12) hour = 0;
            }
            return hour * 60 + minute;
        }

        function extractSlotStartTime(fullText) {
            const timingPortion = fullText.split(/booking\s*window|cancellation\s*ends/i)[0] || fullText;
            const rangeMatch = timingPortion.match(/(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?|[ap]m))\s*[-–—to]+/i);
            if (rangeMatch) return rangeMatch[1];
            const singleMatch = timingPortion.match(/\b(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?|[ap]m))\b/i);
            if (singleMatch) return singleMatch[1];
            return '';
        }

        function doesTimeMatch(cardRaw, targetTimeStr) {
            if (!targetTimeStr) return true;
            const targetMin = parseMinutes(targetTimeStr);
            if (targetMin === null) return true;

            const slotStartStr = extractSlotStartTime(cardRaw);
            const slotMin = parseMinutes(slotStartStr);
            if (slotMin !== null && slotMin === targetMin) return true;

            // Handle no meridian specified in target (e.g. "@3")
            if (slotMin !== null && !/(am|pm)/i.test(targetTimeStr)) {
                if (slotMin % 720 === targetMin % 720) return true;
            }

            // Fallback: check any time expression in timing portion
            const timingPortion = cardRaw.split(/booking\s*window|cancellation\s*ends/i)[0] || cardRaw;
            const matches = timingPortion.matchAll(/\b(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?|[ap]m))\b/gi);
            for (const m of matches) {
                const mMin = parseMinutes(m[1]);
                if (mMin !== null && mMin === targetMin) return true;
            }

            return false;
        }

        const kwNorm = normalize(kw);
        const venueNorm = normalize(venue);
        const dateNorm = normalize(date);

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

            let matchTime = doesTimeMatch(fullTextRaw, time);

            let matchVenue = true;
            if (venueNorm) {
                matchVenue = fullTextNorm.includes(venueNorm);
            }

            let matchDate = true;
            if (dateNorm) {
                const dateWords = dateNorm.split(' ').filter(Boolean);
                matchDate = dateWords.every(w => fullTextNorm.includes(w) || titleTextNorm.includes(w));
            }

            // ⛔ Check "Already Booked" or "Opening Soon" status
            const isAlreadyBooked = /booked|registered|enrolled|joined/i.test(btnText) && !btnText.includes('book');
            const isOpeningSoon = /opening\s*soon/i.test(fullTextRaw);

            if (matchKeyword && matchTime && matchVenue && matchDate) {
                if (isOpeningSoon) {
                    results.push({ index: i, fullText: fullTextNorm, isWaitlist, isOpeningSoon: true });
                } else if (isAlreadyBooked) {
                    results.push({ index: i, fullText: fullTextNorm, isWaitlist, isAlreadyBooked: true });
                } else {
                    // Tag the button AND find purpose input immediately while DOM is stable
                    const tagId = 'target-' + Date.now() + '-' + i;
                    btn.setAttribute('data-saveetha-btn', tagId);

                    let purposeTagged = false;
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
                                purposeTagged = true;
                                break;
                            }
                        }
                        if (!purposeTagged) {
                            const inputs2 = card.querySelectorAll('input[type="text"], textarea, input:not([type])');
                            for (const inp of inputs2) {
                                if (inp.offsetParent !== null) {
                                    inp.setAttribute('data-saveetha-input', 'purpose');
                                    purposeTagged = true;
                                    break;
                                }
                            }
                        }
                    }

                    results.push({ index: i, fullText: fullTextNorm, isWaitlist, tagId, purposeTagged });
                }
            }
        }
        return { slotsFound: results, availableSlots: [...new Set(allAvailable)] };
    }, { kw: targetKeyword, time: targetTime, venue: targetVenue, date: targetDate });

    const slotsFound = evaluation.slotsFound;
    const availableSlots = evaluation.availableSlots;

    // Filter out non-bookable results for the actual booking logic, but keep them for reporting
    const bookableSlots = slotsFound.filter(s => !s.isAlreadyBooked && !s.isOpeningSoon);

    if (bookableSlots.length === 0) {
        console.log('[Bot] No bookable slot found.');
        const alreadyBooked = slotsFound.find(s => s.isAlreadyBooked);

        if (alreadyBooked) {
            console.log('[Bot] Slot is already booked.');
            await sendTelegram(`✅ *Status:* You are already booked/registered for *"${targetKeyword}"*. The scan will now stop.`, chatId);
            return 'ALREADY_BOOKED';
        }

        if (!silent) {
            let reasonMsg = '';
            const openingSoon = slotsFound.find(s => s.isOpeningSoon);

            if (openingSoon) {
                reasonMsg = `\n\n🕒 *Status:* Found the slot, but it says "Opening Soon".`;
            } else {
                const displayedSlots = availableSlots.slice(0, 15);
                const moreCount = availableSlots.length - displayedSlots.length;
                reasonMsg = availableSlots.length > 0
                    ? `\n\n*Available Slots:*\n` + displayedSlots.map(s => `- ${s}`).join('\n') + (moreCount > 0 ? `\n_...and ${moreCount} more slots_` : '')
                    : '\n\nNo slots are currently available on the page.';
            }

            await sendTelegram(`⚠️ No bookable slot found for *"${targetKeyword}"*${targetTime ? ` at *${targetTime}*` : ''}.${reasonMsg}`, chatId);
        }
        return false;
    }

    console.log(`[Bot] Match found: ${bookableSlots[0].fullText.substring(0, 60)}...`);

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

        const btn = (targetData.tagId && document.querySelector(`[data-saveetha-btn="${targetData.tagId}"]`)) || btns[targetData.index];
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
    }, bookableSlots[0]);

    if (!tagged.success) {
        await sendTelegram(`⚠️ Found the slot but failed to tag it: ${tagged.reason}`, chatId);
        return false;
    }

    const bookBtn = page.locator('[data-saveetha-btn="target"]');
    await bookBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);

    if (tagged.purposeFound) {
        const purposeInput = page.locator('[data-saveetha-input="purpose"]');
        console.log('[Bot] Filling purpose input...');
        await purposeInput.scrollIntoViewIfNeeded();
        await purposeInput.click({ force: true });
        await page.waitForTimeout(100);
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.waitForTimeout(100);
        await purposeInput.pressSequentially('To attend as part of academic curriculum', { delay: 10 });
        await page.waitForTimeout(200);
    }

    console.log('[Bot] Clicking Book Now...');
    await bookBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    await bookBtn.click({ force: true });
    console.log('[Bot] Book Now clicked!');
    await page.waitForTimeout(500);

    // Handle confirmation modals
    try {
        const swal2Confirm = page.locator('.swal2-confirm');
        if (await swal2Confirm.count() > 0) {
            console.log('[Bot] SweetAlert2 confirm found — clicking...');
            await swal2Confirm.first().click();
            await page.waitForTimeout(500);
        } else {
            const modalBtns = page.locator('.modal button, [role="dialog"] button, .swal-button');
            const count = await modalBtns.count();
            for (let i = 0; i < count; i++) {
                const t = (await modalBtns.nth(i).innerText().catch(() => '')).toLowerCase().trim();
                if (t === 'ok' || t === 'confirm' || t === 'yes' || t === 'book') {
                    console.log(`[Bot] Modal button "${t}" — clicking...`);
                    await modalBtns.nth(i).click();
                    await page.waitForTimeout(500);
                    break;
                }
            }
        }
    } catch (modalErr) {
        console.log('[Bot] Modal check:', modalErr.message);
    }

    await page.waitForTimeout(500);

    // Verify booking by checking for a success/info banner message (poll up to 3s)
    let bannerFound = { found: false, text: '' };
    for (let i = 0; i < 6; i++) {
        try {
            bannerFound = await page.evaluate(() => {
                const alerts = document.querySelectorAll('.alert, .toast, .message, .notification, [class*="alert"], [class*="success"], [class*="msg"]');
                let text = '';
                alerts.forEach(el => {
                    if (el.offsetParent !== null && el.innerText.trim().length > 0) {
                        text += el.innerText.trim() + ' ';
                    }
                });
                const lower = text.toLowerCase();
                if (lower.includes('booked') || lower.includes('cancelled') || lower.includes('waitlist') || lower.includes('success')) {
                    const isAlready = lower.includes('already');
                    const isFull = /\bfull\b/.test(lower);
                    return { found: true, text: text.trim(), isAlready, isFull };
                }
                return { found: false, text: text.trim() };
            });
            if (bannerFound.found) break;
        } catch (e) {
            console.log('[Bot] Evaluation error during banner check (page navigation?):', e.message);
        }
        await page.waitForTimeout(500);
    }

    if (!bannerFound.found) {
        console.log(`[Bot] Expected confirmation banner not found. Text was: "${bannerFound.text}". Misunderstood click, returning false.`);
        if (!silent) {
            // Only send telegram message if it's not a silent scan
            await sendTelegram(`⚠️ Attempted to book *"${targetKeyword}"*, but could not verify success (no banner found). Misunderstood button. Searching again...`, chatId);
        }
        return false;
    }

    if (bannerFound.isAlready) {
        console.log(`[Bot] Confirmed via banner (Already Booked): ${bannerFound.text}`);
        await sendTelegram(`✅ *Status:* You are already booked/waitlisted for *"${targetKeyword}"*. The scan will now stop.`, chatId);
        return 'ALREADY_BOOKED';
    }

    if (bannerFound.isFull) {
        console.log(`[Bot] Confirmed via banner (Waitlist Full): ${bannerFound.text}`);
        if (!silent) {
            await sendTelegram(`⚠️ Attempted to book *"${targetKeyword}"*, but waitlist is full: ${bannerFound.text}. Searching again...`, chatId);
        }
        return false;
    }

    console.log(`[Bot] Confirmed via banner: ${bannerFound.text}`);

    const finalUrl = page.url();
    console.log(`[Bot] Final URL: ${finalUrl}`);

    const actionStr = bookableSlots[0].isWaitlist ? '📋 Waitlisted' : '✅ Booked';
    const tmpPath = path.join(__dirname, '_tmp_screenshot.png');
    await page.screenshot({ path: tmpPath, fullPage: false });
    await sendTelegramPhoto(
        tmpPath,
        `${actionStr} Successfully!\n\n🎯 Slot: ${targetKeyword}${targetTime ? ` at ${targetTime}` : ''}\n🔗 URL: ${finalUrl}\n\nBooking complete! 🎉`,
        chatId
    );

    const superAdminChatId = Object.keys(ACCOUNTS).find(id => ACCOUNTS[id].user === '25013635');
    if (superAdminNotificationsEnabled && superAdminChatId && String(chatId) !== String(superAdminChatId)) {
        const userName = (ACCOUNTS[chatId] && ACCOUNTS[chatId].name) ? ACCOUNTS[chatId].name : chatId;
        await sendTelegramPhoto(
            tmpPath,
            `🔔 *User Successfully Booked!*\nUser: ${userName}\n${actionStr} Successfully!\n\n🎯 Slot: ${targetKeyword}${targetTime ? ` at ${targetTime}` : ''}`,
            superAdminChatId
        );
    }

    try { fs.unlinkSync(tmpPath); } catch (_) { }
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
        const config = page._userConfig;
        await doLogin(page, config.user, config.pass);
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
            return str.toLowerCase()
                .replace(/([ap])\s*\.?\s*m\.?/gi, '$1m')
                .replace(/[-_/·•]/g, ' ')
                .replace(/[^a-z0-9\s]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        }

        function parseMinutes(str) {
            if (!str) return null;
            const cleaned = str.toLowerCase()
                .replace(/([ap])\s*\.?\s*m\.?/gi, '$1m')
                .replace(/\s+/g, ' ')
                .trim();
            const match = cleaned.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
            if (!match) return null;
            let hour = parseInt(match[1], 10);
            const minute = match[2] ? parseInt(match[2], 10) : 0;
            const meridian = match[3];

            if (meridian === 'pm') {
                if (hour < 12) hour += 12;
            } else if (meridian === 'am') {
                if (hour === 12) hour = 0;
            }
            return hour * 60 + minute;
        }

        function extractSlotStartTime(fullText) {
            const timingPortion = fullText.split(/booking\s*window|cancellation\s*ends/i)[0] || fullText;
            const rangeMatch = timingPortion.match(/(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?|[ap]m))\s*[-–—to]+/i);
            if (rangeMatch) return rangeMatch[1];
            const singleMatch = timingPortion.match(/\b(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?|[ap]m))\b/i);
            if (singleMatch) return singleMatch[1];
            return '';
        }

        function doesTimeMatch(cardRaw, targetTimeStr) {
            if (!targetTimeStr) return true;
            const targetMin = parseMinutes(targetTimeStr);
            if (targetMin === null) return true;

            const slotStartStr = extractSlotStartTime(cardRaw);
            const slotMin = parseMinutes(slotStartStr);
            if (slotMin !== null && slotMin === targetMin) return true;

            if (slotMin !== null && !/(am|pm)/i.test(targetTimeStr)) {
                if (slotMin % 720 === targetMin % 720) return true;
            }
            return false;
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

            const fullTextRaw = card ? card.innerText : btn.innerText;
            const fullTextNorm = normalize(fullTextRaw);
            const matchKeyword = !kwNorm || fullTextNorm.includes(kwNorm);
            const matchTime = doesTimeMatch(fullTextRaw, time);

            if (matchKeyword && matchTime) {
                results.push({ index: i, fullText: fullTextNorm });
            }
        }
        return { slotsFound: results };
    }, { kw: targetKeyword, time: targetTime });

    if (evaluation.slotsFound.length === 0) {
        await sendTelegram(`⚠️ Could not find any booked slot matching *"${targetKeyword}"*${targetTime ? ` at *${targetTime}*` : ''} to cancel.`, chatId);
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
        } catch (e) { }

        const tmpPath = path.join(__dirname, '_cancel_screenshot.png');
        await page.screenshot({ path: tmpPath });
        await sendTelegramPhoto(tmpPath, `🛑 *Slot Cancelled Successfully!*\n\n🎯 Slot: ${targetKeyword}\n\nCancellation complete.`, chatId);
        try { fs.unlinkSync(tmpPath); } catch (_) { }
    }
}

// ─── OTP Attendance Automation (Auto-Reloading & Exact URL Routing) ──────────

async function waitForOtpWindow(page, timeoutMs = 15 * 60 * 1000, phase = 'start') {
    const targetType = phase === 'start' ? 'in' : 'out';
    const otpLabel = phase === 'start' ? 'IN OTP' : 'OUT OTP';
    console.log(`[OTP] Polling for ${otpLabel} window (type=${targetType})...`);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const check = await page.evaluate((type) => {
                const bodyText = (document.body.innerText || '').toLowerCase();

                // 1. Check if already approved / marked
                if (type === 'in') {
                    if (bodyText.includes('in attendance has been approved') || bodyText.includes('in otp approved') || bodyText.includes('in otp submitted')) {
                        return { status: 'already_marked', reason: 'IN OTP already marked/approved' };
                    }
                } else {
                    if (bodyText.includes('out otp approved') || bodyText.includes('out attendance has been approved') || bodyText.includes('out otp submitted')) {
                        return { status: 'already_marked', reason: 'OUT OTP already marked/approved' };
                    }
                }

                // 2. Check Saveetha exact form: form[data-otp-form][data-otp-type="in" or "out"]
                const otpForms = Array.from(document.querySelectorAll('form[data-otp-form], form'));
                for (const form of otpForms) {
                    const fType = (form.getAttribute('data-otp-type') || '').toLowerCase();
                    if (fType && fType !== type) continue; // Skip other phase form
                    const input = form.querySelector('input:not([type="hidden"])');
                    if (input && !input.disabled && input.offsetParent !== null) {
                        return { status: 'open', reason: `Saveetha form[data-otp-type="${fType || type}"] is open and active` };
                    }
                }

                // 3. Fallback: check any visible text/number input on the page
                const allInputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'));
                for (const inp of allInputs) {
                    if (inp.offsetParent === null || inp.disabled || inp.readOnly) continue;
                    // Ignore search or feedback inputs
                    if (inp.id === 'feedbackRating' || inp.name === 'comments' || (inp.placeholder || '').toLowerCase().includes('search')) continue;
                    return { status: 'open', reason: `Enabled input found: placeholder="${inp.placeholder}", name="${inp.name}"` };
                }

                return { status: 'waiting', reason: 'Waiting for faculty to generate OTP' };
            }, targetType);

            if (check.status === 'already_marked') {
                console.log(`[OTP] ${otpLabel}: ${check.reason}`);
                return { open: false, alreadyMarked: true, reason: check.reason };
            }

            if (check.status === 'open') {
                console.log(`[OTP] ${otpLabel} DETECTED! (${check.reason})`);
                return { open: true, alreadyMarked: false, reason: check.reason };
            }

            const secsLeft = Math.round((deadline - Date.now()) / 1000);
            console.log(`[OTP] ${otpLabel} not yet open (${secsLeft}s left). Reloading page in 5s...`);
            await page.waitForTimeout(5000);

            // CRITICAL: Reload page so Django server-rendered HTML reflects when faculty generates OTP!
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

        } catch (e) {
            console.error(`[OTP] Polling error: ${e.message}`);
            await page.waitForTimeout(5000);
        }
    }

    console.log(`[OTP] Timeout — ${otpLabel} never opened.`);
    return { open: false, alreadyMarked: false, reason: 'Timeout' };
}

async function enterOtpOnPage(page, otp, phase = 'start') {
    const targetType = phase === 'start' ? 'in' : 'out';
    console.log(`[OTP] Entering ${targetType.toUpperCase()} OTP: ${otp}`);

    // Try finding the specific Saveetha OTP form first
    const formLocator = page.locator(`form[data-otp-form][data-otp-type="${targetType}" i]`).first();
    let input = null;
    let submitBtn = null;

    if (await formLocator.count() > 0) {
        input = formLocator.locator('input:not([type="hidden"])').first();
        submitBtn = formLocator.locator('button[type="submit"], button').first();
    }

    // Fallback: any visible input
    if (!input || !(await input.count())) {
        input = page.locator('form[data-otp-form] input:not([type="hidden"]), input[type="text"]:visible, input[type="number"]:visible').first();
        submitBtn = page.locator('form[data-otp-form] button[type="submit"], button:has-text("Submit"):visible, button[type="submit"]:visible').first();
    }

    if (!input || !(await input.count())) {
        console.log('[OTP] Could not find OTP input field on page.');
        return { success: false, reason: 'OTP input field not found on page' };
    }

    await input.click();
    await input.fill('');
    await input.fill(otp);
    await new Promise(r => setTimeout(r, 500));

    if (submitBtn && (await submitBtn.count())) {
        await submitBtn.click();
        console.log('[OTP] Clicked submit button.');
    } else {
        await input.press('Enter');
        console.log('[OTP] Pressed Enter.');
    }

    return { success: true };
}

async function enterAndVerifyOtp(page, userOtp, phase, className, chatId) {
    const res = await enterOtpOnPage(page, userOtp, phase);
    if (!res.success) {
        await sendTelegram(`❌ Failed to enter OTP: ${res.reason}`, chatId);
        return false;
    }

    // Wait for Saveetha POST submission to complete
    await page.waitForTimeout(3000);

    // Verify if attendance was marked/approved
    let afterStatus = await getPageAttendanceStatus(page);
    const checkApproved = phase === 'start' ? afterStatus.inApproved : afterStatus.outApproved;

    // If server hasn't re-rendered yet, do a quick reload to get latest status
    if (!checkApproved) {
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(2000);
        afterStatus = await getPageAttendanceStatus(page);
    }

    const isSuccess = phase === 'start' ? afterStatus.inApproved : afterStatus.outApproved;
    const afterPic = path.join(__dirname, `_otp_done_${Date.now()}.png`);

    try {
        await page.screenshot({ path: afterPic });
        if (isSuccess) {
            await sendTelegramPhoto(
                afterPic,
                `🎉 *OTP Entered & Attendance Approved!* ✅\n\n` +
                `📚 *Class:* *${className}*\n` +
                `🎯 *Phase:* ${phase === 'start' ? 'IN Attendance' : 'OUT Attendance'}\n` +
                `🔢 *Entered OTP:* \`${userOtp}\`\n` +
                `🟢 *Result:* Approved for this session!`,
                chatId
            );
        } else {
            await sendTelegramPhoto(
                afterPic,
                `📸 *OTP Submitted:* \`${userOtp}\`\n\n` +
                `📚 *Class:* *${className}*\n` +
                `Please check the screenshot above for confirmation.`,
                chatId
            );
        }
    } catch (_) {}
    try { fs.unlinkSync(afterPic); } catch (_) {}
    return isSuccess;
}

async function handleAttendanceOtp(session, targetKeyword, phase = 'start', chatId = CHAT_ID, prefilledOtp = null, maxScanDurationMs = 15 * 60 * 1000) {
    if (!isSuperAdmin(chatId)) {
        console.log(`[OTP] Skipped attendance monitor for non-superadmin: ${chatId}`);
        return;
    }
    const page = await session.context.newPage();
    const phaseLabel = phase === 'start' ? 'IN OTP (Class Start)' : 'OUT OTP (Class End)';
    const emoji = phase === 'start' ? '📥' : '📤';

    try {
        await sendTelegram(
            `⏰ *Attendance Scanner Active*\n\n` +
            `📚 Class: *${targetKeyword || 'Current Class'}*\n` +
            `🎯 Phase: *${phaseLabel}*\n` +
            `⏱️ Refresh interval: *Every 5 seconds*\n\n` +
            `Locating class and opening attendance process page...`,
            chatId
        );

        // 1. Go to people_schedule
        await page.goto('https://learner.saveetha.in/academics/people_schedule/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (page.url().includes('/login')) {
            await doLogin(page, session.config.user, session.config.pass);
            await page.goto('https://learner.saveetha.in/academics/people_schedule/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        }
        await page.waitForTimeout(2500);

        // 2. Find attendance link for targetKeyword (or current active class)
        const attendanceTarget = await findAttendanceTarget(page, targetKeyword);

        if (!attendanceTarget || !attendanceTarget.href) {
            await sendTelegram(`⚠️ No attendance link found on schedule for *${targetKeyword || 'today'}*.`, chatId);
            return;
        }

        const attendanceUrl = attendanceTarget.href.startsWith('http')
            ? attendanceTarget.href
            : `https://learner.saveetha.in${attendanceTarget.href}`;

        console.log(`[OTP] Navigating directly to attendance page: ${attendanceUrl}`);
        await page.goto(attendanceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        // 3. Inspect attendance status immediately
        const initialStatus = await getPageAttendanceStatus(page);
        const targetType = phase === 'start' ? 'in' : 'out';
        const isPhaseDone = targetType === 'in' ? initialStatus.inApproved : initialStatus.outApproved;

        // If ALREADY DONE, say so immediately!
        if (isPhaseDone) {
            if (initialStatus.inApproved && initialStatus.outApproved) {
                await sendTelegram(
                    `✅ *It is already done!*\n\n` +
                    `Both *IN* and *OUT* attendance have already been approved for *${attendanceTarget.name}*! 🎓🎉\n\n` +
                    `No OTP entry needed.`,
                    chatId
                );
            } else {
                await sendTelegram(
                    `✅ *It is already done!*\n\n` +
                    `Your *${phase === 'start' ? 'IN' : 'OUT'} OTP* attendance has already been approved for *${attendanceTarget.name}*! 🎉\n\n` +
                    (phase === 'start' ? `ℹ️ *OUT OTP Status:* ${initialStatus.outText}` : `ℹ️ *IN OTP Status:* ${initialStatus.inText}`),
                    chatId
                );
            }
            return;
        }

        // 4. Poll for OTP box if not already open (with 5-second auto-reload)
        const isPhaseOpen = targetType === 'in' ? initialStatus.inOpen : initialStatus.outOpen;
        let otpResult = { open: isPhaseOpen, alreadyMarked: false };

        if (!isPhaseOpen) {
            otpResult = await waitForOtpWindow(page, maxScanDurationMs, phase);
        }

        if (otpResult.alreadyMarked) {
            await sendTelegram(
                `✅ *It is already done!*\n\n` +
                `*${phaseLabel}* has already been approved for *${attendanceTarget.name}*! 🎉\n\n` +
                `No OTP entry needed.`,
                chatId
            );
            return;
        }

        if (!otpResult.open) {
            await sendTelegram(`ℹ️ Attendance scan window ended for *${attendanceTarget.name}*. No OTP opened.`, chatId);
            return;
        }

        // 5. Box is OPEN!
        let userOtp = prefilledOtp;

        if (!userOtp) {
            const beforePic = path.join(__dirname, `_otp_open_${Date.now()}.png`);
            try {
                await page.screenshot({ path: beforePic });
                await sendTelegramPhoto(beforePic, `🚨 *${phase === 'start' ? 'IN' : 'OUT'} OTP Box is OPEN!*`, chatId);
            } catch (_) {}
            try { fs.unlinkSync(beforePic); } catch (_) {}

            await sendTelegram(
                `🔔 *OTP Window is Open!*\n\n` +
                `${emoji} *${phase === 'start' ? 'Entry (IN)' : 'Exit (OUT)'} OTP* for:\n*${attendanceTarget.name}*\n\n` +
                `👉 Reply directly to this bot with the *6-digit OTP* now:`,
                chatId
            );

            userOtp = await new Promise(resolve => {
                const timeout = setTimeout(() => {
                    if (pendingOtpRequests.has(chatId)) {
                        pendingOtpRequests.delete(chatId);
                    }
                    resolve(null);
                }, 5 * 60 * 1000);

                pendingOtpRequests.set(chatId, (code) => {
                    clearTimeout(timeout);
                    resolve(code.trim());
                });
            });

            if (!userOtp) {
                await sendTelegram(`⏰ Timed out waiting for OTP (5 minutes). Session closed for *${attendanceTarget.name}*.`, chatId);
                return;
            }
        } else {
            console.log(`[OTP] Using prefilled OTP: ${userOtp}`);
        }

        await enterAndVerifyOtp(page, userOtp, phase, attendanceTarget.name, chatId);

    } catch (e) {
        console.error('[AttendanceOTP] Error:', e);
        await sendTelegram(`⚠️ Attendance monitor error: ${e.message}`, chatId);
    } finally {
        await page.close().catch(() => {});
    }
}

// ─── Find Target Class from Schedule ──────────────────────────────────────────

async function findAttendanceTarget(page, kw) {
    return await page.evaluate((targetKw) => {
        const links = Array.from(document.querySelectorAll('a')).filter(a => {
            const h = a.getAttribute('href') || '';
            return h.includes('attendance_process') || h.includes('event_attendance_process');
        });
        if (!links.length) return null;

        function getCardText(a) {
            let el = a.parentElement;
            while (el && el !== document.body) {
                if (/\d{1,2}:\d{2}\s*(?:AM|PM)/i.test(el.innerText)) {
                    return el.innerText;
                }
                el = el.parentElement;
            }
            const fallback = a.closest('tr, .card') || a.parentElement;
            return fallback ? fallback.innerText : '';
        }

        const items = links.map(a => {
            const fullText = getCardText(a);
            const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
            const name = lines[0] || 'Class';
            return {
                href: a.getAttribute('href'),
                name,
                fullText
            };
        });

        // Strategy A: Match by keyword/subject in card text
        if (targetKw) {
            const kwLow = targetKw.toLowerCase().trim();
            for (const item of items) {
                if (item.fullText.toLowerCase().includes(kwLow)) {
                    return item;
                }
            }
        }

        // Strategy B: Match active class based on current time
        const now = new Date();
        const nowMins = now.getHours() * 60 + now.getMinutes();
        for (const item of items) {
            const m = item.fullText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?\s*[-–]\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
            if (m) {
                let sh = parseInt(m[1], 10);
                if (m[3]?.toUpperCase() === 'PM' && sh < 12) sh += 12;
                if (m[3]?.toUpperCase() === 'AM' && sh === 12) sh = 0;
                const startMin = sh * 60 + parseInt(m[2], 10);

                let eh = parseInt(m[4], 10);
                if (m[6]?.toUpperCase() === 'PM' && eh < 12) eh += 12;
                if (m[6]?.toUpperCase() === 'AM' && eh === 12) eh = 0;
                const endMin = eh * 60 + parseInt(m[5], 10);

                // If currently within or near (15 mins before/after) this class
                if (nowMins >= startMin - 15 && nowMins <= endMin + 15) {
                    return item;
                }
            }
        }

        // Strategy C: Fallback to the first available link
        return items[0];
    }, kw);
}

// ─── Inspect Real-time Status of Attendance Page ──────────────────────────────

async function getPageAttendanceStatus(page) {
    return await page.evaluate(() => {
        const text = (document.body.innerText || '');
        const bodyLower = text.toLowerCase();

        // 1. IN OTP status
        const inApproved = bodyLower.includes('in attendance has been approved') ||
                           bodyLower.includes('in otp approved') ||
                           bodyLower.includes('in otp submitted') ||
                           /in otp[\s\S]{0,100}submitted/i.test(bodyLower);

        const inForm = document.querySelector('form[data-otp-form][data-otp-type="in"], form[data-otp-type="in"]');
        const inInput = inForm ? inForm.querySelector('input:not([type="hidden"])') : null;
        const inOpen = !!(inInput && !inInput.disabled && inInput.offsetParent !== null);

        let inText = '⏳ Waiting for faculty to generate';
        if (inApproved) {
            inText = '✅ Already done (Approved for this session)';
        } else if (inOpen) {
            inText = '🚨 OPEN NOW for entry!';
        } else if (text.includes('IN OTP entry will be available once your faculty generates it')) {
            inText = '⏳ Waiting for faculty to generate IN OTP';
        }

        // 2. OUT OTP status
        const outMatch = text.match(/OUT OTP approved on ([^\n\.]+)/i);
        const outApproved = !!outMatch ||
                            bodyLower.includes('out attendance has been approved') ||
                            bodyLower.includes('out otp approved') ||
                            bodyLower.includes('out otp submitted') ||
                            /out otp[\s\S]{0,100}submitted/i.test(bodyLower);

        const outForm = document.querySelector('form[data-otp-form][data-otp-type="out"], form[data-otp-type="out"]');
        const outInput = outForm ? outForm.querySelector('input:not([type="hidden"])') : null;
        const outOpen = !!(outInput && !outInput.disabled && outInput.offsetParent !== null);

        let outText = '⏳ Waiting for faculty to generate';
        if (outApproved) {
            outText = outMatch ? `✅ Already done (Approved on ${outMatch[1].trim()})` : '✅ Already done (Approved for this session)';
        } else if (outOpen) {
            outText = '🚨 OPEN NOW for entry!';
        } else if (text.includes('OUT OTP will be enabled after your IN OTP entry')) {
            outText = '⏳ Will be enabled after IN OTP entry';
        } else if (text.includes('OUT OTP entry will be available once your faculty generates it')) {
            outText = '⏳ Waiting for faculty to generate OUT OTP';
        }

        return { inApproved, inOpen, inText, outApproved, outOpen, outText };
    });
}

// ─── Instant Attendance Status Snapshot ───────────────────────────────────────

async function checkAttendanceStatus(session, targetKeyword, chatId = CHAT_ID) {
    if (!isSuperAdmin(chatId)) {
        await sendTelegram(`⛔ The OTP attendance feature is restricted to Super Admin only.`, chatId);
        return;
    }
    const page = await session.context.newPage();
    try {
        await page.goto('https://learner.saveetha.in/academics/people_schedule/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (page.url().includes('/login')) {
            await doLogin(page, session.config.user, session.config.pass);
            await page.goto('https://learner.saveetha.in/academics/people_schedule/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        }
        await page.waitForTimeout(2500);

        const target = await findAttendanceTarget(page, targetKeyword);
        if (!target || !target.href) {
            await sendTelegram(`⚠️ No attendance link found on schedule for *${targetKeyword || 'today'}*.`, chatId);
            return;
        }

        const attendanceUrl = target.href.startsWith('http') ? target.href : `https://learner.saveetha.in${target.href}`;
        console.log(`[Status] Navigating to: ${attendanceUrl}`);
        await page.goto(attendanceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        const status = await getPageAttendanceStatus(page);

        const screenshotPath = path.join(__dirname, `_status_${Date.now()}.png`);
        try {
            await page.screenshot({ path: screenshotPath });
            let msg = `📋 *Attendance Status*\n\n` +
                      `📚 *Class:* *${target.name}*\n\n` +
                      `• *IN OTP:* ${status.inText}\n` +
                      `• *OUT OTP:* ${status.outText}\n`;

            if (status.inApproved && status.outApproved) {
                msg += `\n🎉 *It is already done!* Both IN and OUT attendance are complete for this session.`;
                await sendTelegramPhoto(screenshotPath, msg, chatId);
                return;
            } else if (status.inApproved && !status.outOpen) {
                msg += `\n✅ *It is already done!* IN attendance has already been approved for this session.`;
            }

            const isOpen = status.inOpen || status.outOpen;
            if (isOpen) {
                const activePhase = status.inOpen ? 'start' : 'end';
                const activeLabel = status.inOpen ? 'IN OTP' : 'OUT OTP';
                msg += `\n🚨 *${activeLabel} Box is OPEN NOW!*`;
                msg += `\n\n👉 *Reply directly with your 6-digit OTP now to submit!*`;
                await sendTelegramPhoto(screenshotPath, msg, chatId);

                // Wait for user to reply with 6-digit OTP via Telegram!
                const userOtp = await new Promise(resolve => {
                    const timeout = setTimeout(() => {
                        if (pendingOtpRequests.has(chatId)) {
                            pendingOtpRequests.delete(chatId);
                        }
                        resolve(null);
                    }, 5 * 60 * 1000);

                    pendingOtpRequests.set(chatId, (code) => {
                        clearTimeout(timeout);
                        resolve(code.trim());
                    });
                });

                if (!userOtp) {
                    await sendTelegram(`⏰ Timed out waiting for OTP. Session closed for *${target.name}*.`, chatId);
                    return;
                }

                await enterAndVerifyOtp(page, userOtp, activePhase, target.name, chatId);
                return;
            } else {
                await sendTelegramPhoto(screenshotPath, msg, chatId);
            }
        } catch (err) {
            await sendTelegram(
                `📋 *Attendance Status — ${target.name}*\n\n` +
                `• *IN OTP:* ${status.inText}\n` +
                `• *OUT OTP:* ${status.outText}`,
                chatId
            );
        } finally {
            try { fs.unlinkSync(screenshotPath); } catch (_) {}
        }
    } catch (e) {
        console.error('[AttendanceStatus] Error:', e);
        await sendTelegram(`⚠️ Error checking attendance status: ${e.message}`, chatId);
    } finally {
        await page.close().catch(() => {});
    }
}

// Backward-compatibility alias
async function startAttendanceMonitor(context, config, targetKeyword, startTimeStr, endTimeStr, chatId) {
    const session = USER_SESSIONS.get(chatId) || { context, config };
    return handleAttendanceOtp(session, targetKeyword, 'start', chatId);
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function doLogin(page, user, pass) {
    console.log(`[Bot] Logging in as ${user}...`);
    if (!page.url().includes('/login') && !page.url().includes('/authorize')) {
        await page.goto('https://learner.saveetha.in/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    // Try multiple selectors for the username field
    const userSelectors = [
        '#id_username',
        'input[name="username"]',
        'input[name="uid"]',
        '#username',
        'input[type="text"]',
        'input[placeholder*="user" i]',
        'input[placeholder*="id" i]',
        'input[placeholder*="roll" i]'
    ];

    let userInput = null;
    for (const sel of userSelectors) {
        try {
            await page.waitForSelector(sel, { timeout: 10000, state: 'visible' });
            userInput = page.locator(sel).first();
            break;
        } catch (_) { }
    }

    if (!userInput) {
        const title = await page.title().catch(() => 'unknown');
        throw new Error(`Could not find username input on login page. URL: ${page.url()}, Title: ${title}`);
    }

    // Fill using React-compatible method
    await userInput.fill(String(user));

    const passInput = page.locator('input[type="password"]').first();
    await passInput.fill(String(pass));

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
        } catch (_) { }
    }
    if (!clicked) await page.keyboard.press('Enter');

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);

    // Wait for SSO redirects to complete
    try {
        await page.waitForURL(url => !url.href.includes('/login') && !url.href.includes('/authorize'), { timeout: 15000 });
    } catch (e) {
        // ignore timeout, we'll just log the URL anyway
    }
    await page.waitForTimeout(500);

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
            // Find all elements that contain BOTH "SLOT :" and "VENUE :" labels.
            // Sort smallest-first so we get the most granular card element.
            const allEls = Array.from(document.querySelectorAll('div, li, section, article, tr'));
            const cardEls = allEls
                .filter(el => {
                    const txt = el.innerText || '';
                    return /SLOT\s*:/i.test(txt) && /VENUE\s*:/i.test(txt);
                })
                .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);

            // De-duplicate: skip elements that contain a previously selected card
            const selectedCards = [];
            for (const el of cardEls) {
                if (!selectedCards.some(prev => el.contains(prev))) {
                    selectedCards.push(el);
                }
            }

            for (const card of selectedCards) {
                let lines = (card.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);

                // Recover missing header if we matched an inner element (like a card-body)
                if (lines.length > 0 && (/^SLOT\s*:/i.test(lines[0]) || /^VENUE\s*:/i.test(lines[0]) || /^Lesson\s*:/i.test(lines[0]))) {
                    let curr = card;
                    for (let i = 0; i < 3; i++) {
                        if (!curr.parentElement) break;
                        curr = curr.parentElement;
                        const parentLines = (curr.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
                        if (parentLines.length > 0 && parentLines[0] !== lines[0]) {
                            const pLine = parentLines[0];
                            if (pLine.length > 3 &&
                                !/^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/i.test(pLine) &&
                                !/^\d{1,2}\s*(MON|TUE|WED|THU|FRI|SAT|SUN)/i.test(pLine) &&
                                !/^(MON|TUE|WED|THU|FRI|SAT|SUN)/i.test(pLine)) {
                                lines.unshift(pLine);
                                break;
                            }
                        }
                    }
                }

                let venue = '', slotCode = '', timeInfo = null, subject = '';

                for (const line of lines) {
                    if (/^VENUE\s*:/i.test(line)) {
                        venue = line.replace(/^VENUE\s*:\s*/i, '').trim();
                    } else if (/^SLOT\s*:/i.test(line)) {
                        slotCode = line.replace(/^SLOT\s*:\s*/i, '').trim();
                    } else if (/(\d{1,2})[\.:](\d{2})\s*(AM|PM|am|pm)?/i.test(line) && !timeInfo) {
                        timeInfo = parseTime(line);
                    } else if (line.length > 5 &&
                        !/^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/i.test(line) &&
                        !/^\d{1,2}\s*(MON|TUE|WED|THU|FRI|SAT|SUN)/i.test(line) &&
                        !/^(MON|TUE|WED|THU|FRI|SAT|SUN)/i.test(line) &&
                        !/VIEW\s*ATTENDANCE/i.test(line)) {
                        if (!subject) subject = line;
                    }
                }

                if (timeInfo && (subject || venue)) {
                    results.push({
                        slot: subject || 'Class',
                        venue: venue || 'N/A',
                        ...timeInfo,
                        hasToday: true
                    });
                }
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
        await page.close().catch(() => { });
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

// ─── Workflow Requests Scraper ───────────────────────────────────────────────

/**
 * Scrapes workflow requests from the learner portal.
 */
async function fetchWorkflowRequests(context, config, keyword = '') {
    const page = await context.newPage();
    try {
        console.log(`[Workflow] Fetching workflow requests for ${config.name}...`);
        await page.goto('https://learner.saveetha.in/academics/workflow-requests/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        if (page.url().includes('/login')) {
            console.log(`[Workflow] Session expired for ${config.name} — re-logging in...`);
            await doLogin(page, config.user, config.pass);
            await page.goto('https://learner.saveetha.in/academics/workflow-requests/', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
        }

        await page.waitForTimeout(3000);

        // Find all "Open" buttons for requests
        let requestLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a.btn-outline-primary'));
            return links.filter(l => l.innerText.trim().toLowerCase() === 'open').map(l => {
                const card = l.closest('.card');
                let title = 'Unknown Request';
                let status = 'Unknown Status';
                if (card) {
                    const h5 = card.querySelector('h5');
                    if (h5) title = h5.innerText.trim();
                    const badge = card.querySelector('.badge');
                    if (badge) status = badge.innerText.trim();
                }
                return { href: l.href, title, status };
            });
        });

        if (keyword) {
            requestLinks = requestLinks.filter(r => r.title.toLowerCase().includes(keyword.toLowerCase()));
        }

        if (requestLinks.length === 0) {
            return `No open workflow requests found for *${config.name}*${keyword ? ` matching "${keyword}"` : ''}.`;
        }

        let msg = `📋 *Workflow Requests for ${config.name}*\n\n`;

        // Check all requests
        for (let i = 0; i < requestLinks.length; i++) {
            const req = requestLinks[i];
            msg += `🔹 *${req.title}* (${req.status})\n`;

            await page.goto(req.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(2000);

            // Try to click "Approval Flow" tab
            const clicked = await page.evaluate(() => {
                const tabs = Array.from(document.querySelectorAll('a, button, [role="tab"], li, span'));
                for (const tab of tabs) {
                    if (tab.innerText?.trim().toLowerCase().includes('approval flow') || tab.innerText?.trim().toLowerCase().includes('approval')) {
                        tab.click();
                        return true;
                    }
                }
                return false;
            });

            if (clicked) {
                await page.waitForTimeout(2000); // wait for JS to load table
                // Scrape the table
                const approvalData = await page.evaluate(() => {
                    const rows = Array.from(document.querySelectorAll('table tbody tr'));
                    return rows.map(r => {
                        const cols = r.querySelectorAll('td');
                        if (cols.length >= 5) {
                            return {
                                role: cols[1].innerText.trim(),
                                approver: cols[2].innerText.trim(),
                                status: cols[4].innerText.trim()
                            };
                        }
                        return null;
                    }).filter(Boolean);
                });

                if (approvalData.length > 0) {
                    approvalData.forEach(level => {
                        const icon = level.status.toLowerCase().includes('approved') ? '✅' : (level.status.toLowerCase().includes('rejected') ? '❌' : '⏳');
                        msg += `  ↳ ${icon} ${level.role}: ${level.status} (${level.approver})\n`;
                    });
                } else {
                    msg += `  ↳ ⏳ Pending (No approval steps assigned yet)\n`;
                }
            } else {
                msg += `  ↳ ⚠️ Could not load Approval Flow.\n`;
            }
            msg += `\n`;
        }

        return msg.trim();
    } catch (e) {
        console.error('[Workflow] Error:', e);
        throw new Error('Failed to scrape workflow requests.');
    } finally {
        await page.close();
    }
}

// ─── Attendance Scraper ───────────────────────────────────────────────────────

/**
 * Scrapes attendance from studentsubjects page.
 */
async function fetchAttendance(context, config) {
    const page = await context.newPage();
    try {
        console.log(`[Attendance] Fetching attendance for ${config.name}...`);
        await page.goto('https://learner.saveetha.in/academics/studentsubjects/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        // If redirected to login, re-login
        if (page.url().includes('/login')) {
            console.log(`[Attendance] Session expired for ${config.name} — re-logging in...`);
            await doLogin(page, config.user, config.pass);
            await page.goto('https://learner.saveetha.in/academics/studentsubjects/', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
        }

        // Wait for table/schedule content
        await page.waitForTimeout(3000);

        const attendanceData = await page.evaluate(() => {
            const results = [];

            // ── Strategy 1: Table rows ─────────────────────────────────
            const tables = document.querySelectorAll('table');
            for (const table of tables) {
                const rows = table.querySelectorAll('tr');
                if (rows.length < 2) continue;

                const headerRow = table.querySelector('tr:first-child');
                let subjectCol = -1, percentCol = -1, attendedCol = -1, totalCol = -1;

                if (headerRow) {
                    const headers = Array.from(headerRow.querySelectorAll('th, td')).map(c => c.innerText.trim().toLowerCase());
                    headers.forEach((h, i) => {
                        if (h.includes('subject') || h.includes('course') || h.includes('name')) subjectCol = i;
                        if (h.includes('%') || h.includes('percentage') || h.includes('percent')) percentCol = i;
                        if (h.includes('present') || h.includes('attended') || h.includes('attend')) attendedCol = i;
                        if (h.includes('total') || h.includes('conducted')) totalCol = i;
                    });
                }

                if (subjectCol === -1) subjectCol = 0; // fallback to first column

                for (let i = 1; i < rows.length; i++) {
                    const row = rows[i];
                    // Skip if it's just headers
                    if (row.querySelectorAll('th').length === row.querySelectorAll('th, td').length) continue;

                    const cells = Array.from(row.querySelectorAll('td, th')).map(c => c.innerText.trim());
                    if (cells.length < 2) continue;

                    let subject = cells[subjectCol] || '';
                    let percent = percentCol !== -1 ? cells[percentCol] : '';
                    let attended = attendedCol !== -1 ? cells[attendedCol] : '';
                    let total = totalCol !== -1 ? cells[totalCol] : '';

                    if (!percent) {
                        for (const cell of cells) {
                            if (cell.includes('%')) { percent = cell; break; }
                        }
                    }
                    if (!attended && !total) {
                        for (const cell of cells) {
                            const match = cell.match(/^(\d+)\s*\/\s*(\d+)$/);
                            if (match) { attended = match[1]; total = match[2]; break; }
                        }
                    }

                    if (subject) {
                        results.push({ subject, percent, attended, total });
                    }
                }
                if (results.length > 0) break; // Use the first table that yields results
            }

            // ── Strategy 2: Cards ──────────────────────────────────────
            if (results.length === 0) {
                const allElements = Array.from(document.querySelectorAll('div, section, article, li'));
                // Find all elements that contain typical card keywords
                const cardCandidates = allElements.filter(el => {
                    const txt = el.innerText || '';
                    return txt.includes('Overall Attendance') && (txt.includes('Slot:') || txt.includes('Academic Term:'));
                });

                // De-duplicate (keep only the smallest containers that still have all the info)
                cardCandidates.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
                const selectedCards = [];
                for (const el of cardCandidates) {
                    if (!selectedCards.some(prev => el.contains(prev)) && el.innerText.length < 1500) {
                        selectedCards.push(el);
                    }
                }

                for (const card of selectedCards) {
                    const lines = card.innerText.split('\n').map(l => l.trim()).filter(Boolean);
                    let subject = lines[0]; // The first line is usually the subject
                    let percent = '';
                    let attended = '';
                    let total = '';

                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        if (line.includes('Overall Attendance') && i + 1 < lines.length) {
                            let nextLine = lines[i + 1];
                            if (nextLine.includes('%') || nextLine.includes('N/A')) {
                                percent = nextLine;
                            }
                        } else if (line.includes('%') && !percent) {
                            percent = line;
                        }

                        // Match the "Present" stats (e.g. "18.00 / 24.00")
                        // It could be on the same line as "Present" or the line immediately after
                        const match = line.match(/([\d.]+)\s*\/\s*([\d.]+)/);
                        if (match && !attended) {
                            attended = parseFloat(match[1]).toString();
                            total = parseFloat(match[2]).toString();
                        }
                    }
                    if (subject && percent) {
                        // Prevent duplicates (sometimes the DOM has hidden copies of cards)
                        if (!results.some(r => r.subject === subject)) {
                            results.push({ subject, percent, attended, total });
                        }
                    }
                }
            }
            return results;
        });

        return attendanceData;
    } catch (err) {
        console.error(`[Attendance] Error fetching for ${config.name}:`, err.message);
        throw err;
    } finally {
        await page.close().catch(() => { });
    }
}

function formatAttendance(data, userName) {
    if (!data || data.length === 0) {
        return `⚠️ Could not find attendance records for ${userName}.`;
    }

    let msg = `📊 *Attendance for ${userName}*\n\n`;

    let totalAttended = 0;
    let totalConducted = 0;

    data.forEach(item => {
        // Only escape basic Markdown characters (*, _, `, [) since we use 'Markdown' parse_mode, not V2.
        let sub = item.subject.replace(/([_*`\[])/g, '\\$1');
        if (sub.length > 55) sub = sub.substring(0, 52) + '...';

        let percentNum = parseFloat(item.percent);
        let icon = '⚪';
        if (!isNaN(percentNum)) {
            if (percentNum >= 85) icon = '🟢';
            else if (percentNum >= 75) icon = '🟡';
            else icon = '🔴';
        }

        let percentText = item.percent ? item.percent.replace(/([_*`\[])/g, '\\$1') : 'N/A';
        let stats = '';

        // Only show (Attended/Total) if Total is not 0.
        if (item.attended && item.total && item.total !== '0') {
            stats = ` (${item.attended}/${item.total})`;
            totalAttended += parseFloat(item.attended);
            totalConducted += parseFloat(item.total);
        }

        msg += `${icon} *${sub}*\n   └ ${percentText}${stats}\n\n`;
    });

    if (totalConducted > 0) {
        let overallPercent = ((totalAttended / totalConducted) * 100).toFixed(2);
        msg += `\n🎯 *Overall Attendance: ${overallPercent}%* _(${totalAttended}/${totalConducted})_`;
    }

    return msg.trim();
}

// ─── Bunk Calculator ──────────────────────────────────────────────────────────

async function fetchBunkStatsForSubject(context, config, targetSubject, subjectSummary = null) {
    const page = await context.newPage();
    try {
        console.log(`[Bunk] Fetching bunk stats for: ${targetSubject}...`);
        await page.goto('https://learner.saveetha.in/academics/studentsubjects/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });

        if (page.url().includes('/login')) {
            await doLogin(page, config.user, config.pass);
            await page.goto('https://learner.saveetha.in/academics/studentsubjects/', {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
        }
        await page.waitForTimeout(3000);

        // Find the button inside the card that contains the targetSubject
        const clickSuccess = await page.evaluate((subj) => {
            const buttons = Array.from(document.querySelectorAll('a, button, [role="button"]'))
                .filter(b => (b.innerText || '').includes('View Slot Details'));

            for (const btn of buttons) {
                // find closest card container
                let card = btn.closest('div[class*="card"], div[class*="MuiPaper"], div[class*="box"], section, article, li');
                if (!card && btn.parentElement && btn.parentElement.parentElement) {
                    card = btn.parentElement.parentElement.parentElement; // fallback 3 levels up
                }

                if (card && (card.innerText || '').includes(subj)) {
                    btn.click();
                    return true;
                }
            }

            // Extreme fallback: just click the first button if only 1 exists, otherwise fail
            if (buttons.length === 1) {
                buttons[0].click();
                return true;
            }
            return false;
        }, targetSubject);

        if (!clickSuccess) {
            console.warn(`[Bunk] Could not find 'View Slot Details' button for ${targetSubject}. Proceeding with card summary.`);
        } else {
            await page.waitForTimeout(3000); // Wait for modal/drawer to load
            await page.waitForSelector('text="Total Sessions"', { timeout: 8000 }).catch(() => { });
        }

        const pageText = await page.innerText('body');

        let presentHours = null, conductedHours = null;
        let totalSessions = null, upcomingSessions = null;
        let percent = 0;

        // 1. Overall Attendance %
        const attMatch = pageText.match(/Overall Attendance[\s\S]{0,50}?([\d.]+)%/i);
        if (attMatch) percent = parseFloat(attMatch[1]);

        // 2. Present / Attended hours vs Conducted hours
        const presentMatch = pageText.match(/Present[\s\S]{0,30}?([\d.]+)\s*\/\s*([\d.]+)/i) ||
            pageText.match(/(?:Attended|Present)[\s\S]{0,30}?([\d.]+)\s*(?:\/|out of)\s*([\d.]+)/i);
        if (presentMatch) {
            presentHours = parseFloat(presentMatch[1]);
            conductedHours = parseFloat(presentMatch[2]);
        }

        // 3. Total scheduled sessions for this course
        const totalMatch = pageText.match(/Total Sessions[\s\S]{0,30}?(?<!\d)(\d+)(?!\d)/i) ||
            pageText.match(/Total sessions scheduled:?\s*(\d+)/i) ||
            pageText.match(/Total Classes:?\s*(\d+)/i) ||
            pageText.match(/Total:?\s*(\d+)/i);
        if (totalMatch) {
            totalSessions = parseInt(totalMatch[1], 10);
        }

        // 4. Upcoming / Remaining sessions
        const upMatch = pageText.match(/Upcoming(?:\s*Sessions)?:?\s*(\d+)/i) ||
            pageText.match(/Remaining(?:\s*Sessions)?:?\s*(\d+)/i);
        if (upMatch) {
            upcomingSessions = parseInt(upMatch[1], 10);
        }

        // 5. Fallback from subjectSummary (scraped directly from the subject card on main page)
        if (subjectSummary) {
            if (presentHours === null && subjectSummary.attended !== undefined && subjectSummary.attended !== '') {
                const a = parseFloat(subjectSummary.attended);
                if (!isNaN(a)) presentHours = a;
            }
            if (conductedHours === null && subjectSummary.total !== undefined && subjectSummary.total !== '') {
                const c = parseFloat(subjectSummary.total);
                if (!isNaN(c)) conductedHours = c;
            }
            if (!percent && subjectSummary.percent) {
                const p = parseFloat(subjectSummary.percent.replace(/[^0-9.]/g, ''));
                if (!isNaN(p)) percent = p;
            }
        }

        // Clean up numbers
        if (presentHours === null || isNaN(presentHours)) presentHours = 0;
        if (conductedHours === null || isNaN(conductedHours)) conductedHours = 0;
        if (percent === null || isNaN(percent)) {
            percent = conductedHours > 0 ? (presentHours / conductedHours) * 100 : 0;
        }

        // Determine session count and upcoming count
        // Hours per session is AT LEAST 1 (never 0!)
        const hoursPerSession = 1;
        const conductedSessions = Math.round(conductedHours / hoursPerSession);

        if (totalSessions && totalSessions > 0) {
            if (conductedHours === 0) {
                // If 0 classes conducted, ALL total sessions are upcoming!
                upcomingSessions = totalSessions;
            } else {
                // Remaining sessions in the semester is total minus conducted
                upcomingSessions = Math.max(0, totalSessions - conductedSessions);
            }
        } else {
            // If totalSessions not found, use upcomingSessions if found, else 0
            if (upcomingSessions === null) upcomingSessions = 0;
            totalSessions = conductedSessions + upcomingSessions;
        }

        const remainingHours = upcomingSessions * hoursPerSession;
        const totalSemesterHours = Math.max(
            conductedHours + remainingHours,
            totalSessions * hoursPerSession,
            conductedHours
        );

        let maxBunkSessions = 0;
        let projectedFinalPercent = percent;

        if (totalSemesterHours > 0) {
            // Target is 80% attendance
            const targetAttendedHours = totalSemesterHours * 0.80;
            const missedHours = Math.max(0, conductedHours - presentHours);

            // Allowed total misses across semester minus misses already taken
            const maxBunkHours = totalSemesterHours - targetAttendedHours - missedHours;
            maxBunkSessions = Math.floor(maxBunkHours / hoursPerSession);

            projectedFinalPercent = ((presentHours + remainingHours) / totalSemesterHours) * 100;
        } else if (conductedHours > 0) {
            // Only current attendance known
            const targetAttended = conductedHours * 0.80;
            if (presentHours >= targetAttended) {
                maxBunkSessions = Math.floor((presentHours - 0.80 * conductedHours) / 0.80);
            } else {
                const needed = Math.ceil((0.80 * conductedHours - presentHours) / 0.20);
                maxBunkSessions = -needed;
            }
        }

        const result = {
            subject: targetSubject,
            percent,
            presentHours,
            conductedHours,
            totalSessions,
            upcomingSessions,
            totalSemesterHours,
            maxBunkSessions,
            projectedFinalPercent,
            targetPercent: 80
        };

        return [result];
    } catch (err) {
        console.error(`[Bunk] Error for ${config.name}:`, err.message);
        throw err;
    } finally {
        await page.close().catch(() => { });
    }
}

function formatBunkStats(data, userName) {
    if (!data || data.length === 0) {
        return `⚠️ Could not calculate bunk stats for ${userName}. (Missing schedule info)`;
    }

    let msg = `🛌 *Bunk Calculator (80% Limit) for ${userName}*\n\n`;

    data.forEach(item => {
        let sub = item.subject.replace(/([_*`\[])/g, '\\$1');
        if (sub.length > 55) sub = sub.substring(0, 52) + '...';

        let status = '';
        if (item.maxBunkSessions > 0) {
            status = `🟢 *You can safely bunk ${item.maxBunkSessions} class${item.maxBunkSessions > 1 ? 'es' : ''}!*`;
        } else if (item.maxBunkSessions === 0) {
            status = `🟡 *Do NOT bunk anymore!* You are on the borderline (attend all remaining classes).`;
        } else {
            const shortage = Math.abs(item.maxBunkSessions);
            if (item.projectedFinalPercent !== undefined && item.projectedFinalPercent < 80) {
                status = `🔴 *Shortage!* Even attending all remaining classes yields ${item.projectedFinalPercent.toFixed(2)}%. You need ${shortage} extra class${shortage > 1 ? 'es' : ''} to reach 80%.`;
            } else {
                status = `🔴 *Shortage!* You need to attend ${shortage} extra class${shortage > 1 ? 'es' : ''} to reach 80%.`;
            }
        }

        msg += `🔹 *${sub}*\n`;
        if (item.conductedHours === 0) {
            msg += `   ├ Current: *0.00%* _(0 classes conducted yet)_\n`;
        } else {
            msg += `   ├ Current: *${item.percent.toFixed(2)}%* _(${item.presentHours}/${item.conductedHours} attended)_\n`;
        }
        if (item.totalSessions > 0) {
            msg += `   ├ Total Semester Classes: *${item.totalSessions}*\n`;
        }
        if (item.projectedFinalPercent !== undefined && item.totalSemesterHours > 0) {
            if (item.upcomingSessions > 0) {
                msg += `   ├ If attend all remaining (${item.upcomingSessions}): *${item.projectedFinalPercent.toFixed(2)}%*\n`;
            } else {
                msg += `   ├ No upcoming classes left.\n`;
            }
        }
        msg += `   └ ${status}\n\n`;
    });

    return msg.trim();
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

    // Schedulers started

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
            waitUntil: 'domcontentloaded',
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
            } catch (e) { }
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
    } catch (err) { }
}

const activeReminders = new Map();

function scheduleSlotReminders(chatId, session, slots) {
    if (!slots || !slots.length) return;
    const allowOtp = isSuperAdmin(chatId);
    const nowIST = getNowIST();

    for (const s of slots) {
        // Class start time today in IST
        const slotStart = getNowIST();
        slotStart.setHours(s.hour, s.minute, 0, 0);

        // Class end time today in IST (default 90 min)
        const slotEnd = new Date(slotStart.getTime() + (s.durationMinutes || 90) * 60 * 1000);

        // ── 1. 15-Minute Class Reminder (All Users) ───────────────────────────
        const reminderTime = new Date(slotStart.getTime() - 15 * 60 * 1000);
        const reminderDelay = reminderTime.getTime() - nowIST.getTime();
        const reminderKey = `rem_${chatId}_${s.slot}_${s.hour}_${s.minute}`;

        if (reminderDelay > 0) {
            if (activeReminders.has(reminderKey)) {
                clearTimeout(activeReminders.get(reminderKey));
            }
            const timeoutId = setTimeout(async () => {
                activeReminders.delete(reminderKey);
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
            }, reminderDelay);
            activeReminders.set(reminderKey, timeoutId);
            console.log(`[Scheduler] 15m reminder for "${s.slot}" in ${Math.round(reminderDelay / 60000)} min (${session.config.name})`);
        }

        // ── 2 & 3: OTP Attendance (SUPER ADMIN ONLY) ──────────────────────────
        if (allowOtp) {
            // IN OTP: starts 10 min before class start (e.g. 7:50 AM for 8:00 AM class)
            // and stops 5 min after class start (e.g. 8:05 AM)
            const inScanStart = new Date(slotStart.getTime() - 10 * 60 * 1000);
            const inScanStop = new Date(slotStart.getTime() + 5 * 60 * 1000);
            const inScanDuration = 15 * 60 * 1000; // 15 min total

            const inDelay = inScanStart.getTime() - nowIST.getTime();
            const inKey = `in_otp_${chatId}_${s.slot}_${s.hour}_${s.minute}`;

            if (inDelay > 0) {
                if (activeReminders.has(inKey)) {
                    clearTimeout(activeReminders.get(inKey));
                }
                const inTimeoutId = setTimeout(() => {
                    activeReminders.delete(inKey);
                    console.log(`[Scheduler] IN OTP 7:50 AM trigger fired for "${s.slot}" — scanning until 8:05 AM (15 min)`);
                    handleAttendanceOtp(session, s.slot, 'start', chatId, null, inScanDuration);
                }, inDelay);
                activeReminders.set(inKey, inTimeoutId);
                console.log(`[Scheduler] IN OTP monitor for "${s.slot}" scheduled in ${Math.round(inDelay / 60000)} min (${session.config.name})`);
            } else if (nowIST.getTime() >= inScanStart.getTime() && nowIST.getTime() <= inScanStop.getTime()) {
                // Class is within the 7:50 AM - 8:05 AM window right now!
                const remainingMs = inScanStop.getTime() - nowIST.getTime();
                console.log(`[Scheduler] Class "${s.slot}" is in 7:50-8:05 window — scanning IN OTP for remaining ${Math.round(remainingMs / 60000)} min`);
                handleAttendanceOtp(session, s.slot, 'start', chatId, null, remainingMs);
            }

            // OUT OTP: starts 10 min before class end and stops 5 min after class end
            const outScanStart = new Date(slotEnd.getTime() - 10 * 60 * 1000);
            const outScanStop = new Date(slotEnd.getTime() + 5 * 60 * 1000);
            const outScanDuration = 15 * 60 * 1000;

            const outDelay = outScanStart.getTime() - nowIST.getTime();
            const outKey = `out_otp_${chatId}_${s.slot}_${s.hour}_${s.minute}`;

            if (outDelay > 0) {
                if (activeReminders.has(outKey)) {
                    clearTimeout(activeReminders.get(outKey));
                }
                const outTimeoutId = setTimeout(() => {
                    activeReminders.delete(outKey);
                    console.log(`[Scheduler] OUT OTP trigger fired for "${s.slot}" — scanning (15 min)`);
                    handleAttendanceOtp(session, s.slot, 'end', chatId, null, outScanDuration);
                }, outDelay);
                activeReminders.set(outKey, outTimeoutId);
                console.log(`[Scheduler] OUT OTP monitor for "${s.slot}" scheduled in ${Math.round(outDelay / 60000)} min (${session.config.name})`);
            } else if (nowIST.getTime() >= outScanStart.getTime() && nowIST.getTime() <= outScanStop.getTime()) {
                const remainingMs = outScanStop.getTime() - nowIST.getTime();
                console.log(`[Scheduler] Class "${s.slot}" is in OUT OTP window — scanning for remaining ${Math.round(remainingMs / 60000)} min`);
                handleAttendanceOtp(session, s.slot, 'end', chatId, null, remainingMs);
            }
        }
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

    // Initialize global API request context to bypass Node's fetch blocks
    apiRequest = await browser.newContext().then(ctx => ctx.request);

    // Pre-login each user and keep a "Hot Tab" ready on the booking page
    await initAccounts();

    // Set up accounts non-blocking (in the background)
    // Filter out blocked users from the initial startup sequence
    const accountEntries = Object.entries(ACCOUNTS).filter(([chatId]) => !blockedUsers.has(chatId));
    accountEntries.forEach(([chatId, config]) => {
        if (!config.name) config.name = `User ${config.user}`;
    });

    (async () => {
        console.log('[Bot] Starting concurrent logins in the background with stagger...');
        await Promise.all(accountEntries.map(async ([chatId, config], index) => {
            // Stagger by 2.5 seconds each to avoid hammering the SSO server and getting rate-limited
            await new Promise(r => setTimeout(r, index * 2500));
            await spawnUserSession(browser, chatId, config);
        }));

        // Retry failed logins up to 2 more times before declaring online
        const MAX_STARTUP_RETRIES = 2;
        for (let retry = 1; retry <= MAX_STARTUP_RETRIES; retry++) {
            const failedAccounts = accountEntries.filter(([chatId]) => !USER_SESSIONS.has(chatId));
            if (failedAccounts.length === 0) break;
            console.log(`[Bot] Retry ${retry}/${MAX_STARTUP_RETRIES}: ${failedAccounts.length} account(s) failed to login, retrying in 10s...`);
            await new Promise(r => setTimeout(r, 10000));
            await Promise.all(failedAccounts.map(async ([chatId, config], index) => {
                await new Promise(r => setTimeout(r, index * 2500));
                await spawnUserSession(browser, chatId, config);
            }));
        }

        // Send accurate startup notification
        const onlineCount = USER_SESSIONS.size;
        const totalCount = accountEntries.length;
        if (onlineCount === totalCount) {
            await sendTelegram(`✅ *Saveetha Bot Initialized!* (Hot Tab Mode)\nAll ${onlineCount} accounts logged in.\n📅 Daily timetable at *8:00 AM IST* + 15-min class reminders are active!`);
        } else {
            const failedNames = accountEntries
                .filter(([chatId]) => !USER_SESSIONS.has(chatId))
                .map(([chatId, config]) => config.name)
                .join(', ');
            await sendTelegram(`⚠️ *Saveetha Bot Initialized!* (Hot Tab Mode)\n${onlineCount}/${totalCount} accounts ready. Failed to login: *${failedNames}*\n_Retrying failed accounts in the background..._\n📅 Daily timetable at *8:00 AM IST* + 15-min class reminders are active!`);
        }
    })();

    // Optional: Keep-alive loop to prevent sessions from timing out
    setInterval(async () => {
        for (const [chatId, session] of USER_SESSIONS.entries()) {
            if (!session.isBusy) {
                try {
                    // Just refresh or check if still on booking page every 10 mins
                    if (!session.persistentPage.url().includes('event-booking')) {
                        await session.persistentPage.goto('https://learner.saveetha.in/academicevents/event-booking/', { waitUntil: 'domcontentloaded' });
                    }
                } catch (e) { }
            }
        }
    }, 600000); // Every 10 mins

    // Background retry: keep trying to spawn any sessions that still failed
    const bgRetryInterval = setInterval(async () => {
        const remaining = Object.entries(ACCOUNTS).filter(([chatId]) => !USER_SESSIONS.has(chatId) && !blockedUsers.has(chatId));
        if (remaining.length > 0) {
            console.log(`[Bot] Background retry: ${remaining.length} account(s) offline, retrying...`);
            for (const [chatId, config] of remaining) {
                await spawnUserSession(browser, chatId, config);
            }
        }
    }, 60000); // Retry every 60 seconds

    // ── Start Timetable Schedulers for all users ──────────────────────────────
    // (Note: Handled inside spawnUserSession now)

    // Track active bookings
    let activeTasks = new Map(); // taskId -> { keyword, targetTime, startTime, phase, stopRequested, page, isScan, isUnbook, fromChatId, userConfig }
    let taskIdCounter = 0;

    async function syncFileToGist(filename, content) {
        if (!GIST_TOKEN || !GIST_ID) return;
        try {
            const https = require('https');
            const body = JSON.stringify({
                files: {
                    [filename]: {
                        content: content
                    }
                }
            });
            const req = https.request({
                hostname: 'api.github.com',
                path: `/gists/${GIST_ID}`,
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${GIST_TOKEN}`,
                    'User-Agent': 'saveetha-bot',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'Accept': 'application/vnd.github.v3+json',
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            }, (res) => {
                // fire and forget
            });
            req.on('error', (e) => console.error('[Persist] Gist file sync error:', e.message));
            req.write(body);
            req.end();
        } catch (e) {
            console.error('[Persist] Failed to sync file to gist:', e.message);
        }
    }

    function saveTasks() {
        const tasksArr = [];
        activeTasks.forEach((task, id) => {
            tasksArr.push({
                id,
                keyword: task.keyword,
                targetTime: task.targetTime,
                targetVenue: task.targetVenue,
                targetDate: task.targetDate,
                startTime: task.startTime,
                phase: task.phase,
                isScan: task.isScan,
                isUnbook: task.isUnbook,
                fromChatId: task.fromChatId,
                timerFinished: task.timerFinished
            });
        });
        const tasksData = { counter: taskIdCounter, tasks: tasksArr };
        // Save locally AND to Gist (async, fire-and-forget for speed)
        saveTasksToGist(tasksData).catch(e => console.error('[Persist] Gist save error:', e.message));
    }

    function removeTask(taskId) {
        activeTasks.delete(taskId);
        saveTasks();
    }

    // Poll Telegram for messages
    let offset = 0;
    console.log('[Bot] Polling Telegram for commands...');

    // Load tasks from Gist (survives GitHub Actions restarts) or local file
    try {
        const data = await loadTasksFromGist();
        if (data) {
            taskIdCounter = data.counter || 0;
            const loaded = data.tasks || [];
            let resumedCount = 0;
            for (const t of loaded) {
                if (t.stopRequested || t.phase === 'Cancelling slot') continue; // Skip finished/unbook ones
                const userConf = getUserConfig(t.fromChatId);
                if (!userConf) continue;
                const taskObj = {
                    ...t,
                    phase: 'Resuming from restart...',
                    stopRequested: false,
                    page: null,
                    userConfig: userConf
                };
                activeTasks.set(t.id, taskObj);
                startTaskLoop(t.id, taskObj);
                resumedCount++;
            }
            if (resumedCount > 0) {
                console.log(`[Bot] Resumed ${resumedCount} tasks from persistence.`);
                await sendTelegram(`🔄 *Bot restarted!* Resumed *${resumedCount}* active task(s) automatically.`);
            }
        }
    } catch (e) { console.error('[Bot] Error loading tasks:', e.message); }

    async function getOrSpawnSession(chatId, config) {
        let session = USER_SESSIONS.get(chatId);
        if (!session) {
            await sendTelegram(`⏳ Your session was not found (bot may have restarted). Attempting to log you in now, please wait...`, chatId);
            const success = await spawnUserSession(browser, chatId, config);
            if (success) {
                session = USER_SESSIONS.get(chatId);
                await sendTelegram(`✅ Session successfully initialized! Please send your command again if needed.`, chatId);
            } else {
                await sendTelegram(`❌ Failed to initialize session. The Saveetha portal might be down or slow. Please try again later.`, chatId);
                return null;
            }
        }
        return session;
    }

    async function checkGistForNewTasks() {
        if (!GIST_TOKEN || !GIST_ID) return;
        const data = await loadTasksFromGist();
        if (data && data.counter > taskIdCounter) {
            taskIdCounter = data.counter;
            for (let t of data.tasks) {
                if (!activeTasks.has(t.id)) {
                    if (t.stopRequested || t.phase === 'Cancelling slot') continue;
                    const userConf = getUserConfig(t.fromChatId);
                    if (!userConf) continue;
                    const taskObj = {
                        ...t,
                        phase: 'Picked up from database',
                        stopRequested: false,
                        page: null,
                        userConfig: userConf
                    };
                    activeTasks.set(t.id, taskObj);
                    startTaskLoop(t.id, taskObj);
                    console.log(`[Bot] Instantly picked up task ${t.id} from Gist.`);
                }
            }
        }
    }

    // Poll the Gist database every 10 seconds for instant booking tasks
    setInterval(checkGistForNewTasks, 10000);

    while (true) {
        try {
            const updates = await getTelegramUpdates(offset);

            // Also poll Gist for commands from the Pod
            const gistCommands = await fetchGistCommands();
            for (const cmd of gistCommands) {
                console.log(`[Bot] Received Gist Command from Pod: ${cmd.text}`);
                updates.push({
                    update_id: 0,
                    message: {
                        chat: { id: cmd.chatId },
                        text: cmd.text
                    }
                });
            }

            for (const update of updates) {
                if (update.update_id) offset = update.update_id + 1;

                const msg = update.message || update.channel_post;
                if (!msg || !msg.text) continue;

                // Check if user is authorized
                const fromChatId = String(msg.chat.id);
                const userConfig = getUserConfig(fromChatId);

                if (!userConfig && fromChatId !== ADMIN_CHAT_ID) {
                    console.log(`[Bot] Ignoring message from unauthorized chat: ${fromChatId}`);
                    // Optional: await sendTelegram(`⚠️ Your Chat ID (${fromChatId}) is not authorized for this bot.`);
                    continue;
                }

                if (blockedUsers.has(fromChatId) && fromChatId !== ADMIN_CHAT_ID) {
                    console.log(`[Bot] Ignoring message from blocked chat: ${fromChatId}`);
                    continue;
                }

                let text = msg.text.trim().toLowerCase();

                // ── OTP Intercept ───────────────────────────────────────────
                if (pendingOtpRequests.has(fromChatId)) {
                    const callback = pendingOtpRequests.get(fromChatId);
                    pendingOtpRequests.delete(fromChatId);
                    callback(msg.text.trim());
                    continue;
                }

                // ── Direct 6-Digit OTP message from Super Admin ─────────────
                if (isSuperAdmin(fromChatId) && /^\d{6}$/.test(msg.text.trim())) {
                    const code = msg.text.trim();
                    await sendTelegram(`⚡ Detected 6-digit OTP: \`${code}\`. Opening attendance page to submit now...`, fromChatId);
                    const session = await getOrSpawnSession(fromChatId, userConfig);
                    if (session) {
                        handleAttendanceOtp(session, '', 'start', fromChatId, code, 30000);
                    }
                    continue;
                }

                // ── Unusual Time / Typo Confirmation Intercept ─────────────
                if (pendingTimeConfirmations.has(fromChatId)) {
                    const pending = pendingTimeConfirmations.get(fromChatId);
                    const isYes = ['yes', 'y', 'commit', 'confirm', 'ok', 'proceed'].includes(text);
                    const isNo = ['no', 'n', 'cancel', 'abort', 'stop'].includes(text);

                    if (isYes) {
                        pendingTimeConfirmations.delete(fromChatId);

                        // If it was a typo confirmation, check if the corrected time is outside normal hours!
                        const targetCheck = isOutsideNormalHours(pending.targetTime);
                        const startCheck = isOutsideNormalHours(pending.startTime);
                        const unusual = targetCheck || startCheck;

                        if (unusual && pending.isTypoConfirmation) {
                            pendingTimeConfirmations.set(fromChatId, {
                                ...pending,
                                isTypoConfirmation: false,
                                unusualTime: unusual.timeStr,
                                isTooEarly: unusual.isTooEarly
                            });

                            const actionName = pending.isUnbook ? 'unbooking' : (pending.isScan ? 'scan' : 'booking');
                            const reason = unusual.isTooEarly ? 'too early' : 'outside normal college hours (after 6:00 PM)';
                            await sendTelegram(
                                `⚠️ *Time Corrected to ${unusual.timeStr}*\n\n` +
                                `However, this time is *${reason}* (normal college hours are *8:00 AM – 6:00 PM*).\n\n` +
                                `Should we commit this ${actionName} task for *${pending.keyword}* anyway?\n\n` +
                                `👉 Reply *yes* or *commit* to proceed.\n` +
                                `👉 Reply *no* or *cancel* to abort.`,
                                fromChatId
                            );
                            continue;
                        }

                        await sendTelegram(`✅ *Confirmed!* Committing task for *${pending.keyword}* at *${pending.targetTime || pending.startTime || 'specified time'}*...`, fromChatId);
                        await executeBookingTask(pending);
                        continue;
                    } else if (isNo) {
                        pendingTimeConfirmations.delete(fromChatId);
                        await sendTelegram(`🛑 *Cancelled.* Booking task for *${pending.keyword}* was aborted.`, fromChatId);
                        continue;
                    } else if (text.startsWith('!')) {
                        // User issued another command, clear previous pending confirmation
                        pendingTimeConfirmations.delete(fromChatId);
                    } else {
                        if (pending.isTypoConfirmation) {
                            await sendTelegram(
                                `❓ Did you mean *${pending.suggestedTime}*?\n` +
                                `👉 Reply *yes* to commit with *${pending.suggestedTime}*.\n` +
                                `👉 Reply *no* to cancel.`,
                                fromChatId
                            );
                        } else {
                            const reason = pending.isTooEarly ? 'it is too early' : 'it is outside normal college hours';
                            await sendTelegram(
                                `⚠️ *Confirmation Required*\n\n` +
                                `The requested time (*${pending.unusualTime}*) is ${reason}. Normal college hours are *8:00 AM – 6:00 PM*.\n\n` +
                                `Should we commit this task for *${pending.keyword}*?\n` +
                                `👉 Reply *yes* or *commit* to proceed.\n` +
                                `👉 Reply *no* or *cancel* to abort.`,
                                fromChatId
                            );
                        }
                        continue;
                    }
                }

                // ── AI Natural Language Parsing ──────────────────────────────
                if (!text.startsWith('!')) {
                    if (!aiClient) {
                        await sendTelegram(`⚠️ Gemini API Key not configured. AI disabled. Use standard ! commands.`, fromChatId);
                        continue;
                    }
                    try {
                        await sendTelegram(`🤖 Thinking...`, fromChatId);
                        const prompt = `You are an AI assistant for Saveetha University students. The user sent this message: "${msg.text}"
Determine the intent and return ONLY valid JSON (no markdown).
Possible actions:
1. "book": If user wants to book a slot. Extract "keyword" (required), "time" (optional), "date" (optional), "venue" (optional).
2. "timetable": If user wants to see today's timetable/schedule.
3. "attendance": If user wants to check their attendance.
4. "reply": If it's a general question or greeting. Provide a helpful "message".

Example: {"action": "book", "keyword": "math", "time": "10:00 AM"}
Example: {"action": "timetable"}
Example: {"action": "attendance"}
Example: {"action": "reply", "message": "Hello! How can I help?"}`;

                        const result = await aiClient.models.generateContent({
                            model: 'gemini-2.5-flash',
                            contents: prompt,
                        });

                        let aiResponse = result.text.trim();
                        if (aiResponse.startsWith('\`\`\`json')) {
                            aiResponse = aiResponse.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
                        }
                        const aiData = JSON.parse(aiResponse);

                        if (aiData.action === 'reply') {
                            await sendTelegram(`🤖 ${aiData.message}`, fromChatId);
                            continue;
                        } else if (aiData.action === 'timetable') {
                            text = '!timetable';
                        } else if (aiData.action === 'attendance') {
                            text = '!attendance';
                        } else if (aiData.action === 'book') {
                            text = `!book ${aiData.keyword || ''} ${aiData.time ? '@ ' + aiData.time : ''} ${aiData.date ? '~ ' + aiData.date : ''} ${aiData.venue ? '$ ' + aiData.venue : ''}`.trim();
                        } else {
                            await sendTelegram(`🤖 I'm not sure how to handle that action.`, fromChatId);
                            continue;
                        }
                    } catch (e) {
                        console.error('[AI] Error:', e.message);
                        await sendTelegram(`❌ AI Error: Could not process request. Try using ! commands.`, fromChatId);
                        continue;
                    }
                }
                // ── !help ─────────────────────────────────────────────────
                if (text === '!help' || text === '/start') {
                    let helpMsg =
                        `📖 *Saveetha Bot Help*\n\n` +
                        `*Booking Commands:*\n` +
                        `\`!book <keyword>\` — Book immediately\n` +
                        `\`!book <keyword> @ 10:00 AM\` — Target specific time\n` +
                        `\`!book <keyword> $ 5511\` — Target specific room/venue\n` +
                        `\`!book <keyword> ~ 05/22/2026\` — Target specific date\n` +
                        `\`!book <keyword> # 06:00 PM\` — Start scanning at 6 PM IST\n` +
                        `\`!scan <keyword>\` — Scan every 30s until found\n` +
                        `\`!unbook <keyword>\` — Cancel a booked slot\n\n` +
                        `*Timetable & Attendance Commands:*\n` +
                        `\`!timetable\` or \`!tt\` — Get today's schedule & activate reminders\n` +
                        `\`!otp <keyword> [in/out]\` — Manually trigger OTP scan\n` +
                        `\`!attendance\` or \`!att\` — Get your attendance\n` +
                        `\`!bunk\` — Calculate how many classes you can bunk (80% limit)\n` +
                        `\`!workflow\` or \`!requests\` — Check workflow approval status\n\n` +
                        `*System Commands:*\n` +
                        `\`!status\` — Check if bot is alive\n` +
                        `\`!progress\` — View active tasks\n` +
                        `\`!stop <keyword>\` — Stop your specific task\n` +
                        `\`!stop all\` — Stop all your tasks\n`;

                    if (fromChatId === ADMIN_CHAT_ID) {
                        helpMsg += `\n*👑 Admin Commands:*\n` +
                            `\`!listusers\` — Show all users\n` +
                            `\`!allprogress\` — View all active tasks from all users\n` +
                            `\`!cleartasks\` — Wipe all stuck tasks instantly\n` +
                            `\`!stopuser <chatId> [keyword]\` — Stop all/specific tasks for a user\n` +
                            `\`!stopany <keyword>\` — Stop any user's task by keyword\n` +
                            `\`!block <chatId>\` — Block a user\n` +
                            `\`!unblock <chatId>\` — Unblock a user\n` +
                            `\`!broadcast <msg>\` — Message everyone\n`;
                    }
                    if (isSuperAdmin(fromChatId)) {
                        helpMsg += `\n*🛠️ Super Admin Commands:*\n` +
                            `\`!checkotp [class]\` — Instant attendance status check with screenshot\n` +
                            `\`!otp [class] [in/out]\` — Monitor, detect & submit class OTP\n` +
                            `\`!stopbot\` — Permanently stop GitHub Actions bot\n` +
                            `\`!restartbot\` — Restart GitHub Actions bot\n`;
                    }

                    helpMsg += `\n_Tip: Use "all" with !stop to clear the queue._`;
                    await sendTelegram(helpMsg, fromChatId);
                    continue;
                }

                // ── !stopbot & !restartbot ───────────────────────────────
                if (text === '!stopbot') {
                    const superAdminChatId = Object.keys(ACCOUNTS).find(id => ACCOUNTS[id].user === '25013635');
                    if (fromChatId !== '8581009274' && fromChatId !== ADMIN_CHAT_ID && fromChatId !== superAdminChatId) {
                        await sendTelegram(`⛔ Only super admin can use this command.`, fromChatId);
                        continue;
                    }
                    await sendTelegram(`🛑 *Stopping GitHub Actions bot permanently...*\nIt will not restart until manually triggered from GitHub.`, fromChatId);
                    fs.writeFileSync('STOP_BOT', 'stop');
                    try { await getTelegramUpdates(update.update_id + 1); } catch (e) { }
                    process.exit(0);
                }

                if (text === '!restartbot') {
                    const superAdminChatId = Object.keys(ACCOUNTS).find(id => ACCOUNTS[id].user === '25013635');
                    if (fromChatId !== '8581009274' && fromChatId !== ADMIN_CHAT_ID && fromChatId !== superAdminChatId) {
                        await sendTelegram(`⛔ Only super admin can use this command.`, fromChatId);
                        continue;
                    }
                    await sendTelegram(`🔄 *Restarting GitHub Actions bot...*\nPlease wait a few minutes for the new runner to initialize.`, fromChatId);
                    try { fs.unlinkSync('STOP_BOT'); } catch (e) { }
                    try { await getTelegramUpdates(update.update_id + 1); } catch (e) { }
                    process.exit(0);
                }

                // ── !status ──────────────────────────────────────────────
                if (text === '!status') {
                    const count = activeTasks.size;
                    await sendTelegram(`✅ Bot is running and logged in.\n${count > 0 ? `⏳ Currently processing ${count} booking(s).` : '🟢 Ready to book!'}`, fromChatId);
                    continue;
                }

                // ── !progress & !allprogress ──────────────────────────────
                if (text === '!progress' || (text === '!allprogress' && (fromChatId === ADMIN_CHAT_ID || fromChatId === Object.keys(ACCOUNTS).find(id => ACCOUNTS[id].user === '25013635')))) {
                    let filteredTasks = Array.from(activeTasks.entries());
                    if (text === '!progress') {
                        filteredTasks = filteredTasks.filter(([id, task]) => task.fromChatId === fromChatId);
                    }

                    if (filteredTasks.length === 0) {
                        await sendTelegram(`🟢 *No active bookings.*\nBot is idle and ready.`, fromChatId);
                    } else {
                        let statusMsg = `⏳ *Active Bookings (${filteredTasks.length})*\n\n`;
                        filteredTasks.forEach(([id, task]) => {
                            let ownerInfo = '';
                            if (text === '!allprogress') {
                                const ownerName = task.userConfig ? task.userConfig.name : 'Unknown';
                                ownerInfo = `👤 Owner: ${ownerName} (${task.fromChatId})\n`;
                            }
                            statusMsg += `🔹 *${task.keyword}*\n` +
                                ownerInfo +
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
                if (text.toLowerCase().startsWith('!stop ') || text.toLowerCase() === '!stop') {
                    const arg = text.substring(5).trim().toLowerCase();

                    // !stop only affects the sender's OWN tasks now, to prevent admins from accidentally stopping others.
                    let userTasks = Array.from(activeTasks.entries()).filter(([id, task]) => task.fromChatId === fromChatId);

                    if (userTasks.length === 0) {
                        await sendTelegram(`🟢 No active bookings to stop.`, fromChatId);
                        continue;
                    }

                    if (arg === 'all') {
                        let stoppedCount = 0;
                        userTasks.forEach(([id, task]) => {
                            task.stopRequested = true;
                            stoppedCount++;
                        });
                        await sendTelegram(`🛑 *Stopping ${stoppedCount} task(s)...*`, fromChatId);
                        saveTasks();
                    } else if (arg) {
                        let found = false;
                        userTasks.forEach(([id, task]) => {
                            if (task.keyword.toLowerCase().includes(arg)) {
                                task.stopRequested = true;
                                found = true;
                            }
                        });
                        if (found) {
                            await sendTelegram(`🛑 Stop requested for tasks matching: *${arg}*`, fromChatId);
                            saveTasks();
                        }
                        else await sendTelegram(`⚠️ No active task found for: *${arg}*`, fromChatId);
                    } else {
                        // Stop the most recent one for this user
                        const lastId = userTasks[userTasks.length - 1][0];
                        const task = activeTasks.get(lastId);
                        task.stopRequested = true;
                        await sendTelegram(`🛑 Stopping most recent task: *${task.keyword}*`, fromChatId);
                        saveTasks();
                    }
                    continue;
                }

                // 👑 ADMIN COMMANDS
                const superAdminChatIdForAdmin = Object.keys(ACCOUNTS).find(id => ACCOUNTS[id].user === '25013635');
                if (fromChatId === ADMIN_CHAT_ID || fromChatId === '8581009274' || fromChatId === superAdminChatIdForAdmin) {

                    if (text.startsWith('!stopuser ')) {
                        const args = text.substring(10).trim().split(' ');
                        const targetId = args[0];
                        const keywordArg = args.slice(1).join(' ').toLowerCase();

                        if (!targetId) {
                            await sendTelegram(`⚠️ Please provide a user ID. Example: \`!stopuser 123456789 [keyword]\``, fromChatId);
                            continue;
                        }

                        let stoppedCount = 0;
                        activeTasks.forEach((task, id) => {
                            if (task.fromChatId === targetId) {
                                if (!keywordArg || task.keyword.toLowerCase().includes(keywordArg)) {
                                    task.stopRequested = true;
                                    stoppedCount++;
                                }
                            }
                        });

                        if (stoppedCount > 0) {
                            if (keywordArg) {
                                await sendTelegram(`✅ Stopped ${stoppedCount} task(s) matching *${keywordArg}* for user \`${targetId}\`.`, fromChatId);
                            } else {
                                await sendTelegram(`✅ Stopped ${stoppedCount} task(s) for user \`${targetId}\`.`, fromChatId);
                            }
                            saveTasks();
                        } else {
                            if (keywordArg) {
                                await sendTelegram(`⚠️ No active tasks matching *${keywordArg}* found for user \`${targetId}\`.`, fromChatId);
                            } else {
                                await sendTelegram(`⚠️ No active tasks found for user \`${targetId}\`.`, fromChatId);
                            }
                        }
                        continue;
                    }

                    if (text === '!cleartasks') {
                        activeTasks.forEach(task => task.stopRequested = true);
                        activeTasks.clear();
                        taskIdCounter = 0;
                        saveTasks();
                        clearPersistedTasks();
                        await sendTelegram(`🗑️ *All tasks have been instantly cleared* from memory, the local file, and the Gist.\nThe task queue is completely empty.`, fromChatId);
                        continue;
                    }

                    if (text === '!listusers') {
                        let list = `👥 *Authorized Users*\n\n`;
                        for (const [id, config] of Object.entries(ACCOUNTS)) {
                            const status = USER_SESSIONS.has(id) ? '🟢 Online' : '🔴 Offline';
                            const blockStatus = blockedUsers.has(id) ? ' [BLOCKED]' : '';
                            list += `• *${config.name}* (\`${id}\`)${blockStatus}\n  └ User: ${config.user} | ${status}\n\n`;
                        }
                        await sendTelegram(list, ADMIN_CHAT_ID);
                        continue;
                    }

                    if (text.startsWith('!block ')) {
                        const targetId = text.substring(7).trim();
                        if (!targetId || !ACCOUNTS[targetId]) {
                            await sendTelegram(`⚠️ Invalid user ID or user not found.`, fromChatId);
                        } else if (targetId === ADMIN_CHAT_ID) {
                            await sendTelegram(`⚠️ Cannot block the admin.`, fromChatId);
                        } else {
                            blockedUsers.add(targetId);
                            saveBlockedUsers();
                            await sendTelegram(`🚫 User \`${targetId}\` (*${ACCOUNTS[targetId].name}*) has been blocked.`, fromChatId);
                            
                            // Close their active session
                            if (USER_SESSIONS.has(targetId)) {
                                const session = USER_SESSIONS.get(targetId);
                                if (session.persistentPage) await session.persistentPage.close().catch(() => {});
                                if (session.context) await session.context.close().catch(() => {});
                                USER_SESSIONS.delete(targetId);
                            }
                        }
                        continue;
                    }

                    if (text.startsWith('!unblock ')) {
                        const targetId = text.substring(9).trim();
                        if (!targetId) {
                            await sendTelegram(`⚠️ Please provide a user ID.`, fromChatId);
                        } else if (blockedUsers.has(targetId)) {
                            blockedUsers.delete(targetId);
                            saveBlockedUsers();
                            await sendTelegram(`✅ User \`${targetId}\` has been unblocked.`, fromChatId);
                            
                            // Immediately log them in if authorized
                            if (ACCOUNTS[targetId] && !USER_SESSIONS.has(targetId)) {
                                await sendTelegram(`⏳ Spawning session for \`${targetId}\`...`, fromChatId);
                                spawnUserSession(browser, targetId, ACCOUNTS[targetId]).then(success => {
                                    if(success) sendTelegram(`✅ Session ready for \`${targetId}\`.`, fromChatId);
                                    else sendTelegram(`❌ Failed to start session for \`${targetId}\`.`, fromChatId);
                                });
                            }
                        } else {
                            await sendTelegram(`⚠️ User \`${targetId}\` is not blocked.`, fromChatId);
                        }
                        continue;
                    }

                    if (text.startsWith('!adduser ')) {
                        const parts = text.split(' ');
                        if (parts.length < 4) {
                            await sendTelegram('Usage: `!adduser <chat_id> <saveetha_user> <saveetha_pass> [name]`', fromChatId);
                        } else {
                            const targetChatId = parts[1];
                            const targetUser = parts[2];
                            const targetPass = parts[3];
                            const targetName = parts.length > 4 ? parts.slice(4).join(' ') : `User ${targetUser}`;
                            ACCOUNTS[targetChatId] = { user: targetUser, pass: targetPass, name: targetName };
                            await syncAccountsToGist();
                            await sendTelegram(`✅ Added user ${targetUser} (Name: ${targetName}) with Chat ID ${targetChatId} and saved to Gist.`, fromChatId);
                            
                            if (!USER_SESSIONS.has(targetChatId) && !blockedUsers.has(targetChatId)) {
                                await sendTelegram(`⏳ Spawning session for \`${targetChatId}\`...`, fromChatId);
                                spawnUserSession(browser, targetChatId, ACCOUNTS[targetChatId]).then(success => {
                                    if(success) sendTelegram(`✅ Session ready for \`${targetChatId}\`.`, fromChatId);
                                    else sendTelegram(`❌ Failed to start session for \`${targetChatId}\`.`, fromChatId);
                                });
                            }
                        }
                        continue;
                    }

                    if (text.startsWith('!setname ')) {
                        const parts = text.split(' ');
                        if (parts.length < 3) {
                            await sendTelegram('Usage: `!setname <chat_id> <new_name>`', fromChatId);
                        } else {
                            const targetChatId = parts[1];
                            const targetName = parts.slice(2).join(' ');
                            if (ACCOUNTS[targetChatId]) {
                                ACCOUNTS[targetChatId].name = targetName;
                                await syncAccountsToGist();
                                await sendTelegram(`✅ Updated name for Chat ID ${targetChatId} to: ${targetName}`, fromChatId);
                            } else {
                                await sendTelegram(`⚠️ User with Chat ID ${targetChatId} not found.`, fromChatId);
                            }
                        }
                        continue;
                    }

                    if (text.startsWith('!removeuser ')) {
                        const targetChatId = text.substring(12).trim();
                        if (!targetChatId) {
                            await sendTelegram('Usage: `!removeuser <chat_id>`', fromChatId);
                        } else if (ACCOUNTS[targetChatId]) {
                            delete ACCOUNTS[targetChatId];
                            await syncAccountsToGist();
                            await sendTelegram(`✅ Removed user with Chat ID ${targetChatId} and synced to Gist.`, fromChatId);
                        } else {
                            await sendTelegram(`⚠️ Chat ID ${targetChatId} not found.`, fromChatId);
                        }
                        continue;
                    }

                    if (text === '!listusers') {
                        let msgStr = '👥 *Registered Users:*\n\n';
                        for (const [uid, udata] of Object.entries(ACCOUNTS)) {
                            msgStr += `• ID: \`${uid}\` | User: ${udata.user}\n`;
                        }
                        await sendTelegram(msgStr, fromChatId);
                        continue;
                    }
                }
                if (text === '!timetable' || text === '!tt') {
                    const session = await getOrSpawnSession(fromChatId, userConfig);
                    if (!session) continue;
                    await sendTelegram(`⏳ Fetching your timetable, please wait...`, fromChatId);
                    try {
                        const slots = await fetchTimetable(session.context, session.config);
                        const msg = formatTimetable(slots, session.config.name);
                        await sendTelegram(msg, fromChatId);
                        scheduleSlotReminders(fromChatId, session, slots);
                        // SYNC to GIST for the Pod to read silently
                        syncFileToGist('saveetha_timetable.txt', msg);
                    } catch (err) {
                        await sendTelegram(`❌ Failed to fetch timetable: ${err.message}`, fromChatId);
                    }
                    continue;
                }

                if (text.startsWith('!checkotp')) {
                    if (!isSuperAdmin(fromChatId)) {
                        await sendTelegram(`⛔ The OTP attendance feature is restricted to Super Admin only.`, fromChatId);
                        continue;
                    }
                    const session = await getOrSpawnSession(fromChatId, userConfig);
                    if (!session) continue;
                    const kw = text.split(' ').slice(1).join(' ').trim();
                    await sendTelegram(`🔍 Checking attendance status for *${kw || 'current class'}*...`, fromChatId);
                    checkAttendanceStatus(session, kw, fromChatId);
                    continue;
                }

                if (text.startsWith('!otp')) {
                    if (!isSuperAdmin(fromChatId)) {
                        await sendTelegram(`⛔ The OTP attendance feature is restricted to Super Admin only.`, fromChatId);
                        continue;
                    }
                    const session = await getOrSpawnSession(fromChatId, userConfig);
                    if (!session) continue;
                    const parts = text.split(' ').slice(1);
                    const phase = text.includes('out') ? 'end' : 'start';
                    const directOtp = parts.find(p => /^\d{6}$/.test(p)) || null;
                    const kw = parts.filter(p => !['in', 'out'].includes(p.toLowerCase()) && !/^\d{6}$/.test(p)).join(' ').trim();
                    if (directOtp) {
                        await sendTelegram(`🔍 Submitting *${phase === 'start' ? 'IN' : 'OUT'} OTP* \`${directOtp}\` for *${kw || 'current class'}*...`, fromChatId);
                    } else {
                        await sendTelegram(`🔍 Checking & scanning *${phase === 'start' ? 'IN' : 'OUT'} OTP* for *${kw || 'current class'}*...`, fromChatId);
                    }
                    handleAttendanceOtp(session, kw, phase, fromChatId, directOtp);
                    continue;
                }

                if (text.startsWith('!workflow') || text.startsWith('!requests')) {
                    const session = await getOrSpawnSession(fromChatId, userConfig);
                    if (!session) continue;
                    const args = text.split(' ').slice(1).join(' ').trim();
                    await sendTelegram(`⏳ Fetching your workflow requests, please wait...`, fromChatId);
                    try {
                        const msg = await fetchWorkflowRequests(session.context, session.config, args);
                        await sendTelegram(msg, fromChatId);
                    } catch (err) {
                        await sendTelegram(`❌ Failed to fetch workflow requests: ${err.message}`, fromChatId);
                    }
                    continue;
                }

                if (text === '!attendance' || text === '!att') {
                    const session = await getOrSpawnSession(fromChatId, userConfig);
                    if (!session) continue;
                    await sendTelegram(`⏳ Fetching your attendance, please wait...`, fromChatId);
                    try {
                        const data = await fetchAttendance(session.context, session.config);
                        let msg = formatAttendance(data, session.config.name);
                        msg += `\n\n_💡 Tip: Type_ \`!bunk\` _to calculate how many classes you can skip while maintaining 80%!_`;
                        await sendTelegram(msg, fromChatId);
                        // SYNC to GIST for the Pod to read silently
                        syncFileToGist('saveetha_attendance.txt', formatAttendance(data, session.config.name));
                    } catch (err) {
                        await sendTelegram(`❌ Failed to fetch attendance: ${err.message}`, fromChatId);
                    }
                    continue;
                }

                if (text === '!bunk') {
                    const session = await getOrSpawnSession(fromChatId, userConfig);
                    if (!session) continue;
                    await sendTelegram(`⏳ Fetching your subjects...`, fromChatId);
                    try {
                        const data = await fetchAttendance(session.context, session.config);
                        if (!data || data.length === 0) {
                            await sendTelegram(`⚠️ No subjects found.`, fromChatId);
                            continue;
                        }

                        let msg = `🧮 *Select a Subject to Calculate Bunk Stats (80% Limit)*\n\n`;
                        data.forEach((item, i) => {
                            msg += `🔹 ${item.subject.replace(/([_*`\[])/g, '\\$1')}\n`;
                        });
                        msg += `\n_Reply with_ \`!bunk <subject>\` _(e.g., !bunk calculus) to calculate!_`;
                        await sendTelegram(msg, fromChatId);
                    } catch (err) {
                        await sendTelegram(`❌ Error: ${err.message}`, fromChatId);
                    }
                    continue;
                }

                if (text.startsWith('!bunk ')) {
                    const session = await getOrSpawnSession(fromChatId, userConfig);
                    if (!session) continue;

                    const keyword = text.substring(6).trim().toLowerCase();
                    if (!keyword) {
                        await sendTelegram(`❌ Please provide a keyword. Example: \`!bunk calculus\``, fromChatId);
                        continue;
                    }

                    await sendTelegram(`🔍 Searching for subject matching "${keyword}"...`, fromChatId);

                    try {
                        const allSubjects = await fetchAttendance(session.context, session.config);

                        let matchedIndex = -1;
                        // First try to check if the keyword is just an exact number (like old behavior)
                        if (/^\d+$/.test(keyword)) {
                            const idx = parseInt(keyword) - 1;
                            if (idx >= 0 && idx < allSubjects.length) {
                                matchedIndex = idx;
                            }
                        }

                        // Otherwise search by keyword match
                        if (matchedIndex === -1) {
                            matchedIndex = allSubjects.findIndex(s => s.subject.toLowerCase().includes(keyword));
                        }

                        if (matchedIndex === -1) {
                            await sendTelegram(`❌ Could not find any subject matching "${keyword}". Try using a word from the subject title.`, fromChatId);
                            continue;
                        }

                        const matchedSubjectObj = allSubjects[matchedIndex];
                        const matchedSubject = matchedSubjectObj.subject;
                        await sendTelegram(`🧮 Calculating bunk stats for *${matchedSubject}*... Please wait...`, fromChatId);

                        const data = await fetchBunkStatsForSubject(session.context, session.config, matchedSubject, matchedSubjectObj);
                        const msg = formatBunkStats(data, session.config.name);
                        await sendTelegram(msg, fromChatId);
                    } catch (err) {
                        await sendTelegram(`❌ Failed to calculate bunk stats: ${err.message}`, fromChatId);
                    }
                    continue;
                }

                if (text.toLowerCase().startsWith('!adminnotify')) {
                    const superAdminChatId = Object.keys(ACCOUNTS).find(id => ACCOUNTS[id].user === '25013635');
                    if (!superAdminChatId || String(fromChatId) !== String(superAdminChatId)) {
                        await sendTelegram(`❌ You are not authorized to use this command.`, fromChatId);
                        continue;
                    }
                    const param = text.substring(12).trim().toLowerCase();
                    if (param === 'on') {
                        superAdminNotificationsEnabled = true;
                        await sendTelegram(`✅ Super admin notifications turned ON.`, fromChatId);
                    } else if (param === 'off') {
                        superAdminNotificationsEnabled = false;
                        await sendTelegram(`❌ Super admin notifications turned OFF.`, fromChatId);
                    } else {
                        await sendTelegram(`ℹ️ Usage: \`!adminnotify on\` or \`!adminnotify off\`\nCurrent Status: ${superAdminNotificationsEnabled ? 'ON' : 'OFF'}`, fromChatId);
                    }
                    continue;
                }

                // ── !book / !unbook / !scan ──────────────────────────────
                const isUnbook = text.toLowerCase().startsWith('!unbook');
                const isScan = text.toLowerCase().startsWith('!scan');
                if (!text.toLowerCase().startsWith('!book') && !isUnbook && !isScan) continue;

                // Parse command
                let rawParams = text.substring(isUnbook ? 7 : (isScan ? 5 : 5)).trim();
                let keyword = '';
                let targetTime = '';
                let targetVenue = '';
                let targetDate = '';
                let startTime = '';

                // Find the first symbol to separate keyword from modifiers
                const symbols = ['@', '~', '$', '#'];
                let firstSymbolIndex = rawParams.length;
                symbols.forEach(sym => {
                    const idx = rawParams.indexOf(sym);
                    if (idx !== -1 && idx < firstSymbolIndex) firstSymbolIndex = idx;
                });

                keyword = rawParams.substring(0, firstSymbolIndex).trim();

                let modifiers = rawParams.substring(firstSymbolIndex);
                if (modifiers.includes('@')) targetTime = modifiers.split('@')[1].split(/[~$\#]/)[0].trim();
                if (modifiers.includes('~')) targetDate = modifiers.split('~')[1].split(/[@$\#]/)[0].trim();
                if (modifiers.includes('$')) targetVenue = modifiers.split('$')[1].split(/[@~\#]/)[0].trim();
                if (modifiers.includes('#')) startTime = modifiers.split('#')[1].split(/[@~$]/)[0].trim();

                if (!keyword) {
                    await sendTelegram(`⚠️ Please provide a keyword. Example: \`!book CAT\``, fromChatId);
                    continue;
                }

                // 1. Inspect targetTime for typos/misspellings
                if (targetTime) {
                    const inspected = inspectTimeString(targetTime);
                    if (!inspected.isValid) {
                        if (inspected.isTypo && inspected.suggestedTime) {
                            pendingTimeConfirmations.set(fromChatId, {
                                keyword, targetTime: inspected.suggestedTime, targetVenue, targetDate, startTime,
                                isScan, isUnbook, fromChatId, userConfig,
                                isTypoConfirmation: true,
                                originalWrongTime: targetTime,
                                suggestedTime: inspected.suggestedTime,
                                wrongSuffix: inspected.wrongSuffix,
                                suggestedMeridian: inspected.suggestedMeridian
                            });

                            await sendTelegram(
                                `❓ *Did you mean "${inspected.suggestedTime}"?*\n\n` +
                                `You entered: \`${targetTime}\`\n` +
                                `The suffix "*${inspected.wrongSuffix}*" looks misspelled (did you mean *${inspected.suggestedMeridian}*?).\n\n` +
                                `👉 Reply *yes* or *commit* to use *${inspected.suggestedTime}*.\n` +
                                `👉 Reply *no* to cancel, or re-type your command.`,
                                fromChatId
                            );
                            continue;
                        } else {
                            await sendTelegram(
                                `❌ *Invalid Time Format: "${targetTime}"*\n` +
                                `Please specify a valid time like \`10:00 AM\` or \`03:00 PM\`.\n` +
                                `Task was not scheduled.`,
                                fromChatId
                            );
                            continue;
                        }
                    }
                    targetTime = inspected.formatted;
                }

                // 2. Inspect startTime for typos/misspellings
                if (startTime) {
                    const inspected = inspectTimeString(startTime);
                    if (!inspected.isValid) {
                        if (inspected.isTypo && inspected.suggestedTime) {
                            pendingTimeConfirmations.set(fromChatId, {
                                keyword, targetTime, targetVenue, targetDate, startTime: inspected.suggestedTime,
                                isScan, isUnbook, fromChatId, userConfig,
                                isTypoConfirmation: true,
                                originalWrongTime: startTime,
                                suggestedTime: inspected.suggestedTime,
                                wrongSuffix: inspected.wrongSuffix,
                                suggestedMeridian: inspected.suggestedMeridian
                            });

                            await sendTelegram(
                                `❓ *Did you mean "${inspected.suggestedTime}"?*\n\n` +
                                `You entered: \`${startTime}\`\n` +
                                `The suffix "*${inspected.wrongSuffix}*" looks misspelled (did you mean *${inspected.suggestedMeridian}*?).\n\n` +
                                `👉 Reply *yes* or *commit* to use *${inspected.suggestedTime}*.\n` +
                                `👉 Reply *no* to cancel, or re-type your command.`,
                                fromChatId
                            );
                            continue;
                        } else {
                            await sendTelegram(
                                `❌ *Invalid Time Format: "${startTime}"*\n` +
                                `Please specify a valid time like \`10:00 AM\` or \`03:00 PM\`.\n` +
                                `Task was not scheduled.`,
                                fromChatId
                            );
                            continue;
                        }
                    }
                    startTime = inspected.formatted;
                }

                // 3. Check if targetTime or startTime is outside normal college hours (8:00 AM - 6:00 PM)
                const targetCheck = isOutsideNormalHours(targetTime);
                const startCheck = isOutsideNormalHours(startTime);
                const unusual = targetCheck || startCheck;

                if (unusual) {
                    pendingTimeConfirmations.set(fromChatId, {
                        keyword, targetTime, targetVenue, targetDate, startTime,
                        isScan, isUnbook, fromChatId, userConfig,
                        unusualTime: unusual.timeStr,
                        isTooEarly: unusual.isTooEarly,
                        isTypoConfirmation: false
                    });

                    const actionName = isUnbook ? 'unbooking' : (isScan ? 'scan' : 'booking');
                    const reason = unusual.isTooEarly ? 'too early' : 'outside normal college hours (after 6:00 PM)';
                    const warningMsg =
                        `⚠️ *Unusual Time Warning: ${unusual.timeStr}*\n\n` +
                        `The specified time is *${reason}* (normal college hours are *8:00 AM – 6:00 PM*).\n\n` +
                        `Should we commit this ${actionName} task for *${keyword}* anyway?\n\n` +
                        `👉 Reply *yes* or *commit* to proceed.\n` +
                        `👉 Reply *no* or *cancel* to abort.`;

                    await sendTelegram(warningMsg, fromChatId);
                    continue;
                }

                await executeBookingTask({
                    keyword, targetTime, targetVenue, targetDate, startTime,
                    isScan, isUnbook, fromChatId, userConfig
                });
            }
        } catch (pollErr) {
            console.error('[Bot] Poll error:', pollErr.message);
        }

        // Small pause between polls (getUpdates uses long-polling of 30s already)
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    async function executeBookingTask(params) {
        const { keyword, targetTime, targetVenue, targetDate, startTime, isScan, isUnbook, fromChatId, userConfig } = params;
        const taskId = ++taskIdCounter;
        const task = {
            keyword, targetTime, targetVenue, targetDate, startTime,
            phase: 'Initializing',
            stopRequested: false,
            page: null,
            isScan, isUnbook, fromChatId, userConfig
        };
        activeTasks.set(taskId, task);
        saveTasks();

        console.log(`[Bot] New Task [${taskId}]: ${isUnbook ? '!unbook' : (isScan ? '!scan' : '!book')} "${keyword}"${targetTime ? ` @ ${targetTime}` : ''}${targetDate ? ` ~ ${targetDate}` : ''}${targetVenue ? ` $ ${targetVenue}` : ''}${startTime ? ` # ${startTime}` : ''}`);

        const superAdminChatId = Object.keys(ACCOUNTS).find(id => ACCOUNTS[id].user === '25013635');
        if (superAdminNotificationsEnabled && superAdminChatId && String(fromChatId) !== String(superAdminChatId)) {
            const userName = (ACCOUNTS[fromChatId] && ACCOUNTS[fromChatId].name) ? ACCOUNTS[fromChatId].name : fromChatId;
            sendTelegram(`🔔 *Scan Started*\nUser: ${userName}\nTask: ${isScan ? '!scan' : (isUnbook ? '!unbook' : '!book')} ${keyword}${targetTime ? ` @ ${targetTime}` : ''}`, superAdminChatId);
        }

        startTaskLoop(taskId, task);
    }

    async function startTaskLoop(taskId, task) {
        const { keyword, targetTime, targetVenue, targetDate, startTime, isScan, isUnbook, fromChatId, userConfig } = task;
        let taskPage = null;
        try {
            if (startTime && !task.timerFinished) {
                const delayMs = getDelayMsUntil(startTime);
                if (delayMs > 0) {
                    const delayMins = Math.round(delayMs / 60000);
                    await sendTelegram(`⏱️ *Timer Active [${keyword}]*\nWaiting ${delayMins} min(s) until ${startTime}.\n_You can still start other bookings!_`, fromChatId);
                    task.phase = `Waiting until ${startTime}`;
                    saveTasks();
                    const endTime = Date.now() + delayMs;
                    while (Date.now() < endTime) {
                        if (task.stopRequested) break;
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                    task.timerFinished = true;
                    saveTasks();
                }
            }

            if (task.stopRequested) {
                await sendTelegram(`🛑 Task *${keyword}* was cancelled.`, fromChatId);
                return;
            }

            // Get user's pre-authenticated session
            let session = USER_SESSIONS.get(fromChatId);
            if (!session) {
                await sendTelegram(`⏳ Your session was not found (bot may have restarted). Attempting to log you in now, please wait...`, fromChatId);
                const success = await spawnUserSession(browser, fromChatId, userConfig);
                if (!success) {
                    await sendTelegram(`❌ Failed to initialize session. The portal might be down. Please try again later.`, fromChatId);
                    return;
                }
                session = USER_SESSIONS.get(fromChatId);
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

            if (isScan) {
                let scanCount = 1;
                while (!task.stopRequested) {
                    task.phase = `Scanning (Check #${scanCount})`;
                    // Removed saveTasks() here to avoid GitHub API 403 secondary rate limits.
                    if (scanCount === 1) {
                        await sendTelegram(`🔎 *Scanning Mode Active* for *${keyword}*${targetTime ? ` at *${targetTime}*` : ''}${targetDate ? ` on *${targetDate}*` : ''}${targetVenue ? ` in venue *${targetVenue}*` : ''}\nChecking every 5 seconds... Use \`!stop\` to cancel.`, fromChatId);
                    }

                    try {
                        const success = await runBookingOnPage(taskPage, keyword, targetTime, targetVenue, targetDate, true, fromChatId);
                        if (success) {
                            console.log(`[Bot] Scan #${scanCount}: Slot found and booked for "${keyword}"`);
                            break;
                        }
                        if (scanCount === 1) {
                            console.log(`[Bot] Scan #${scanCount}: Slot not found for "${keyword}", reporting to user...`);
                            // On first fail, we send a notification so the user knows it's not there yet
                            await runBookingOnPage(taskPage, keyword, targetTime, targetVenue, targetDate, false, fromChatId);
                        } else {
                            console.log(`[Bot] Scan #${scanCount}: Slot not found for "${keyword}", retrying in 5s...`);
                        }
                    } catch (scanErr) {
                        console.error(`[Bot] Scan #${scanCount} error for "${keyword}":`, scanErr.message);
                        if (scanCount === 1) {
                            await sendTelegram(`❌ Error during initial scan: ${scanErr.message}`, fromChatId);
                        }
                    }

                    scanCount++;
                    // Wait 5 seconds before next scan (check stopRequested every 1s)
                    for (let i = 0; i < 5; i++) {
                        if (task.stopRequested) break;
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
            } else if (isUnbook) {
                task.phase = 'Cancelling slot';
                saveTasks();
                await sendTelegram(`⏳ Processing Cancellation for *${keyword}*...`, fromChatId);
                await runUnbookingOnPage(taskPage, keyword, targetTime, fromChatId);
            } else {
                task.phase = 'Booking on portal';
                saveTasks();
                await sendTelegram(`🚀 *Booking started!* (${isUsingPersistent ? 'Hot Tab' : 'New Tab'})\n🎯 Slot: *${keyword}*${targetTime ? ` at *${targetTime}*` : ''}${targetDate ? ` on *${targetDate}*` : ''}${targetVenue ? ` in venue *${targetVenue}*` : ''}\nPlease wait...`, fromChatId);
                await runBookingOnPage(taskPage, keyword, targetTime, targetVenue, targetDate, false, fromChatId);
            }
        } catch (err) {
            console.error(`[Bot] Task ${taskId} Error:`, err.message);
            await sendTelegram(`❌ Error [${keyword}]: ${err.message}`, fromChatId);
        } finally {
            const session = USER_SESSIONS.get(fromChatId);
            if (taskPage) {
                if (session && taskPage === session.persistentPage) {
                    session.isBusy = false;
                    await taskPage.goto('https://learner.saveetha.in/academicevents/event-booking/').catch(() => { });
                } else {
                    await taskPage.close().catch(() => { });
                }
            }
            removeTask(taskId);
        }
    }
}

main().catch(async (err) => {
    console.error('[Bot] Fatal error:', err);
    await sendTelegram(`❌ *Bot crashed:* ${err.message}`).catch(() => { });
    process.exit(1);
});