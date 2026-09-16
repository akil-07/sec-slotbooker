const fs = require('fs');
const path = require('path');

const text = '!adduser 123456789 testuser testpass';
const isAdmin = true;
const targetChatId = '123456789';
const chatId = '123456789';

if (text.toLowerCase().startsWith('!adduser')) {
    if (!isAdmin) {
        console.log('⛔ Admin only command.');
        process.exit();
    }
    const parts = text.split(' ');
    if (parts.length < 4) {
        console.log('Usage: `!adduser <chat_id> <saveetha_user> <saveetha_pass>`');
        process.exit();
    }
    const targetChatId = parts[1];
    const targetUser = parts[2];
    const targetPass = parts[3];
    
    console.log(`✅ Added user ${targetUser} with Chat ID ${targetChatId}. Fetching their schedule now...`);
    // Trigger fetch for this new user
    console.log('Would run: runDailyInitForUser()');
}
