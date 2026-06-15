const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
        console.log('[Bot] Logging in...');
        await page.goto('https://learner.saveetha.in/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
        
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
                await page.waitForSelector(sel, { timeout: 5000, state: 'visible' });
                userInput = page.locator(sel).first();
                break;
            } catch (_) { }
        }

        if (!userInput) throw new Error('Could not find username input on login page.');
        console.log('Successfully found user input!');
    } catch (e) {
        console.error('Error:', e.message);
    } finally {
        await browser.close();
    }
})();
