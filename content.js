// =============================================
//  Saveetha Exam Auto-Booker — Content Script v2
//  Runs on: learner.saveetha.in/academicevents/event-booking/
// =============================================

(function () {
  'use strict';

  let settings = {
    autoBook: false,
    keywordFilter: '',
    timeFilter: '',
    purposeText: 'To attend the academic event as part of my curriculum.',
    intervalMinutes: 5,
  };

  let isRunning = false;

  // ─── Send status to popup ───────────────────────────────────────────────────
  function postStatus(type, data) {
    chrome.runtime.sendMessage({ type, ...data }).catch(() => {});
  }

  // ─── In-page toast ─────────────────────────────────────────────────────────
  function showToast(message, color = '#22c55e') {
    const existing = document.getElementById('saveetha-booker-toast');
    if (existing) existing.remove();

    const style = document.createElement('style');
    style.id = 'saveetha-booker-style';
    if (!document.getElementById('saveetha-booker-style')) {
      style.textContent = `
        @keyframes sb-slideIn {
          from { transform: translateX(120%); opacity: 0; }
          to   { transform: translateX(0);   opacity: 1; }
        }
      `;
      document.head.appendChild(style);
    }

    const toast = document.createElement('div');
    toast.id = 'saveetha-booker-toast';
    toast.style.cssText = `
      position: fixed; top: 20px; right: 20px;
      background: ${color}; color: #fff;
      padding: 14px 22px; border-radius: 12px;
      font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 600;
      z-index: 999999; box-shadow: 0 8px 32px rgba(0,0,0,0.35);
      animation: sb-slideIn 0.3s ease; max-width: 340px; line-height: 1.4;
    `;
    toast.textContent = `🎓 ${message}`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 6000);
  }

  // ─── Check login ────────────────────────────────────────────────────────────
  function isLoginPage() {
    const url = window.location.href.toLowerCase();
    const body = document.body.innerText.toLowerCase();
    return (
      url.includes('login') ||
      url.includes('signin') ||
      (body.includes('sign in') && !body.includes('book now'))
    );
  }

  // ─── Walk up the DOM to find a card ancestor that has a title ───────────────
  function findCardAncestor(el, maxDepth = 10) {
    let current = el;
    for (let i = 0; i < maxDepth; i++) {
      if (!current || current === document.body) break;
      current = current.parentElement;
      if (!current) break;

      // The card ancestor should contain a heading-like element
      const hasHeading = current.querySelector('h1,h2,h3,h4,h5,strong,b,[class*="title"],[class*="heading"],[class*="name"]');
      // And it should be a reasonably-sized element (not the whole page)
      const rect = current.getBoundingClientRect();
      if (hasHeading && rect.height < 600 && rect.height > 50) {
        return current;
      }
    }
    return null;
  }

  // ─── Extract event title from a card element ─────────────────────────────────
  function extractTitle(cardEl) {
    if (!cardEl) return '';
    // Try common heading selectors in order of preference
    const selectors = [
      'h1', 'h2', 'h3', 'h4', 'h5',
      '[class*="title"]', '[class*="heading"]', '[class*="name"]',
      'strong', 'b'
    ];
    for (const sel of selectors) {
      const el = cardEl.querySelector(sel);
      if (el && el.innerText.trim().length > 3) {
        return el.innerText.trim();
      }
    }
    // Fall back to first line of text
    return (cardEl.innerText || '').split('\n').find(l => l.trim().length > 3) || '';
  }

  // ─── Find the "Book Now" buttons ─────────────────────────────────────────────
  function findBookButtons() {
    const allClickable = document.querySelectorAll('a, button, input[type="button"], input[type="submit"]');
    return Array.from(allClickable).filter(el => {
      if (el.offsetParent === null) return false; // hidden elements
      const text = (el.innerText || el.value || el.textContent || '').trim().toLowerCase();
      return (
        text === 'book' ||
        text === 'book now' ||
        text === 'register' ||
        text === 'book slot' ||
        text === 'enroll' ||
        text.startsWith('book') ||
        text.includes('waitlist')
      );
    });
  }

  // ─── Find the Purpose input near a Book Now button ───────────────────────────
  function findPurposeInput(cardEl) {
    if (!cardEl) return null;
    // Look for textarea or text input with placeholder about "purpose"
    const inputs = cardEl.querySelectorAll('input[type="text"], textarea, input:not([type])');
    for (const inp of inputs) {
      const placeholder = (inp.placeholder || '').toLowerCase();
      const label = (inp.getAttribute('aria-label') || inp.getAttribute('name') || '').toLowerCase();
      if (
        placeholder.includes('purpose') ||
        placeholder.includes('reason') ||
        placeholder.includes('attending') ||
        label.includes('purpose') ||
        label.includes('reason')
      ) {
        return inp;
      }
    }
    // Fallback: any visible text input/textarea in the card
    for (const inp of inputs) {
      if (inp.offsetParent !== null) return inp;
    }
    return null;
  }

  // ─── Fill purpose field and simulate user typing ──────────────────────────────
  function fillPurposeField(input, value) {
    if (!input) return;
    input.focus();
    input.value = value;
    // Trigger React/Vue change detection
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
    if (nativeInputValueSetter && nativeInputValueSetter.set) {
      nativeInputValueSetter.set.call(input, value);
    }
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  // ─── Main: find all bookable slots ───────────────────────────────────────────
  function findBookableSlots() {
    const bookBtns = findBookButtons();
    console.log(`[Saveetha Booker] Found ${bookBtns.length} Book button(s)`);

    const slots = [];

    bookBtns.forEach((btn, i) => {
      const card = findCardAncestor(btn);
      const title = extractTitle(card);
      const purposeInput = findPurposeInput(card);
      const fullText = card ? card.innerText.trim() : btn.innerText.trim();
      const btnText = (btn.innerText || btn.value || btn.textContent || '').trim().toLowerCase();
      const isWaitlist = btnText.includes('waitlist');

      console.log(`[Saveetha Booker] Slot #${i}: title="${title}" | isWaitlist=${isWaitlist} | hasPurpose=${!!purposeInput}`);

      slots.push({
        bookBtn: btn,
        card,
        title,
        fullText,
        purposeInput,
        isWaitlist,
      });
    });

    return slots;
  }

  // ─── Apply keyword and time filters (ignoring punctuation/symbols) ────────
  function normalizeText(str) {
    if (!str) return '';
    // Remove all non-alphanumeric characters (except spaces) and collapse multiple spaces
    return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  }

  function matchesFilter(slot, keyword, timeKeyword) {
    const titleFull = normalizeText(slot.title);
    const textFull = normalizeText(slot.fullText);

    const kwNorm = normalizeText(keyword);
    const timeNorm = normalizeText(timeKeyword);

    const matchesKeyword = !kwNorm || titleFull.includes(kwNorm) || textFull.includes(kwNorm);
    const matchesTime = !timeNorm || titleFull.includes(timeNorm) || textFull.includes(timeNorm);

    return matchesKeyword && matchesTime;
  }

  // ─── Handle confirmation dialogs / modals ─────────────────────────────────────
  function handleConfirmDialog() {
    return new Promise((resolve) => {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        const confirmSelectors = [
          '.modal button', '.modal .btn',
          '[role="dialog"] button',
          '.swal-button', '.swal2-confirm',
          '.confirm-btn', '.ok-btn',
          'button[class*="confirm"]', 'button[class*="ok"]',
        ];
        for (const sel of confirmSelectors) {
          const btns = document.querySelectorAll(sel);
          for (const btn of btns) {
            const t = (btn.innerText || '').toLowerCase().trim();
            if (
              t === 'ok' || t === 'confirm' || t === 'yes' ||
              t === 'book' || t.includes('confirm') || t.includes('proceed')
            ) {
              console.log(`[Saveetha Booker] Clicking confirm: "${btn.innerText}"`);
              btn.click();
              clearInterval(interval);
              return resolve(true);
            }
          }
        }
        if (attempts > 25) {
          clearInterval(interval);
          resolve(false);
        }
      }, 200);
    });
  }

  // ─── Main booking run ─────────────────────────────────────────────────────────
  async function runBooker() {
    if (isRunning) return;
    isRunning = true;

    try {
      postStatus('STATUS_UPDATE', { message: 'Scanning page...', scanning: true });
      console.log('[Saveetha Booker] Starting scan...');

      if (isLoginPage()) {
        postStatus('STATUS_UPDATE', { message: '⚠️ Not logged in — please log in first', notLoggedIn: true });
        showToast('Please log in to Saveetha Portal first', '#ef4444');
        return;
      }

      const slots = findBookableSlots();
      console.log(`[Saveetha Booker] Total slots found: ${slots.length}`);

      if (slots.length === 0) {
        postStatus('NO_SLOTS', { message: 'No "Book Now" buttons found on page' });
        if (settings.autoBook && settings.intervalMinutes === '5s') {
          console.log('[Saveetha Booker] Fast scan mode: reloading page in 5 seconds...');
          setTimeout(() => {
            chrome.storage.local.get('autoBook', (data) => {
              if (data.autoBook) window.location.reload();
            });
          }, 5000);
        }
        return;
      }

      // Apply keyword & time filter
      const keyword = settings.keywordFilter.trim();
      const timeKeyword = (settings.timeFilter || '').trim();
      const filtered = (keyword || timeKeyword)
        ? slots.filter(s => matchesFilter(s, keyword, timeKeyword))
        : slots;

      console.log(`[Saveetha Booker] After filter kw:"${keyword}" time:"${timeKeyword}": ${filtered.length} slot(s)`);

      if (filtered.length === 0) {
        const titles = slots.map(s => `"${s.title}"`).join(', ');
        postStatus('STATUS_UPDATE', {
          message: `No slots match filter. Found: ${titles}`,
          scanning: false,
        });
        if (settings.autoBook && settings.intervalMinutes === '5s') {
          console.log('[Saveetha Booker] Fast scan mode: reloading page in 5 seconds...');
          setTimeout(() => {
            chrome.storage.local.get('autoBook', (data) => {
              if (data.autoBook) window.location.reload();
            });
          }, 5000);
        }
        return;
      }

      // ── Auto-book is OFF → just highlight ──────────────────────────────────
      if (!settings.autoBook) {
        filtered.forEach(s => {
          s.bookBtn.style.outline     = '3px solid #6366f1';
          s.bookBtn.style.boxShadow   = '0 0 14px rgba(99,102,241,0.7)';
        });
        const names = filtered.map(s => s.title || 'Slot').join(', ');
        postStatus('SLOTS_FOUND', {
          message: `${filtered.length} slot(s) available: ${names}`,
          slots: filtered.map(s => s.title),
        });
        showToast(`${filtered.length} slot(s) found — Auto-Book is OFF`, '#f59e0b');
        return;
      }

      // ── Auto-book: book the first matching slot ─────────────────────────────
      const target = filtered[0];
      const eventName = target.title || target.fullText.substring(0, 60);

      console.log(`[Saveetha Booker] Booking: ${eventName}`);
      showToast(`Booking: ${eventName}...`, '#6366f1');

      // Scroll to the card
      target.bookBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(800);

      // Fill in the "Purpose for attending" field if present
      if (target.purposeInput) {
        const purpose = settings.purposeText || 'To attend the academic event as part of my curriculum.';
        console.log(`[Saveetha Booker] Filling purpose: "${purpose}"`);
        fillPurposeField(target.purposeInput, purpose);
        await sleep(500);
      } else {
        console.log('[Saveetha Booker] No purpose field found — clicking directly');
      }

      // Click Book Now
      target.bookBtn.click();
      await sleep(600);

      // Handle any confirmation dialog
      const confirmed = await handleConfirmDialog();
      console.log(`[Saveetha Booker] Confirmation handled: ${confirmed}`);
      await sleep(1000);

      const actionStr = target.isWaitlist ? 'Waitlisted' : 'Booked';
      showToast(`✅ ${actionStr}: ${eventName}`);
      postStatus('BOOKED', { event: eventName, timestamp: new Date().toISOString(), status: actionStr });

    } catch (err) {
      console.error('[Saveetha Booker] Error:', err);
      postStatus('ERROR', { message: err.message });
    } finally {
      isRunning = false;
    }
  }

  // ─── Sleep helper ─────────────────────────────────────────────────────────────
  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ─── Wait for page to load dynamic content ────────────────────────────────────
  function waitForContent(timeout = 10000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const hasBookBtns = findBookButtons().length > 0;
        if (hasBookBtns || Date.now() - start > timeout) {
          resolve();
        } else {
          setTimeout(check, 500);
        }
      };
      check();
    });
  }

  // ─── Listen for messages from popup / background ──────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'SCAN_NOW') {
      settings = { ...settings, ...(msg.settings || {}) };
      waitForContent().then(() => runBooker());
      sendResponse({ ok: true });
    }
    if (msg.type === 'UPDATE_SETTINGS') {
      settings = { ...settings, ...(msg.settings || {}) };
      sendResponse({ ok: true });
    }
    if (msg.type === 'PING') {
      sendResponse({ ok: true, url: window.location.href });
    }
    return true;
  });

  // ─── Init on page load ────────────────────────────────────────────────────────
  async function init() {
    const stored = await chrome.storage.local.get([
      'autoBook', 'keywordFilter', 'timeFilter', 'purposeText', 'intervalMinutes'
    ]);
    settings = {
      autoBook:        stored.autoBook        ?? false,
      keywordFilter:   stored.keywordFilter   ?? '',
      timeFilter:      stored.timeFilter      ?? '',
      purposeText:     stored.purposeText     ?? 'To attend the academic event as part of my curriculum.',
      intervalMinutes: stored.intervalMinutes ?? 5,
    };

    console.log('[Saveetha Booker] Initialized. Settings:', settings);
    await waitForContent();
    runBooker();
  }

  setTimeout(init, 1500);

})();
