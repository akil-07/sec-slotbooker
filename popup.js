// =============================================
//  Saveetha Exam Auto-Booker — Popup Logic
// =============================================

// ─── DOM refs ──────────────────────────────────────────────────────────────
const autoBookCheck  = document.getElementById('autoBookCheck');
const keywordInput   = document.getElementById('keywordInput');
const timeInput      = document.getElementById('timeInput');
const purposeInput   = document.getElementById('purposeInput');
const intervalSelect = document.getElementById('intervalSelect');
const scanNowBtn     = document.getElementById('scanNowBtn');
const openPageBtn    = document.getElementById('openPageBtn');
const statusDot      = document.getElementById('statusDot');
const statusLabel    = document.getElementById('statusLabel');
const statusIcon     = document.getElementById('statusIcon');
const statusText     = document.getElementById('statusText');
const statusTime     = document.getElementById('statusTime');
const statusCard     = document.getElementById('statusCard');
const logList        = document.getElementById('logList');
const clearLogBtn    = document.getElementById('clearLogBtn');

// ─── Load settings from storage ────────────────────────────────────────────
async function loadSettings() {
  const data = await chrome.storage.local.get([
    'autoBook', 'keywordFilter', 'timeFilter', 'purposeText', 'intervalMinutes', 'bookingLog'
  ]);

  autoBookCheck.checked        = data.autoBook ?? false;
  keywordInput.value           = data.keywordFilter ?? '';
  timeInput.value              = data.timeFilter ?? '';
  purposeInput.value           = data.purposeText ?? 'To attend the academic event as part of my curriculum.';
  intervalSelect.value         = String(data.intervalMinutes ?? 5);

  updateStatusBadge(data.autoBook);
  renderLog(data.bookingLog || []);
}

// ─── Save settings ─────────────────────────────────────────────────────────
async function saveSettings() {
  const settings = {
    autoBook:        autoBookCheck.checked,
    keywordFilter:   keywordInput.value.trim(),
    timeFilter:      timeInput.value.trim(),
    purposeText:     purposeInput.value.trim() || 'To attend the academic event as part of my curriculum.',
    intervalMinutes: intervalSelect.value,
  };
  await chrome.storage.local.set(settings);
  return settings;
}

// ─── Status badge ───────────────────────────────────────────────────────────
function updateStatusBadge(autoBook) {
  if (autoBook) {
    statusDot.className   = 'status-dot active';
    statusLabel.textContent = 'Active';
  } else {
    statusDot.className   = 'status-dot';
    statusLabel.textContent = 'Idle';
  }
}

// ─── Status card ────────────────────────────────────────────────────────────
function setStatus(icon, text, type = 'info') {
  statusIcon.textContent = icon;
  statusText.textContent = text;
  statusTime.textContent = formatTime(new Date());

  statusCard.className = 'status-card';
  if (type === 'scanning') {
    statusCard.classList.add('scanning');
    statusIcon.textContent = '🔄';
  }
}

