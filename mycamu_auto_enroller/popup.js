const autoEnrollCheck = document.getElementById('autoEnrollCheck');
const courseInput = document.getElementById('courseInput');
const sectionInput = document.getElementById('sectionInput');
const bulkInput = document.getElementById('bulkInput');
const statusText = document.getElementById('statusText');
const statusMsg = document.getElementById('statusMsg');
const targetList = document.getElementById('targetList');

function renderTags() {
  const text = courseInput.value;
  const keywords = text.split(',').map(k => k.trim()).filter(k => k);
  
  targetList.innerHTML = '';
  
  keywords.forEach((kw, i) => {
    const span = document.createElement('span');
    span.className = 'target-tag';
    span.textContent = kw;
    span.style.animationDelay = `${i * 0.05}s`; // Staggered animation
    targetList.appendChild(span);
  });
}

async function loadSettings() {
  const data = await chrome.storage.local.get(['autoEnroll', 'courseKeyword', 'sectionKeyword', 'bulkInput']);
  autoEnrollCheck.checked = data.autoEnroll ?? false;
  courseInput.value = data.courseKeyword ?? '';
  sectionInput.value = data.sectionKeyword ?? '';
  if (bulkInput) bulkInput.value = data.bulkInput ?? '';
  renderTags();
  updateStatus(data.autoEnroll);
}

function updateStatus(isActive) {
  if (isActive) {
    statusMsg.textContent = "Scanning for targets...";
    statusText.className = "status active";
  } else {
    statusMsg.textContent = "Idle - Waiting for targets";
    statusText.className = "status";
  }
}

async function saveSettings() {
  const isActive = autoEnrollCheck.checked;
  await chrome.storage.local.set({
    autoEnroll: isActive,
    courseKeyword: courseInput.value,
    sectionKeyword: sectionInput.value,
    bulkInput: bulkInput ? bulkInput.value : ''
  });
  updateStatus(isActive);
}

autoEnrollCheck.addEventListener('change', saveSettings);
courseInput.addEventListener('input', () => {
    renderTags();
    saveSettings();
});
sectionInput.addEventListener('input', saveSettings);
if (bulkInput) bulkInput.addEventListener('input', saveSettings);

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CLICKED') {
        statusMsg.textContent = "✅ Clicked Enroll! (Scanning...)";
        statusText.className = "status success";
    }
});

loadSettings();

// --- Test Fire Simulation ---
const testFireBtn = document.getElementById('testFireBtn');

let fakeCursor = null;

function createSimulationCursor() {
    if (fakeCursor) return;
    
    const style = document.createElement('style');
    style.textContent = `
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

if (testFireBtn) {
    testFireBtn.addEventListener('click', () => {
        testFireBtn.style.transform = 'scale(0.95)';
        setTimeout(() => testFireBtn.style.transform = 'scale(1)', 100);
        
        createSimulationCursor();
        
        // Start crosshair from the top of the popup
        fakeCursor.style.opacity = '1';
        fakeCursor.style.left = '50%';
        fakeCursor.style.top = '20px';
        
        setTimeout(() => {
            // Glide to the button
            const rect = testFireBtn.getBoundingClientRect();
            const exactX = Math.round(rect.left + rect.width / 2);
            const exactY = Math.round(rect.top + rect.height / 2);
            
            fakeCursor.style.left = exactX + 'px'; 
            fakeCursor.style.top = exactY + 'px';
            
            setTimeout(() => {
                // Apply recoil
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
                    const rot = angle + Math.PI/2;
                    spark.style.cssText = `position: fixed; left: ${exactX}px; top: ${exactY}px; width: 3px; height: 12px; background: #ffa500; border-radius: 4px; z-index: 9999998; pointer-events: none; transform: translate(-50%, -50%) rotate(${rot}rad); animation: sparkFly 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards; --tx: ${tx}px; --ty: ${ty}px;`;
                    document.body.appendChild(spark);
                    setTimeout(() => spark.remove(), 400);
                }
                
                // Hide cursor after a short delay
                setTimeout(() => {
                    fakeCursor.style.opacity = '0';
                }, 800);
                
            }, 400);
        }, 50);
    });
}

