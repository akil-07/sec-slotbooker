const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto('https://learner.saveetha.in/login');
    console.log('Title:', await page.title());
    const user = await page.$('input[name="username"]');
    console.log('User input found via input[name=username]:', !!user);
    const id_user = await page.$('#id_username');
    console.log('User input found via #id_username:', !!id_user);
    const uid_user = await page.$('input[name="uid"]');
    console.log('User input found via input[name=uid]:', !!uid_user);
    await browser.close();
})();
