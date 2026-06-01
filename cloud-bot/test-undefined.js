const https = require('https');
const gistId = '7e24d6ae5e76667b8052c5dade43f959';

const req = https.request({
    hostname: 'api.github.com',
    path: `/gists/${gistId}`,
    method: 'GET',
    headers: {
        'Authorization': `Bearer undefined`,
        'User-Agent': 'saveetha-bot'
    }
}, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        console.log(`Status: ${res.statusCode}`);
        console.log(`Body: ${data}`);
    });
});
req.on('error', console.error);
req.end();
