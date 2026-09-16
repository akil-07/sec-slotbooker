async function test() {
    const url = 'https://wild-sun-525d.akilsudhagar7.workers.dev/gemini/v1beta/models/gemini-2.0-flash-lite:generateContent';
    const payload = {
        contents: [{ role: 'user', parts: [{ text: 'Respond with a JSON object: {"status":"ok"}' }] }]
    };
    
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.text();
        console.log("Status:", res.status);
        console.log("Data:", data);
    } catch (e) {
        console.error(e);
    }
}
test();
