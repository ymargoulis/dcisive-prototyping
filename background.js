/**
 * Dcisive Prototyping — Background Service Worker
 *
 * Handles cross-origin API calls to api.au.dcisive.io.
 * Content scripts can't make cross-origin requests directly in MV3,
 * so they route through here via chrome.runtime.sendMessage.
 */

const API_BASE = 'https://api.au.dcisive.io';
const MAX_RETRIES = 3;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'API_REQUEST') return false;

  handleApiRequest(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));

  return true; // Keep the message channel open for async response
});

// ─── Retry helper for 429 rate limiting ──────────────────────────────
async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url, options);

    if (resp.status === 429 && attempt < retries) {
      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`[Dcisive Ext BG] Rate limited (429), retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    return resp;
  }
}

async function handleApiRequest(msg) {
  const { action, token } = msg;

  if (!token) {
    return { error: 'No API token provided' };
  }

  switch (action) {
    case 'searchFiles':
      return searchFiles(msg.filename, token);
    case 'updateFile':
      return updateFile(msg.fileId, msg.fileData, msg.newTag, token);
    default:
      return { error: `Unknown action: ${action}` };
  }
}

async function searchFiles(filename, token) {
  const resp = await fetchWithRetry(
    `${API_BASE}/v1/files/search?query=${encodeURIComponent(filename)}&limit=10`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (resp.status === 401) {
    return { expired: true, files: [] };
  }

  if (!resp.ok) {
    return { error: `Search failed: ${resp.status}`, files: [] };
  }

  const data = await resp.json();
  return { files: data.data || [] };
}

async function updateFile(fileId, fileData, newTag, token) {
  // Merge: keep existing tags, replace if same key exists
  const tags = (fileData.tags || []).filter((t) => t.key !== newTag.key);
  tags.push(newTag);

  // Build multipart form data manually (FormData not available in service workers)
  const boundary = '----DcisiveExt' + Date.now();
  let body = '';

  function addField(name, value) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }

  addField('Title', fileData.title || fileData.filename || 'Untitled');
  addField('Filename', fileData.filename || '');
  addField('StorageId', String(fileData.storageId || 1));
  addField('StorageLocation', fileData.storageLocation || '');
  addField('FileUpdatedDate', new Date().toISOString());
  addField('FileUpdatedBy', 'Dcisive Prototyping');

  tags.forEach((t, i) => {
    addField(`Tags[${i}][key]`, t.key);
    addField(`Tags[${i}][source]`, t.source || 'user');
    if (t.dateTimeValue != null) addField(`Tags[${i}][dateTimeValue]`, t.dateTimeValue);
    else if (t.doubleValue != null) addField(`Tags[${i}][doubleValue]`, String(t.doubleValue));
    else if (t.boolValue != null) addField(`Tags[${i}][boolValue]`, String(t.boolValue));
    else if (t.stringValue != null) addField(`Tags[${i}][stringValue]`, t.stringValue);
  });

  body += `--${boundary}--\r\n`;

  const resp = await fetchWithRetry(`${API_BASE}/v1/files/${fileId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: body,
  });

  if (resp.status === 401) {
    return { expired: true, ok: false };
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.error(`[Dcisive Ext BG] Update failed: ${resp.status}`, errText);
    return { ok: false, status: resp.status, error: errText };
  }

  return { ok: true };
}