// ─── Render booking log ─────────────────────────────────────────────────────
function renderLog(log) {
  if (!log || log.length === 0) {
    logList.innerHTML = '<div class="log-empty">No bookings yet</div>';
    return;
  }

  logList.innerHTML = log.slice(0, 20).map(entry => {
    const dotClass = entry.status === 'Booked' ? 'success' :
                     entry.status === 'Error'  ? 'error'   : 'info';
    return `
      <div class="log-item">
        <div class="log-dot ${dotClass}"></div>
        <div class="log-content">
          <div class="log-event">${escapeHtml(entry.event || 'Unknown event')}</div>
          <div class="log-meta">${entry.status} · ${formatTime(new Date(entry.timestamp))}</div>
        </div>
      </div>
    `;
  }).join('');
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function formatTime(date) {
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Trigger scan on active booking tab ─────────────────────────────────────
async function triggerScanOnBookingTab(settings) {
  const BOOKING_URL = 'https://learner.saveetha.in/academicevents/event-booking/';
  const tabs = await chrome.tabs.query({ url: BOOKING_URL + '*' });

  if (tabs.length > 0) {
    try {
      await chrome.tabs.sendMessage(tabs[0].id, { type: 'SCAN_NOW', settings });
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

// ─── Event: Auto-Book toggle ─────────────────────────────────────────────────
autoBookCheck.addEventListener('change', async () => {
  const settings = await saveSettings();
  updateStatusBadge(settings.autoBook);

  if (settings.autoBook) {
    // Tell background to set up the alarm
    chrome.runtime.sendMessage({ type: 'SETUP_ALARM' });
    setStatus('✅', 'Auto-Book enabled — monitoring started');
  } else {
    // Clear the alarm
    chrome.runtime.sendMessage({ type: 'CLEAR_ALARM' });
    setStatus('⏸️', 'Auto-Book disabled');
  }
});

// ─── Event: Keyword / purpose / interval changes ────────────────────────────
keywordInput.addEventListener('input',   saveSettings);
timeInput.addEventListener('input',      saveSettings);
purposeInput.addEventListener('input',   saveSettings);
intervalSelect.addEventListener('change', async () => {
  const settings = await saveSettings();
  // Re-setup alarm with new interval if active
  if (settings.autoBook) {
    chrome.runtime.sendMessage({ type: 'SETUP_ALARM' });
  }
});

// ─── Event: Scan Now button ──────────────────────────────────────────────────
scanNowBtn.addEventListener('click', async () => {
  const settings = await saveSettings();
  scanNowBtn.disabled = true;
  setStatus('🔄', 'Scanning booking page...', 'scanning');

  const BOOKING_URL = 'https://learner.saveetha.in/academicevents/event-booking/';

  // Try to find an existing booking tab
  const tabs = await chrome.tabs.query({ url: BOOKING_URL + '*' });

  if (tabs.length > 0) {
    const sent = await triggerScanOnBookingTab(settings);
    if (!sent) {
      // Tab exists but can't communicate — reload it
      await chrome.tabs.reload(tabs[0].id);
      setStatus('🔄', 'Refreshed booking page — scan in progress...');
    } else {
      setStatus('📡', 'Scan triggered on open tab');
    }
  } else {
    // Open the booking page
    chrome.runtime.sendMessage({ type: 'OPEN_BOOKING_PAGE' });
    setStatus('🌐', 'Opening booking page...');
  }

  setTimeout(() => { scanNowBtn.disabled = false; }, 3000);
});

// ─── Event: Open Page button ─────────────────────────────────────────────────
openPageBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://learner.saveetha.in/academicevents/event-booking/' });
});

// ─── Event: Clear log ────────────────────────────────────────────────────────
clearLogBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ bookingLog: [] });
  renderLog([]);
});

// ─── Listen for messages from content script ─────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATUS_UPDATE') {
    const icon = msg.notLoggedIn ? '⚠️' : msg.scanning ? '🔄' : '📡';
    const type = msg.scanning ? 'scanning' : 'info';
    setStatus(icon, msg.message, type);
  }

  if (msg.type === 'BOOKED') {
    setStatus('✅', `Booked: ${msg.event}`);
    chrome.storage.local.get('bookingLog').then(({ bookingLog }) => {
      renderLog(bookingLog || []);
    });
  }

  if (msg.type === 'NO_SLOTS') {
    setStatus('🔍', msg.message);
  }

  if (msg.type === 'SLOTS_FOUND') {
    setStatus('🎯', msg.message);
  }

  if (msg.type === 'ERROR') {
    setStatus('❌', `Error: ${msg.message}`);
  }
});

// ─── Storage change listener (for updates from background) ───────────────
chrome.storage.onChanged.addListener((changes) => {
  if (changes.bookingLog) {
    renderLog(changes.bookingLog.newValue || []);
  }
  if (changes.autoBook !== undefined) {
    autoBookCheck.checked = changes.autoBook.newValue;
    updateStatusBadge(changes.autoBook.newValue);
    if (!changes.autoBook.newValue) {
      setStatus('⏸️', 'Auto-Book disabled automatically after booking');
    }
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadSettings();
setStatus('📡', 'Ready — click Scan Now to check for slots');
