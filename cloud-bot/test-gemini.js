require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

async function test() {
    try {
        console.log("Key:", process.env.GEMINI_API_KEY ? "Loaded" : "Missing");
        const aiClient = new GoogleGenAI({ 
            apiKey: process.env.GEMINI_API_KEY,
            baseUrl: 'https://wild-sun-525d.akilsudhagar7.workers.dev/gemini'
        });
        const prompt = `Return a JSON object: {"action": "reply", "message": "hello"}`;
        
        console.log("Generating...");
        const result = await aiClient.models.generateContent({
            model: 'gemini-2.0-flash-lite',
            contents: prompt,
        });
        
        console.log("Result:", result.text);
    } catch (e) {
        console.error("Error:", e.message);
    }
}
test();
