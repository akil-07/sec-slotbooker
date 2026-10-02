// =============================================
//  MyCamu Auto-Select — Content Script
//  Runs on: www.mycamu.co.in
// =============================================

(function () {
  'use strict';

  let settings = {
    autoBook: false,
    keywordFilter: '',
    intervalMinutes: 5,
  };

  let intervalId = null;

  // ─── Send status to popup ───────────────────────────────────────────────────
  function postStatus(type, data) {
    chrome.runtime.sendMessage({ type, ...data }).catch(() => {});
  }

  // ─── In-page toast ─────────────────────────────────────────────────────────
  function showToast(message, color = '#22c55e') {
    const existing = document.getElementById('mycamu-booker-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'mycamu-booker-toast';
    toast.style.cssText = `
      position: fixed; top: 20px; right: 20px;
      background: ${color}; color: #fff;
      padding: 14px 22px; border-radius: 12px;
      font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 600;
      z-index: 999999; box-shadow: 0 8px 32px rgba(0,0,0,0.35);
      transition: all 0.3s ease; max-width: 340px; line-height: 1.4;
    `;
    toast.textContent = `🎓 ${message}`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 6000);
  }

  // ─── Main Auto-Clicker Logic ──────────────────────────────────────────────
  function scanForSubject() {
    if (!settings.autoBook || !settings.keywordFilter) {
      stopScanning();
      return;
    }

    const keyword = settings.keywordFilter.trim().toLowerCase();
    
    // Find elements containing the keyword (case-insensitive via xpath translate)
    const xpath = "//*[text()[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '" + keyword + "')]]";
    const allTextElements = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
    );

    let found = false;
    
    for (let i = 0; i < allTextElements.snapshotLength; i++) {
        const el = allTextElements.snapshotItem(i);
        
        // Only consider visible elements
        if (el.offsetWidth > 0 && el.offsetHeight > 0) {
            
            // Traverse up to find a container and look for a button
            let parent = el.parentElement;
            let depth = 0;
            let clicked = false;
            
            while (parent && depth < 6 && !clicked) {
                const buttons = parent.querySelectorAll('button');
                for (let b of buttons) {
                     // Click "Select" or "Apply Filter"
                     if (b.innerText.toLowerCase().includes('select') || b.innerText.toLowerCase().includes('apply') || b.querySelector('svg') || b.querySelector('i')) {
                         b.click();
                         console.log(`[MyCamu Auto] Clicked button for "${keyword}"`);
                         clicked = true;
                         found = true;
                         
                         showToast(`✅ Selected: ${keyword}`);
                         postStatus('BOOKED', { event: `MyCamu: ${keyword}`, timestamp: new Date().toISOString(), status: 'Selected' });
                         
                         // Stop scanning after click
                         stopScanning();
                         
                         // Turn off auto-book in storage so it doesn't loop forever
                         chrome.storage.local.set({ autoBook: false });
                         break;
                     }
                }
                if (clicked) break;
                parent = parent.parentElement;
                depth++;
            }
            if (found) break;
        }
    }
    
    if (!found) {
        postStatus('STATUS_UPDATE', { message: `Scanning MyCamu for: ${keyword}...`, scanning: true });
    }
  }

  // ─── Start/Stop Scanning ──────────────────────────────────────────────────
  function startScanning() {
    if (intervalId) clearInterval(intervalId);
    if (!settings.autoBook) return;

    console.log('[MyCamu Auto] Started scanning');
    showToast(`Scanning MyCamu for: ${settings.keywordFilter}...`, '#007bff');
    
    // Determine interval (if set to "5s" use 5000ms, else use minutes)
    let ms = 5000;
    if (settings.intervalMinutes && settings.intervalMinutes !== '5s') {
       ms = parseInt(settings.intervalMinutes) * 60 * 1000;
       if (isNaN(ms)) ms = 5000;
    }

    scanForSubject(); // run once immediately
    intervalId = setInterval(scanForSubject, ms);
  }

  function stopScanning() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
      console.log('[MyCamu Auto] Stopped scanning');
    }
  }

  // ─── Listen for messages from popup / background ──────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SCAN_NOW') {
      settings = { ...settings, ...(msg.settings || {}) };
      if (location.href.includes('enrolement')) {
        scanForSubject(); // Force a scan
      }
      sendResponse({ ok: true });
    }
    return true;
  });

  // ─── Listen for storage changes (when popup toggles Auto-Book) ──────────────
  chrome.storage.onChanged.addListener((changes) => {
    let changed = false;
    if (changes.autoBook !== undefined) {
      settings.autoBook = changes.autoBook.newValue;
      changed = true;
    }
    if (changes.keywordFilter !== undefined) {
      settings.keywordFilter = changes.keywordFilter.newValue;
      changed = true;
    }
    if (changes.intervalMinutes !== undefined) {
      settings.intervalMinutes = changes.intervalMinutes.newValue;
      changed = true;
    }

    if (changed) {
      if (settings.autoBook && location.href.includes('enrolement')) {
        startScanning();
      } else {
        stopScanning();
      }
    }
  });

  // ─── URL Change Observer (for single-page app) ────────────────────────────
  let lastUrl = location.href; 
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      if (url.includes('enrolement')) {
         if (settings.autoBook) startScanning();
      } else {
         stopScanning();
      }
    }
  }).observe(document, {subtree: true, childList: true});

  // ─── Init on page load ────────────────────────────────────────────────────────
  async function init() {
    const stored = await chrome.storage.local.get([
      'autoBook', 'keywordFilter', 'intervalMinutes'
    ]);
    settings = {
      autoBook:        stored.autoBook        ?? false,
      keywordFilter:   stored.keywordFilter   ?? '',
      intervalMinutes: stored.intervalMinutes ?? 5,
    };

    console.log('[MyCamu Auto] Initialized. Settings:', settings);
    
    if (settings.autoBook && location.href.includes('enrolement')) {
      startScanning();
    }
  }

  setTimeout(init, 1500);

})();
