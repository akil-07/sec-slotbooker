const https = require('https');
const token = process.env.GIST_TOKEN;
const gistId = '7e24d6ae5e76667b8052c5dade43f959';

const body = JSON.stringify({
    files: {
        'saveetha_bot_tasks.json': {
            content: '{"test": 123}'
        }
    }
});

const req = https.request({
    hostname: 'api.github.com',
    path: `/gists/${gistId}`,
    method: 'PATCH',
    headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'saveetha-bot',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/vnd.github.v3+json'
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
req.write(body);
req.end();
