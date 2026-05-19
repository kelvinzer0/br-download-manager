// Track active downloads with GID
let downloadGids = new Set();
let discardedTabIds = [];
let tabDiscarded = false;
// Track pending downloads waiting for filename
let pendingDownloads = {};

// Extract meaningful filename from URL, skip hash-like names
function extractFilename(url) {
  try {
    const urlPath = new URL(url).pathname;
    const segments = urlPath.split('/').filter(s => s.length > 0);
    const last = segments[segments.length - 1] || '';
    const name = last.split('?')[0];
    // Skip if looks like a hash (hex string with extension)
    if (/^[a-f0-9]{8,}(\.\w+)?$/i.test(name)) return null;
    // Skip if too short and no extension
    if (name.length < 3 && !name.includes('.')) return null;
    return name || null;
  } catch (e) {
    return null;
  }
}

chrome.downloads.onCreated.addListener(async (downloadItem) => {
  if (downloadItem.state !== 'in_progress') return;

  const downloadId = downloadItem.id;
  const downloadUrl = downloadItem.finalUrl || downloadItem.url;

  // Try to get real filename from multiple sources
  let filename = downloadItem.filename || null;

  // Prefer original URL (before redirect) - GitHub redirects use hash filenames
  if (!filename) {
    filename = extractFilename(downloadItem.url);
  }

  // Fallback to finalUrl (after redirect)
  if (!filename) {
    filename = extractFilename(downloadUrl);
  }

  // Check if filename looks like a hash and try to find better name
  if (filename && /^[a-f0-9]{8,}(\.\w+)?$/i.test(filename)) {
    const originalName = extractFilename(downloadItem.url);
    if (originalName) filename = originalName;
  }

  // Store pending download info
  pendingDownloads[downloadId] = {
    url: downloadUrl,
    originalUrl: downloadItem.url,
    filename: filename,
    referrer: downloadItem.referrer || '',
    queued: Date.now()
  };

  // If filename is empty or hash-like, wait for onChanged
  if (!filename || filename === 'Unknown') {
    console.log(`Waiting for filename for download ${downloadId}...`);
    setTimeout(async () => {
      if (pendingDownloads[downloadId]) {
        await processDownload(downloadId);
      }
    }, 1500);
    return;
  }

  await processDownload(downloadId);
});

// Listen for filename changes
chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.filename && delta.filename.current) {
    const downloadId = delta.id;
    if (pendingDownloads[downloadId]) {
      // Chrome sets full path, extract just the filename
      const fullPath = delta.filename.current;
      const parts = fullPath.replace(/\\/g, '/').split('/');
      pendingDownloads[downloadId].filename = parts.pop();
      pendingDownloads[downloadId].downloadDir = parts.join('/');

      console.log(`Filename resolved: ${pendingDownloads[downloadId].filename}`);
      await processDownload(downloadId);
    }
  }
});

// Check if a partial/failed download with same filename exists in aria2
async function findExistingDownload(filename) {
  if (!filename || filename === 'Unknown') return null;

  try {
    // Search ALL states: active, waiting, stopped
    const [active, waiting, stopped] = await Promise.all([
      aria2Call('aria2.tellActive'),
      aria2Call('aria2.tellWaiting', [0, 200]),
      aria2Call('aria2.tellStopped', [0, 500])
    ]);

    const allDownloads = [
      ...(active || []),
      ...(waiting || []),
      ...(stopped || [])
    ];

    // Normalize search filename for comparison
    const searchName = filename.replace(/\\/g, '/').split('/').pop().toLowerCase();

    for (const dl of allDownloads) {
      // Skip completed downloads
      if (dl.status === 'complete') continue;

      if (!dl.files) continue;
      for (const file of dl.files) {
        if (!file.path) continue;
        const existingName = file.path.replace(/\\/g, '/').split('/').pop().toLowerCase();

        // Match by exact filename OR stem (without extension) for partial matches
        if (existingName === searchName) {
          console.log(`Found existing download: gid=${dl.gid} status=${dl.status} file=${existingName} completed=${dl.completedLength}`);
          return {
            gid: dl.gid,
            path: file.path,
            completedLength: dl.completedLength || '0',
            status: dl.status
          };
        }
      }
    }

    // Also check by stem match (filename without extension) for edge cases
    const searchStem = searchName.includes('.') ? searchName.substring(0, searchName.lastIndexOf('.')) : searchName;
    if (searchStem.length > 3) {
      for (const dl of allDownloads) {
        if (dl.status === 'complete') continue;
        if (!dl.files) continue;
        for (const file of dl.files) {
          if (!file.path) continue;
          const existingName = file.path.replace(/\\/g, '/').split('/').pop().toLowerCase();
          const existingStem = existingName.includes('.') ? existingName.substring(0, existingName.lastIndexOf('.')) : existingName;

          if (existingStem === searchStem && existingStem.length > 3) {
            console.log(`Found existing download (stem match): gid=${dl.gid} status=${dl.status} file=${existingName}`);
            return {
              gid: dl.gid,
              path: file.path,
              completedLength: dl.completedLength || '0',
              status: dl.status
            };
          }
        }
      }
    }

  } catch (e) {
    console.log('findExistingDownload error:', e);
  }
  return null;
}

