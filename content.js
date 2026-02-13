/**
 * Dcisive Prototyping — Content Script
 *
 * Injected into demo.au.dcisive.io pages.
 * Adds multi-select checkboxes to gallery file cards and a floating action bar
 * for bulk "Add to Job Folder" operations.
 */

(() => {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────
  let token = null;
  const selected = new Map(); // filename → { wrapper, filename, thumbnailGuid, fileData }
  const fileCache = new Map(); // filename → file API response
  let actionBar = null;
  let observer = null;

  // ─── API helper — routes through background service worker ─────────
  function apiCall(action, data) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'API_REQUEST', action, ...data }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }

  // ─── Init ───────────────────────────────────────────────────────────
  async function init() {
    // Load token from chrome.storage
    token = await new Promise((resolve) => {
      chrome.storage.local.get('dcisive_token', (data) => resolve(data.dcisive_token || null));
    });

    // Listen for token updates from popup
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'TOKEN_UPDATED') {
        token = msg.token;
        console.log('[Dcisive Ext] Token updated');
      }
    });

    // Wait for gallery article to appear
    await waitForElement('article');
    console.log('[Dcisive Ext] Gallery detected, injecting checkboxes...');

    // Create the floating action bar (hidden initially)
    actionBar = createActionBar();
    document.body.appendChild(actionBar);

    // Process existing cards
    processCards();

    // Observe for new cards (infinite scroll)
    const article = document.querySelector('article');
    if (article) {
      observer = new MutationObserver(() => processCards());
      observer.observe(article, { childList: true, subtree: true });
    }
  }

  // ─── Card Detection & Checkbox Injection ────────────────────────────
  function processCards() {
    const thumbnails = document.querySelectorAll('img[src*="content.au.dcisive.io"]');

    thumbnails.forEach((img) => {
      // Walk up to the file entry wrapper: div.flex.flex-col.justify-end
      const wrapper = img.closest('.flex.flex-col.justify-end');
      if (!wrapper || wrapper.dataset.dcisiveExt) return; // Already processed
      wrapper.dataset.dcisiveExt = 'true';

      // Find the clickable card area
      const clickable = wrapper.querySelector('.hover\\:cursor-pointer');
      if (!clickable) return;

      // Extract filename from sibling text element
      const filenameEl = wrapper.querySelector('.mt-2.truncate.text-center');
      const filename = filenameEl?.textContent?.trim() || '';
      if (!filename) return;

      // Extract thumbnail GUID from image URL
      const guidMatch = img.src.match(/thumbnail\/([a-f0-9]+)\./);
      const thumbnailGuid = guidMatch ? guidMatch[1] : '';

      // Make the clickable area position relative for absolute checkbox
      clickable.style.position = 'relative';

      // Create checkbox overlay
      const checkbox = document.createElement('div');
      checkbox.className = 'dcisive-ext-checkbox';
      checkbox.dataset.filename = filename;
      checkbox.dataset.guid = thumbnailGuid;
      checkbox.innerHTML = `
        <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path class="dcisive-ext-check" d="M6 10l3 3 5-6" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;

      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleSelection(filename, wrapper, thumbnailGuid, checkbox);
      });

      clickable.appendChild(checkbox);

      // Async: check if file is already in a Job Folder
      checkJobFolderStatus(filename, clickable);
    });
  }

  async function checkJobFolderStatus(filename, clickable) {
    if (!token) return;

    try {
      let fileData = fileCache.get(filename);
      if (!fileData) {
        fileData = await resolveFile(filename);
        if (fileData) fileCache.set(filename, fileData);
      }
      if (!fileData) return;

      const jfTag = (fileData.tags || []).find(
        (t) => t.key === 'JobFolder.Number' && t.stringValue
      );

      if (jfTag) {
        const badge = document.createElement('div');
        badge.className = 'dcisive-ext-jf-badge';
        badge.title = `Job Folder: ${jfTag.stringValue}`;
        badge.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
          </svg>
          <span>${jfTag.stringValue}</span>
        `;
        clickable.appendChild(badge);
      }
    } catch (err) {
      // Silently fail — badge is just a nice-to-have
      console.debug('[Dcisive Ext] Badge check failed for', filename, err.message);
    }
  }

  function toggleSelection(filename, wrapper, thumbnailGuid, checkbox) {
    if (selected.has(filename)) {
      selected.delete(filename);
      checkbox.classList.remove('dcisive-ext-checkbox-selected');
      wrapper.querySelector('.hover\\:cursor-pointer')?.classList.remove('dcisive-ext-card-selected');
    } else {
      selected.set(filename, { wrapper, filename, thumbnailGuid, fileData: fileCache.get(filename) || null });
      checkbox.classList.add('dcisive-ext-checkbox-selected');
      wrapper.querySelector('.hover\\:cursor-pointer')?.classList.add('dcisive-ext-card-selected');
    }
    updateActionBar();
  }

  // ─── Action Bar ─────────────────────────────────────────────────────
  function createActionBar() {
    const bar = document.createElement('div');
    bar.className = 'dcisive-ext-action-bar dcisive-ext-hidden';
    bar.innerHTML = `
      <span class="dcisive-ext-count">0 files selected</span>
      <div class="dcisive-ext-actions">
        <button class="dcisive-ext-btn dcisive-ext-btn-jf" data-action="jobfolder">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
          </svg>
          Add to Job Folder
        </button>
        <button class="dcisive-ext-btn dcisive-ext-btn-clear" data-action="clear">
          Clear
        </button>
      </div>
    `;

    bar.querySelector('[data-action="jobfolder"]').addEventListener('click', () => showJobFolderModal());
    bar.querySelector('[data-action="clear"]').addEventListener('click', () => clearSelection());

    return bar;
  }

  function updateActionBar() {
    const count = selected.size;
    if (count === 0) {
      actionBar.classList.add('dcisive-ext-hidden');
    } else {
      actionBar.classList.remove('dcisive-ext-hidden');
      actionBar.querySelector('.dcisive-ext-count').textContent =
        `${count} file${count !== 1 ? 's' : ''} selected`;
    }
  }

  function clearSelection() {
    selected.forEach((data, filename) => {
      const checkbox = data.wrapper.querySelector('.dcisive-ext-checkbox');
      if (checkbox) checkbox.classList.remove('dcisive-ext-checkbox-selected');
      data.wrapper.querySelector('.hover\\:cursor-pointer')?.classList.remove('dcisive-ext-card-selected');
    });
    selected.clear();
    updateActionBar();
  }

  // ─── Modals ─────────────────────────────────────────────────────────
  function showJobFolderModal() {
    const modal = createModal('Add to Job Folder', `
      <div class="dcisive-ext-form-group">
        <label>Job Folder Number</label>
        <input type="text" id="dcisive-ext-jf-number" placeholder="e.g. JF10001" />
      </div>
    `, async () => {
      const jfNumber = document.getElementById('dcisive-ext-jf-number').value.trim();
      if (!jfNumber) return showToast('Please enter a Job Folder number', 'error');
      await bulkAddTag('JobFolder.Number', jfNumber, 'string');
    });
    document.body.appendChild(modal);
    document.getElementById('dcisive-ext-jf-number').focus();
  }

  function createModal(title, bodyHTML, onSubmit) {
    const overlay = document.createElement('div');
    overlay.className = 'dcisive-ext-modal-overlay';
    overlay.innerHTML = `
      <div class="dcisive-ext-modal">
        <div class="dcisive-ext-modal-header">
          <h2>${title}</h2>
          <button class="dcisive-ext-modal-close">&times;</button>
        </div>
        <div class="dcisive-ext-modal-body">
          ${bodyHTML}
        </div>
        <div class="dcisive-ext-modal-footer">
          <button class="dcisive-ext-btn dcisive-ext-btn-cancel">Cancel</button>
          <button class="dcisive-ext-btn dcisive-ext-btn-submit">
            Apply to ${selected.size} file${selected.size !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    `;

    const close = () => overlay.remove();
    overlay.querySelector('.dcisive-ext-modal-close').addEventListener('click', close);
    overlay.querySelector('.dcisive-ext-btn-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('.dcisive-ext-btn-submit').addEventListener('click', async () => {
      const submitBtn = overlay.querySelector('.dcisive-ext-btn-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Processing...';
      try {
        await onSubmit();
        close();
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = `Apply to ${selected.size} file${selected.size !== 1 ? 's' : ''}`;
      }
    });

    // Enter key submits
    overlay.querySelectorAll('input').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') overlay.querySelector('.dcisive-ext-btn-submit').click();
      });
    });

    return overlay;
  }

  // ─── Bulk Tag Operation ─────────────────────────────────────────────
  async function bulkAddTag(key, value, type) {
    if (!token) {
      showToast('No API token. Click the extension icon to add one.', 'error');
      return;
    }

    const filenames = Array.from(selected.keys());
    let successCount = 0;
    let errorCount = 0;

    showToast(`Tagging ${filenames.length} files...`, 'info');

    for (let i = 0; i < filenames.length; i++) {
      const filename = filenames[i];
      showToast(`Processing ${i + 1}/${filenames.length}: ${filename}`, 'info');

      try {
        // Resolve file data via search API
        let fileData = fileCache.get(filename);
        if (!fileData) {
          fileData = await resolveFile(filename);
          if (fileData) fileCache.set(filename, fileData);
        }

        if (!fileData) {
          console.warn(`[Dcisive Ext] Could not find file: ${filename}`);
          errorCount++;
          continue;
        }

        // Build the new tag
        const newTag = buildTag(key, value, type);

        // Update the file with the new tag
        const ok = await updateFileTags(fileData.id, fileData, newTag);
        if (ok) {
          successCount++;
          // Refresh cache
          const refreshed = await resolveFile(filename);
          if (refreshed) fileCache.set(filename, refreshed);
        } else {
          errorCount++;
        }
      } catch (err) {
        console.error(`[Dcisive Ext] Error tagging ${filename}:`, err);
        errorCount++;
      }
    }

    if (errorCount === 0) {
      showToast(`Tagged ${successCount} files with ${key} = ${value}. Refreshing...`, 'success');
    } else {
      showToast(`Tagged ${successCount} files, ${errorCount} failed`, 'error');
    }

    clearSelection();

    // Refresh the Dcisive gallery to reflect changes
    if (successCount > 0) {
      setTimeout(() => refreshGallery(), 1500);
    }
  }

  function refreshGallery() {
    // Get the current search query from the search bar
    const searchInput = document.querySelector('input[placeholder="Search"]');
    const query = searchInput?.value?.trim();

    if (query) {
      // Navigate to the search URL to re-run the query
      window.location.href = `https://demo.au.dcisive.io/goto/files?query=${encodeURIComponent(query)}`;
    } else {
      // No search query — just reload the page
      window.location.reload();
    }
  }

  function buildTag(key, value, type) {
    const tag = { key, source: 'user' };
    switch (type) {
      case 'number':
        tag.doubleValue = parseFloat(value);
        break;
      case 'datetime':
        tag.dateTimeValue = new Date(value).toISOString();
        break;
      case 'boolean':
        tag.boolValue = value === 'true' || value === '1';
        break;
      default:
        tag.stringValue = value;
    }
    return tag;
  }

  // ─── API Calls (via background service worker) ─────────────────────
  async function resolveFile(filename) {
    try {
      const result = await apiCall('searchFiles', { filename, token });
      if (result.expired) {
        showToast('Token expired. Please update it in the extension popup.', 'error');
        return null;
      }
      const files = result.files || [];

      // Exact match by filename or title
      return (
        files.find((f) => f.filename === filename) ||
        files.find((f) => f.title === filename) ||
        // Partial match: the gallery truncates long names with "..."
        files.find((f) => (f.filename || '').startsWith(filename.replace(/\.{3}$/, ''))) ||
        files.find((f) => (f.title || '').startsWith(filename.replace(/\.{3}$/, ''))) ||
        null
      );
    } catch (err) {
      console.error('[Dcisive Ext] Search error:', err);
      return null;
    }
  }

  async function updateFileTags(fileId, fileData, newTag) {
    try {
      const result = await apiCall('updateFile', { fileId, fileData, newTag, token });
      if (result.expired) {
        showToast('Token expired. Please update it in the extension popup.', 'error');
        return false;
      }
      return result.ok;
    } catch (err) {
      console.error('[Dcisive Ext] Update error:', err);
      return false;
    }
  }

  // ─── Toast Notifications ────────────────────────────────────────────
  function showToast(message, type = 'info') {
    // Remove existing toast
    document.querySelectorAll('.dcisive-ext-toast').forEach((t) => t.remove());

    const toast = document.createElement('div');
    toast.className = `dcisive-ext-toast dcisive-ext-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // Auto-remove after 4s (unless it's a progress message)
    if (type !== 'info') {
      setTimeout(() => toast.remove(), 4000);
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────
  function waitForElement(selector, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);

      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        obs.disconnect();
        reject(new Error(`Timeout waiting for ${selector}`));
      }, timeout);
    });
  }

  // ─── Start ──────────────────────────────────────────────────────────
  init().catch((err) => console.error('[Dcisive Ext] Init error:', err));
})();
