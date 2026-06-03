const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await page.goto('https://learner.saveetha.in/login', { waitUntil: 'domcontentloaded' });
        await page.locator('input[name="uid"]').fill('25013635');
        await page.locator('input[name="password"]').fill('tmfa2496');
        await page.locator('button[type="submit"]').click();
        await page.waitForTimeout(4000);

        // Go to disciplinary action request
        await page.goto('https://learner.saveetha.in/academics/workflow-requests/reward-redeems/184/', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        // Click Approval Flow
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
        
        console.log("Tab clicked:", clicked);
        await page.waitForTimeout(3000); // wait for load
        
        const html = await page.evaluate(() => document.body.innerHTML);
        fs.writeFileSync('disc_approval_flow.html', html);
        
        const tableHtml = await page.evaluate(() => {
            const t = document.querySelector('table');
            return t ? t.outerHTML : 'No table found';
        });
        console.log("Table HTML:", tableHtml);
        
    } catch (e) {
        console.error(e);
    } finally {
        await browser.close();
    }
})();
