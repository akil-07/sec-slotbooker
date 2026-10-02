let settings = { autoEnroll: false, courseKeyword: '', sectionKeyword: '', bulkInput: '' };
let intervalId = null;

// --- Fake Mouse Cursor & Ripple ---
let fakeCursor = null;
let scrollDirection = 1;
const clickedKeywords = new Map(); // keyword -> lastClickedTimestamp

function createFakeCursor() {
    if (fakeCursor) return;
    
    const style = document.createElement('style');
    style.textContent = `
        @keyframes rippleOut {
            0% { transform: scale(0.5); opacity: 1; border-width: 4px; }
            100% { transform: scale(2.5); opacity: 0; border-width: 1px; }
        }
        @keyframes recoil {
            0% { transform: translate(-50%, -50%) scale(1); }
            15% { transform: translate(-50%, -50%) scale(1.4); }
            100% { transform: translate(-50%, -50%) scale(1); }
        }
        @keyframes muzzleFlash {
            0% { opacity: 1; transform: translate(-50%, -50%) scale(0.5) rotate(45deg); }
            100% { opacity: 0; transform: translate(-50%, -50%) scale(2.5) rotate(45deg); }
        }
        @keyframes sparkFly {
            0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
            100% { transform: translate(calc(-50% + var(--tx)), calc(-50% + var(--ty))) scale(0); opacity: 0; }
        }
        .sniper-crosshair {
            position: fixed;
            width: 32px;
            height: 32px;
            border: 2px solid rgba(255,51,51,0.8);
            border-radius: 50%;
            z-index: 9999999;
            pointer-events: none;
            transition: top 0.4s cubic-bezier(0.2, 0.8, 0.2, 1), left 0.4s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.3s;
            opacity: 0;
            box-shadow: 0 0 10px rgba(255,51,51,0.5), inset 0 0 10px rgba(255,51,51,0.5);
            transform: translate(-50%, -50%);
        }
        .sniper-crosshair::before, .sniper-crosshair::after {
            content: '';
            position: absolute;
            background: #ff3333;
            box-shadow: 0 0 5px #ff0000;
        }
        .sniper-crosshair::before {
            top: -6px; bottom: -6px; left: 50%; width: 2px; transform: translateX(-50%);
        }
        .sniper-crosshair::after {
            left: -6px; right: -6px; top: 50%; height: 2px; transform: translateY(-50%);
        }
        .sniper-dot {
            position: absolute;
            top: 50%; left: 50%;
            width: 4px; height: 4px;
            background: #fff;
            border-radius: 50%;
            transform: translate(-50%, -50%);
            box-shadow: 0 0 8px #fff;
        }
        .sniper-recoil {
            animation: recoil 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }
    `;
    document.head.appendChild(style);

    fakeCursor = document.createElement('div');
    fakeCursor.className = 'sniper-crosshair';
    const dot = document.createElement('div');
    dot.className = 'sniper-dot';
    fakeCursor.appendChild(dot);
    document.body.appendChild(fakeCursor);
}

