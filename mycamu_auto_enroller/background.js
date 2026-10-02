chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type === 'REAL_CLICK' && sender.tab) {
        const tabId = sender.tab.id;
        
        chrome.debugger.attach({ tabId }, '1.3', async () => {
            if (chrome.runtime.lastError) {
                // If it's already attached, that's fine, it means a previous click is still processing
                return; 
            }
            
            const sendCommand = (method, params) => new Promise(resolve => {
                chrome.debugger.sendCommand({ tabId }, method, params, resolve);
            });
            
            for (const pt of msg.points) {
                // Move mouse
                await sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
                // Press down
                await sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
                
                // Wait 50ms to simulate a real human holding down the mouse button briefly
                await new Promise(r => setTimeout(r, 50));
                
                // Release
                await sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
                
                // Wait 100ms between each click to let the browser process it
                await new Promise(r => setTimeout(r, 100));
            }
            
            chrome.debugger.detach({ tabId });
        });
    }
});