async function processDownload(downloadId) {
  const pending = pendingDownloads[downloadId];
  if (!pending) return;

  // Cancel and erase browser download
  try {
    await chrome.downloads.cancel(downloadId);
    await chrome.downloads.erase({id: downloadId});
  } catch (e) {
    // Download might already be cancelled
  }

  const filename = pending.filename || 'Unknown';
  const downloadUrl = pending.url;

  // Notification
  chrome.notifications.create(`dl-${downloadId}`, {
    type: 'basic',
    iconUrl: 'icon48.png',
    title: 'BR Download Manager',
    message: `Download dimulai: ${filename}\nDisarankan tunggu download selesai sebelum browsing lagi ya!`,
    priority: 2,
    requireInteraction: true
  });

  // Build headers
  const headers = {
    "User-Agent": navigator.userAgent,
    "Referer": pending.referrer
  };

  // Fetch cookies for download URL
  try {
    const cookies = await chrome.cookies.getAll({url: downloadUrl});
    if (cookies.length > 0) {
      headers["Cookie"] = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }
  } catch (e) {
    console.log("Cookie fetch error:", e);
  }

  // Also try original URL cookies if different (redirect case)
  if (pending.originalUrl && pending.originalUrl !== downloadUrl) {
    try {
      const origCookies = await chrome.cookies.getAll({url: pending.originalUrl});
      if (origCookies.length > 0 && !headers["Cookie"]) {
        headers["Cookie"] = origCookies.map(c => `${c.name}=${c.value}`).join('; ');
      }
    } catch (e) {}
  }

  // Build out filename (just the name, not full path)
  let outFilename = filename;
  let downloadDir = pending.downloadDir || null;

  // If we have a full path, split it
  if (outFilename && (outFilename.includes('/') || outFilename.includes('\\'))) {
    const parts = outFilename.replace(/\\/g, '/').split('/');
    outFilename = parts.pop();
    if (!downloadDir) downloadDir = parts.join('/');
  }

  // If filename is a hash, try to get a better name from original URL
  if (outFilename && /^[a-f0-9]{8,}(\.\w+)?$/i.test(outFilename)) {
    const originalName = extractFilename(pending.originalUrl);
    if (originalName) outFilename = originalName;
  }

  // Check aria2 for existing partial download with same filename
  let isResume = false;
  const existing = await findExistingDownload(outFilename);
  if (existing) {
    const completedMB = Math.round((parseInt(existing.completedLength) || 0) / 1024 / 1024);
    console.log(`Found existing download ${existing.gid} for ${outFilename} (${completedMB}MB completed, status: ${existing.status}) - resuming`);

    // Remove old entry so we can re-add with same path
    try { await aria2Call('aria2.removeDownloadResult', [existing.gid]); } catch (e) {}
    try { await aria2Call('aria2.forceRemove', [existing.gid]); } catch (e) {}

    isResume = true;

    // Notify user about resume
    chrome.notifications.create(`resume-${downloadId}`, {
      type: 'basic',
      iconUrl: 'icon48.png',
      title: 'BR Download Manager',
      message: `Melanjutkan download: ${outFilename}\nDari ${completedMB}MB yang sudah terdownload.`,
      priority: 2
    });
  }

  console.log(`Sending to native host: url=${downloadUrl}, file=${outFilename}, dir=${downloadDir}, resume=${isResume}`);

  sendToNativeHost({
    url: downloadUrl,
    filename: outFilename,
    dir: downloadDir,
    headers: headers,
    is_resume: isResume
  });

  // Cleanup
  delete pendingDownloads[downloadId];
}

