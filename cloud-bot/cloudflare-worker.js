/**
 * Saveetha Booking Bot — Cloudflare Worker
 * ─────────────────────────────────────────
 * Receives Telegram webhook messages and triggers GitHub Actions.
 *
 * Environment Variables to set in Cloudflare Dashboard:
 *   TELEGRAM_BOT_TOKEN  — from BotFather
 *   GITHUB_TOKEN        — GitHub Personal Access Token (repo + workflow scope)
 *   GITHUB_REPO         — e.g. "yourusername/saveetha-bot"
 *   ALLOWED_CHAT_ID     — your Telegram chat ID (for security, optional)
 */

export default {
    async fetch(request, env) {
        // Only accept POST from Telegram
        if (request.method !== 'POST') {
            return new Response('Saveetha Bot is alive! ✅', { status: 200 });
        }

        let body;
        try {
            body = await request.json();
        } catch {
            return new Response('Bad Request', { status: 400 });
        }

        const message = body?.message || body?.edited_message;
        if (!message) return new Response('OK', { status: 200 });

        const text = (message.text || '').trim();
        const chatId = String(message.chat.id);
        const username = message.from?.username || message.from?.first_name || 'unknown';

        console.log(`[Worker] Message from ${username} (${chatId}): ${text}`);

        // ── Security: Only allow your own chat ID ──────────────────────────────
        if (env.ALLOWED_CHAT_ID && chatId !== env.ALLOWED_CHAT_ID) {
            console.log(`[Worker] Blocked unauthorized user: ${chatId}`);
            return new Response('OK', { status: 200 });
        }

        // ── Command: !book <keyword> ───────────────────────────────────────────
        if (text.toLowerCase().startsWith('!book')) {
            const keyword = text.substring(5).trim();

            if (!keyword) {
                await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId,
                    '⚠️ Please provide a keyword.\n\nExample:\n`!book CAT exam`\n`!book internal`'
                );
                return new Response('OK', { status: 200 });
            }

            await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId,
                `⏳ Received! Starting GitHub Actions for:\n*${keyword}*\n\nYou'll get a message when done.`
            );

            // Trigger GitHub Actions workflow_dispatch
            const ghRes = await fetch(
                `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/book.yml/dispatches`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `token ${env.GITHUB_TOKEN}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/vnd.github.v3+json',
                        'User-Agent': 'Saveetha-Bot'
                    },
                    body: JSON.stringify({
                        ref: 'main',
                        inputs: {
                            keyword: keyword,
                            chat_id: chatId
                        }
                    })
                }
            );

            if (!ghRes.ok) {
                const err = await ghRes.text();
                console.error('[Worker] GitHub API error:', err);
                await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId,
                    '❌ Failed to start booking bot. GitHub API error.\nPlease check your GITHUB_TOKEN and GITHUB_REPO settings.'
                );
            } else {
                console.log('[Worker] GitHub Actions triggered successfully!');
            }

        // ── Command: !status ──────────────────────────────────────────────────
        } else if (text.toLowerCase() === '!status') {
            await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId,
                '✅ *Saveetha Booking Bot is Online!*\n\n' +
                '*Available Commands:*\n' +
                '`!book <keyword>` — Start booking a slot\n' +
                '`!status` — Check if bot is alive\n' +
                '`!help` — Show this help\n\n' +
                '_Example: !book CAT internal exam_'
            );

        // ── Command: !help ────────────────────────────────────────────────────
        } else if (text.toLowerCase() === '!help') {
            await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId,
                '📖 *Saveetha Bot Help*\n\n' +
                '*How to use:*\n' +
                '1. Send `!book <keyword>` to start booking\n' +
                '2. The bot will scan Saveetha portal every 5 seconds\n' +
                '3. You\'ll get a Telegram message when booked!\n\n' +
                '*Commands:*\n' +
                '`!book <keyword>` — Book a slot (e.g. `!book CAT`)\n' +
                '`!status` — Check bot status\n\n' +
                '*Note:* One booking job runs at a time. Max 120 scans (~10 minutes).'
            );
        }

        return new Response('OK', { status: 200 });
    }
};

// ── Telegram Helper ────────────────────────────────────────────────────────────
async function sendTelegram(token, chatId, text) {
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
        });
        const data = await res.json();
        if (!data.ok) console.error('[Telegram]', data.description);
    } catch (e) {
        console.error('[Telegram] Error:', e.message);
    }
}
