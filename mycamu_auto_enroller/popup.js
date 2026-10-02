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
