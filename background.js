// =============================================
//  Saveetha Exam Auto-Booker — Background Service Worker
// =============================================

const BOOKING_URL = 'https://learner.saveetha.in/academicevents/event-booking/';
const ALARM_NAME = 'saveetha-booker-alarm';

// ─── Install / Activate ────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  // Set default settings
  const existing = await chrome.storage.local.get(['autoBook', 'keywordFilter', 'timeFilter', 'intervalMinutes', 'bookingLog']);
  await chrome.storage.local.set({
    autoBook: existing.autoBook ?? false,
    keywordFilter: existing.keywordFilter ?? '',
    timeFilter: existing.timeFilter ?? '',
    intervalMinutes: existing.intervalMinutes ?? 5,
    bookingLog: existing.bookingLog ?? [],
  });
  console.log('[Saveetha Booker] Extension installed, defaults set.');
});

// ─── Setup / update alarm based on interval setting ────────────────────────
async function setupAlarm() {
  const { intervalMinutes, autoBook } = await chrome.storage.local.get(['intervalMinutes', 'autoBook']);

  await chrome.alarms.clearAll();

  if (autoBook) {
    if (intervalMinutes === '5s') {
      // 5s scan mode: set 1min fallback alarm, rely on content script for fast reload
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
      console.log(`[Saveetha Booker] Alarm set: 1 min fallback for 5s fast mode`);
      // Trigger an immediate scan to start the fast reload loop
      openOrRefreshBookingTab();
    } else {
      chrome.alarms.create(ALARM_NAME, {
        periodInMinutes: parseInt(intervalMinutes, 10) || 5,
      });
      console.log(`[Saveetha Booker] Alarm set: every ${intervalMinutes} min`);
    }
  }
}

// ─── On alarm: open/refresh the booking tab and trigger scan ───────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  const { autoBook } = await chrome.storage.local.get('autoBook');
  if (!autoBook) {
    await chrome.alarms.clearAll();
    return;
  }

  console.log('[Saveetha Booker] Alarm fired — scanning booking page...');
  await openOrRefreshBookingTab();
});

async function openOrRefreshBookingTab() {
  const { autoBook, keywordFilter, timeFilter, intervalMinutes } = await chrome.storage.local.get([
    'autoBook', 'keywordFilter', 'timeFilter', 'intervalMinutes'
  ]);

  const settings = { autoBook, keywordFilter, timeFilter, intervalMinutes };

  // Find existing booking tab
  const tabs = await chrome.tabs.query({ url: BOOKING_URL + '*' });

  if (tabs.length > 0) {
    const tab = tabs[0];
    // Refresh the tab
    await chrome.tabs.reload(tab.id);
    // Wait for load then inject scan
    setTimeout(async () => {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_NOW', settings });
      } catch (e) {
        // Content script may not be ready yet, retry
        setTimeout(async () => {
          try {
            await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_NOW', settings });
          } catch (e2) {
            console.warn('[Saveetha Booker] Could not reach content script:', e2.message);
          }
        }, 3000);
      }
    }, 4000);
  } else {
    // Open a new tab silently
    const tab = await chrome.tabs.create({ url: BOOKING_URL, active: false });
    setTimeout(async () => {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_NOW', settings });
      } catch (e) {
        console.warn('[Saveetha Booker] Tab opened but content script not ready:', e.message);
      }
    }, 5000);
  }
}

// ─── Messages from content script or popup ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === 'BOOKED') {
    handleBookingSuccess(msg.event, msg.timestamp, msg.status);
    sendResponse({ ok: true });
  }

  if (msg.type === 'SETUP_ALARM') {
    setupAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'OPEN_BOOKING_PAGE') {
    openOrRefreshBookingTab().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'CLEAR_ALARM') {
    chrome.alarms.clearAll().then(() => sendResponse({ ok: true }));
    return true;
  }

  return true;
});

// ─── Handle a successful booking ───────────────────────────────────────────
async function handleBookingSuccess(eventName, timestamp, statusStr) {
  const displayStatus = statusStr || 'Booked';

  // Show Chrome notification
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `✅ Exam Slot ${displayStatus}!`,
    message: eventName || `An exam slot was successfully ${displayStatus.toLowerCase()}. Auto-book disabled.`,
    priority: 2,
  });

  // Log to storage
  const { bookingLog } = await chrome.storage.local.get('bookingLog');
  const log = bookingLog || [];
  log.unshift({
    event: eventName,
    timestamp: timestamp || new Date().toISOString(),
    status: displayStatus,
  });

  // Keep only last 50 entries
  if (log.length > 50) log.splice(50);
  
  // Disable autoBook and save log
  await chrome.storage.local.set({ 
    bookingLog: log,
    autoBook: false
  });

  // Clear alarms so it stops scanning
  await chrome.alarms.clearAll();
  console.log('[Saveetha Booker] Booking successful. Auto-book disabled and alarms cleared.');
}