function isElementInViewport(el) {
    const rect = el.getBoundingClientRect();
    return (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
}

// --- Visual Debugging Toast ---
function showToast(message, color = '#333') {
    let existing = document.getElementById('mycamu-debug-toast');
    if (!existing) {
        existing = document.createElement('div');
        existing.id = 'mycamu-debug-toast';
        existing.style.cssText = `position: fixed; bottom: 20px; left: 20px; color: white; padding: 10px 15px; border-radius: 8px; z-index: 999999; font-family: sans-serif; font-size: 14px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); pointer-events: none;`;
        document.body.appendChild(existing);
    }
    existing.style.background = color;
    existing.innerText = message;
    
    // Auto clear after 3 seconds
    if (existing.timeoutId) clearTimeout(existing.timeoutId);
    existing.timeoutId = setTimeout(() => existing.remove(), 3000);
}

function scanAndEnroll() {
    if (!settings.autoEnroll) {
        if (fakeCursor) fakeCursor.style.opacity = '0';
        return;
    }
    
    createFakeCursor();
    
    // Build target array from bulk input or fallback to simple inputs
    const targets = [];
    const globalSection = (settings.sectionKeyword || '').trim().toLowerCase();
    
    if (settings.bulkInput && settings.bulkInput.trim()) {
        const lines = settings.bulkInput.split('\n');
        for (let line of lines) {
            if (!line.trim()) continue;
            const parts = line.split('|');
            if (parts.length >= 2) {
                targets.push({
                    course: parts[0].trim().toLowerCase(),
                    section: parts[1].trim().toLowerCase(),
                    globalSection: globalSection
                });
            } else if (parts.length === 1) {
                targets.push({
                    course: parts[0].trim().toLowerCase(),
                    section: '',
                    globalSection: globalSection
                });
            }
        }
    } else if (settings.courseKeyword) {
        const keywords = settings.courseKeyword.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
        for (let kw of keywords) {
            targets.push({ course: kw, section: '', globalSection: globalSection });
        }
    }
    
    console.log('[Auto Enroller] Parsed targets:', targets);
    
    if (targets.length === 0) return;
    
    const allButtons = document.querySelectorAll('button, a, [role="button"]');
    const validPoints = [];
    
    for (let btn of allButtons) {
        const btnText = (btn.innerText || '').trim().toLowerCase();
        if ((btnText.includes('enroll') || btnText.includes('select')) && btn.offsetWidth > 0) {
            
            // Extract the "local text" (e.g., the specific row) around the button
            let localText = '';
            let p = btn.parentElement;
            for(let i=0; i<6 && p; i++) {
                localText = (p.innerText || '').toLowerCase();
                // If we found a chunk of text that likely represents the section row, stop
                if (localText.length > 15) break; 
                p = p.parentElement;
            }
            
            // Go up the tree from the button to find its specific "card" / Course name
            let parent = btn.parentElement;
            let depth = 0;
            let foundSubject = false;
            let matchedTarget = null;
            
            while (parent && depth < 15) {
                const text = (parent.innerText || '').toLowerCase();
                
                if (text.length > 3000) break;
                
                for (let t of targets) {
                    if (text.includes(t.course)) {
                        
                        // Crucial fix: check sections against the LOCAL text to avoid cross-matching
                        // with other sections that happen to be in the same Course Card table.
                        const checkText = localText.length > 10 ? localText : text;
                        
                        if (t.section && !checkText.includes(t.section)) {
                            continue; 
                        }
                        
                        if (t.globalSection && !checkText.includes(t.globalSection)) {
                            continue;
                        }
                        
                        foundSubject = true;
                        matchedTarget = t;
                        break;
                    }
                }
                
                if (foundSubject) break;
                
                parent = parent.parentElement;
                depth++;
            }
            
            if (foundSubject) {
                // Check cooldown for this specific course
                const lastClicked = clickedKeywords.get(matchedTarget.course) || 0;
                if (Date.now() - lastClicked < 15000) {
                    continue; // On cooldown
                }
                
                // VALID BUTTON FOUND!
                let clickable = btn;
                if (clickable.tagName !== 'BUTTON' && clickable.tagName !== 'A') {
                    const wrapper = clickable.closest('button, a, [role="button"]');
                    if (wrapper) clickable = wrapper;
                }
                
                validPoints.push({
                    element: clickable,
                    keyword: matchedTarget.course
                });
                
                break; // We only want to click one button per scan tick
            }
        }
    }
    
    if (validPoints.length > 0) {
        const pt = validPoints[0];
        
        clickedKeywords.set(pt.keyword, Date.now());
        
        if (!isElementInViewport(pt.element)) {
            pt.element.scrollIntoView({ behavior: 'auto', block: 'center' });
        }
        
        showToast(`🎯 Target Acquired! Gliding to click...`, '#1a73e8');
        
        setTimeout(() => {
            if (!settings.autoEnroll) {
                if (fakeCursor) fakeCursor.style.opacity = '0';
                return;
            }
            
            const rect = pt.element.getBoundingClientRect();
            const exactX = Math.round(rect.left + rect.width / 2);
            const exactY = Math.round(rect.top + rect.height / 2);
            
            fakeCursor.style.opacity = '1';
            fakeCursor.style.left = exactX + 'px'; 
            fakeCursor.style.top = exactY + 'px';
            
            setTimeout(() => {
                if (!settings.autoEnroll) {
                    fakeCursor.style.opacity = '0';
                    return; 
                }
                
                // Apply recoil to the crosshair
                fakeCursor.classList.add('sniper-recoil');
                setTimeout(() => fakeCursor.classList.remove('sniper-recoil'), 300);
                
                // Muzzle flash
                const flash = document.createElement('div');
                flash.style.cssText = `position: fixed; left: ${exactX}px; top: ${exactY}px; width: 40px; height: 40px; background: #ffff00; border-radius: 10px; filter: blur(4px); z-index: 9999998; pointer-events: none; animation: muzzleFlash 0.2s ease-out forwards;`;
                document.body.appendChild(flash);
                setTimeout(() => flash.remove(), 200);
                
                // Sparks
                for(let i=0; i<6; i++) {
                    const spark = document.createElement('div');
                    const angle = (Math.PI * 2 * i) / 6 + (Math.random() * 0.5);
                    const dist = 30 + Math.random() * 40;
                    const tx = Math.cos(angle) * dist;
                    const ty = Math.sin(angle) * dist;
                    // Rotate spark to point in direction of travel
                    const rot = angle + Math.PI/2;
                    spark.style.cssText = `position: fixed; left: ${exactX}px; top: ${exactY}px; width: 3px; height: 12px; background: #ffa500; border-radius: 4px; z-index: 9999998; pointer-events: none; transform: translate(-50%, -50%) rotate(${rot}rad); animation: sparkFly 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards; --tx: ${tx}px; --ty: ${ty}px;`;
                    document.body.appendChild(spark);
                    setTimeout(() => spark.remove(), 400);
                }
                
                chrome.runtime.sendMessage({ type: 'REAL_CLICK', points: [{x: exactX, y: exactY}] }).catch(()=>{});
                chrome.runtime.sendMessage({ type: 'CLICKED' }).catch(()=>{});
                
            }, 400);
        }, 50);
    } else {
        if (fakeCursor) fakeCursor.style.opacity = '0';
    }
}

function startScanning() {
    if (intervalId) clearInterval(intervalId);
    if (!settings.autoEnroll) return;
    
    console.log('[Auto Enroller] Started scanning for:', settings.courseKeyword);
    scanAndEnroll();
    intervalId = setInterval(scanAndEnroll, 1500); // scan every 1.5s
}

function stopScanning() {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
    console.log('[Auto Enroller] Stopped scanning');
}

// Listen for storage changes from the popup
chrome.storage.onChanged.addListener((changes) => {
    let changed = false;
    if (changes.autoEnroll !== undefined) {
      settings.autoEnroll = changes.autoEnroll.newValue;
      changed = true;
    }
    if (changes.courseKeyword !== undefined) {
      settings.courseKeyword = changes.courseKeyword.newValue;
      changed = true;
    }
    if (changes.sectionKeyword !== undefined) {
      settings.sectionKeyword = changes.sectionKeyword.newValue;
      changed = true;
    }
    if (changes.bulkInput !== undefined) {
      settings.bulkInput = changes.bulkInput.newValue;
      changed = true;
    }

    if (changed) {
      if (settings.autoEnroll) startScanning();
      else stopScanning();
    }
});

// Initial load on page visit
chrome.storage.local.get(['autoEnroll', 'courseKeyword', 'sectionKeyword', 'bulkInput'], (stored) => {
    settings.autoEnroll = stored.autoEnroll ?? false;
    settings.courseKeyword = stored.courseKeyword ?? '';
    settings.sectionKeyword = stored.sectionKeyword ?? '';
    settings.bulkInput = stored.bulkInput ?? '';
    
    if (settings.autoEnroll) startScanning();
});
