require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

async function test() {
    try {
        console.log("Key:", process.env.GEMINI_API_KEY ? "Loaded" : "Missing");
        const aiClient = new GoogleGenAI({ 
            apiKey: process.env.GEMINI_API_KEY
        });
        const fs = require('fs');
        const imgBuffer = fs.readFileSync('schedule_page.png');
        console.log("Testing multimodal vision with schedule_page.png...");
        const result = await aiClient.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            inlineData: {
                                mimeType: 'image/png',
                                data: imgBuffer.toString('base64')
                            }
                        },
                        {
                            text: 'What is shown in this image? Summarize briefly in 1-2 sentences.'
                        }
                    ]
                }
            ]
        });
        console.log("Vision result:", result.text);
    } catch (e) {
        console.error("Error:", e.message);
    }
}
test();