// Send message to native host and handle response
function sendToNativeHost(message) {
  const port = chrome.runtime.connectNative('com.br.download.manager');

  port.onMessage.addListener((response) => {
    console.log("Response from Rust:", response);
    if (response.gid) {
      downloadGids.add(response.gid);
      chrome.storage.local.set({downloadGids: Array.from(downloadGids)});
    }
    port.disconnect();
  });

  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) {
      console.error("Native Host Error:", chrome.runtime.lastError.message);
    }
  });

  port.postMessage(message);
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getDownloads') {
    fetchAria2Status().then(sendResponse);
    return true;
  }

  if (request.action === 'openFile') {
    const port = chrome.runtime.connectNative('com.br.download.manager');

    port.onMessage.addListener((response) => {
      console.log("Open file response:", response);
      sendResponse(response);
      port.disconnect();
    });

    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        sendResponse({status: 'error', message: chrome.runtime.lastError.message});
      }
    });

    port.postMessage({
      action: 'openFile',
      path: request.path
    });
    return true;
  }

  if (request.action === 'controlDownload') {
    const port = chrome.runtime.connectNative('com.br.download.manager');

    port.onMessage.addListener((response) => {
      console.log("Control response:", response);
      sendResponse(response);
      port.disconnect();
    });

    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        sendResponse({status: 'error', message: chrome.runtime.lastError.message});
      }
    });

    port.postMessage({
      action: request.command,
      gid: request.gid
    });
    return true;
  }

  if (request.action === 'getActiveCount') {
    fetchAria2Status().then(data => {
      const count = data.active ? data.active.length : 0;
      sendResponse({count});
    });
    return true;
  }
});

const ARIA2_RPC = 'http://127.0.0.1:6800/jsonrpc';

async function aria2Call(method, params = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(ARIA2_RPC, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 'br', method, params}),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const json = await res.json();
    return json.result || [];
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

async function fetchAria2Status() {
  try {
    const [active, waiting, stopped] = await Promise.all([
      aria2Call('aria2.tellActive'),
      aria2Call('aria2.tellWaiting', [0, 100]),
      aria2Call('aria2.tellStopped', [0, 50])
    ]);

    manageTabDiscard(active.length > 0);

    return {active, waiting, stopped};
  } catch (e) {
    const msg = e.name === 'AbortError'
      ? 'Timeout - aria2 tidak merespons dalam 3 detik'
      : 'Gagal konek ke aria2 di 127.0.0.1:6800 - ' + e.message;
    return {error: msg, active: [], waiting: [], stopped: []};
  }
}

// Discard browser tabs when download is active to free network bandwidth
async function manageTabDiscard(hasActiveDownloads) {
  if (hasActiveDownloads && !tabDiscarded) {
    try {
      const tabs = await chrome.tabs.query({});
      discardedTabIds = [];

      for (const tab of tabs) {
        if (tab.active || tab.pinned || tab.discarded) continue;
        if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://'))) continue;

        try {
          await chrome.tabs.discard(tab.id);
          discardedTabIds.push(tab.id);
        } catch (e) {
          // Tab might not be discardable
        }
      }
      tabDiscarded = true;
      const count = discardedTabIds.length;
      console.log(`Discarded ${count} tabs to free network for download`);
      if (count > 0) {
        chrome.notifications.create('tabs-discarded', {
          type: 'basic',
          iconUrl: 'icon48.png',
          title: 'BR Download Manager',
          message: `${count} tab diistirahatkan sementara untuk fokus bandwidth download.\nTab akan dikembalikan otomatis setelah download selesai.`,
          priority: 1
        });
      }
    } catch (e) {
      console.error("Tab discard error:", e);
    }
  } else if (!hasActiveDownloads && tabDiscarded) {
    for (const tabId of discardedTabIds) {
      try {
        await chrome.tabs.reload(tabId);
      } catch (e) {
        // Tab might have been closed already
      }
    }
    const count = discardedTabIds.length;
    console.log(`Restored ${count} tabs after download`);
    if (count > 0) {
      chrome.notifications.create('tabs-restored', {
        type: 'basic',
        iconUrl: 'icon48.png',
        title: 'BR Download Manager',
        message: `Download selesai! ${count} tab sudah dikembalikan.`,
        priority: 1
      });
    }
    discardedTabIds = [];
    tabDiscarded = false;
  }
}

// Restore GIDs from storage on startup
chrome.storage.local.get('downloadGids', (data) => {
  if (data.downloadGids) {
    downloadGids = new Set(data.downloadGids);
  }
});
