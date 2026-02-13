const tokenEl = document.getElementById('token');
const saveBtn = document.getElementById('save');
const statusEl = document.getElementById('status');
const enabledEl = document.getElementById('enabled');

// Load saved state on open
chrome.storage.local.get(['dcisive_token', 'dcisive_enabled'], (data) => {
  if (data.dcisive_token) {
    tokenEl.value = data.dcisive_token;
    showStatus('Token loaded', 'success');
  } else {
    showStatus('No token saved', 'info');
  }

  // Default to enabled if not set
  const isEnabled = data.dcisive_enabled !== false;
  enabledEl.checked = isEnabled;
});

// Toggle handler
enabledEl.addEventListener('change', () => {
  const enabled = enabledEl.checked;
  chrome.storage.local.set({ dcisive_enabled: enabled });
  // Notify content scripts
  chrome.tabs.query({ url: '*://demo.au.dcisive.io/*' }, (tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ENABLED', enabled });
    });
  });
});

saveBtn.addEventListener('click', () => {
  const token = tokenEl.value.trim();
  if (!token) {
    showStatus('Please paste a token first', 'error');
    return;
  }

  chrome.storage.local.set({ dcisive_token: token }, () => {
    showStatus('Token saved!', 'success');
    // Notify any open content scripts that the token changed
    chrome.tabs.query({ url: '*://demo.au.dcisive.io/*' }, (tabs) => {
      tabs.forEach((tab) => {
        chrome.tabs.sendMessage(tab.id, { type: 'TOKEN_UPDATED', token });
      });
    });
  });
});

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
}
