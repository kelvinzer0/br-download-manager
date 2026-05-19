// Track active downloads with GID
let downloadGids = new Set();
let discardedTabIds = [];
let tabDiscarded = false;
// Track pending downloads waiting for filename
let pendingDownloads = {};
// Resume dialog state
let resumeDialogPending = null;

// Extract meaningful filename from URL, skip hash-like names
function extractFilename(url) {
  try {
    const urlPath = new URL(url).pathname;
    const segments = urlPath.split('/').filter(s => s.length > 0);
    const last = segments[segments.length - 1] || '';
    const name = last.split('?')[0];
    if (/^[a-f0-9]{8,}(\.\w+)?$/i.test(name)) return null;
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
  if (!filename) filename = extractFilename(downloadItem.url);
  if (!filename) filename = extractFilename(downloadUrl);
  if (filename && /^[a-f0-9]{8,}(\.\w+)?$/i.test(filename)) {
    const originalName = extractFilename(downloadItem.url);
    if (originalName) filename = originalName;
  }

  pendingDownloads[downloadId] = {
    url: downloadUrl,
    originalUrl: downloadItem.url,
    filename: filename,
    referrer: downloadItem.referrer || '',
    queued: Date.now()
  };

  // If filename is empty, wait for onChanged
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
      const fullPath = delta.filename.current;
      const parts = fullPath.replace(/\\/g, '/').split('/');
      pendingDownloads[downloadId].filename = parts.pop();
      pendingDownloads[downloadId].downloadDir = parts.join('/');
      console.log(`Filename resolved: ${pendingDownloads[downloadId].filename}`);
      await processDownload(downloadId);
    }
  }
});

// Fetch ALL failed/errored downloads from aria2
async function getAllFailedDownloads() {
  try {
    const stopped = await aria2Call('aria2.tellStopped', [0, 500]);
    console.log('aria2 tellStopped response:', stopped);
    if (!stopped || !Array.isArray(stopped)) {
      console.log('No stopped downloads or invalid response');
      return [];
    }
    const failed = stopped.filter(dl => dl.status === 'error' || dl.status === 'removed');
    console.log(`Found ${failed.length} failed/removed downloads out of ${stopped.length} stopped`);
    return failed.map(dl => {
      const path = dl.files && dl.files[0] ? (dl.files[0].path || '') : '';
      const filename = path ? path.replace(/\\/g, '/').split('/').pop() : 'Unknown';
      return {
        gid: dl.gid,
        filename: filename || 'Unknown',
        completedLength: dl.completedLength || '0',
        totalLength: dl.totalLength || '0',
        status: dl.status
      };
    });
  } catch (e) {
    console.error('getAllFailedDownloads error:', e);
    return [];
  }
}

async function processDownload(downloadId) {
  const pending = pendingDownloads[downloadId];
  if (!pending) return;

  // Cancel and erase browser download
  try {
    await chrome.downloads.cancel(downloadId);
    await chrome.downloads.erase({id: downloadId});
  } catch (e) {}

  const filename = pending.filename || 'Unknown';
  const downloadUrl = pending.url;

  // Build headers
  const headers = {
    "User-Agent": navigator.userAgent,
    "Referer": pending.referrer
  };

  // Fetch cookies
  try {
    const cookies = await chrome.cookies.getAll({url: downloadUrl});
    if (cookies.length > 0) {
      headers["Cookie"] = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }
  } catch (e) {}

  if (pending.originalUrl && pending.originalUrl !== downloadUrl) {
    try {
      const origCookies = await chrome.cookies.getAll({url: pending.originalUrl});
      if (origCookies.length > 0 && !headers["Cookie"]) {
        headers["Cookie"] = origCookies.map(c => `${c.name}=${c.value}`).join('; ');
      }
    } catch (e) {}
  }

  // Extract filename and dir
  let outFilename = filename;
  let downloadDir = pending.downloadDir || null;
  if (outFilename && (outFilename.includes('/') || outFilename.includes('\\'))) {
    const parts = outFilename.replace(/\\/g, '/').split('/');
    outFilename = parts.pop();
    if (!downloadDir) downloadDir = parts.join('/');
  }
  if (outFilename && /^[a-f0-9]{8,}(\.\w+)?$/i.test(outFilename)) {
    const originalName = extractFilename(pending.originalUrl);
    if (originalName) outFilename = originalName;
  }

  // Check for ANY failed downloads in aria2
  const failedDownloads = await getAllFailedDownloads();

  if (failedDownloads.length > 0) {
    // Show dialog with ALL failed downloads
    console.log(`Found ${failedDownloads.length} failed downloads - showing dialog`);

    resumeDialogPending = {
      downloadId,
      url: downloadUrl,
      filename: outFilename,
      dir: downloadDir,
      headers
    };

    // Pass data via storage so dialog can read it without fetch
    chrome.storage.local.set({resumeDialogData: {
      failed: failedDownloads,
      newFile: outFilename || ''
    }}, () => {
      const dialogUrl = chrome.runtime.getURL('resume-dialog.html');
      chrome.windows.create({
        url: dialogUrl,
        type: 'popup',
        width: 420,
        height: 350,
        focused: true
      });
    });

    delete pendingDownloads[downloadId];
    return;
  }

  // No failed downloads - send directly
  console.log(`Sending to native host: url=${downloadUrl}, file=${outFilename}, dir=${downloadDir}`);
  sendToNativeHost({ url: downloadUrl, filename: outFilename, dir: downloadDir, headers, is_resume: false });
  delete pendingDownloads[downloadId];
}

// Handle resume dialog choice
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'resumeChoice' && resumeDialogPending) {
    const pending = resumeDialogPending;
    resumeDialogPending = null;

    if (request.choice === 'resume' && request.gid) {
      // Get the failed download's file info for resume
      aria2Call('aria2.getFiles', [request.gid]).then(files => {
        const filePath = files && files[0] ? files[0].path : null;

        // Remove old entry
        aria2Call('aria2.removeDownloadResult', [request.gid]).catch(() => {});
        aria2Call('aria2.forceRemove', [request.gid]).catch(() => {});

        sendToNativeHost({
          url: pending.url,
          filename: filePath || pending.filename,
          dir: pending.dir,
          headers: pending.headers,
          is_resume: true
        });
      }).catch(() => {
        // Fallback: just send with resume flag
        aria2Call('aria2.removeDownloadResult', [request.gid]).catch(() => {});
        sendToNativeHost({ url: pending.url, filename: pending.filename, dir: pending.dir, headers: pending.headers, is_resume: true });
      });
    } else {
      // New download - proceed normally
      sendToNativeHost({ url: pending.url, filename: pending.filename, dir: pending.dir, headers: pending.headers, is_resume: false });
    }
    return;
  }

  if (request.action === 'getDownloads') {
    fetchAria2Status().then(sendResponse);
    return true;
  }

  if (request.action === 'openFile') {
    const port = chrome.runtime.connectNative('com.br.download.manager');
    port.onMessage.addListener((response) => { sendResponse(response); port.disconnect(); });
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) sendResponse({status: 'error', message: chrome.runtime.lastError.message});
    });
    port.postMessage({ action: 'openFile', path: request.path });
    return true;
  }

  if (request.action === 'controlDownload') {
    const port = chrome.runtime.connectNative('com.br.download.manager');
    port.onMessage.addListener((response) => { sendResponse(response); port.disconnect(); });
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) sendResponse({status: 'error', message: chrome.runtime.lastError.message});
    });
    port.postMessage({ action: request.command, gid: request.gid });
    return true;
  }

  if (request.action === 'getActiveCount') {
    fetchAria2Status().then(data => sendResponse({count: data.active ? data.active.length : 0}));
    return true;
  }
});

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
    if (chrome.runtime.lastError) console.error("Native Host Error:", chrome.runtime.lastError.message);
  });
  port.postMessage(message);
}

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
        } catch (e) {}
      }
      tabDiscarded = true;
      const count = discardedTabIds.length;
      if (count > 0) {
        chrome.notifications.create('tabs-discarded', {
          type: 'basic', iconUrl: 'icon48.png', title: 'BR Download Manager',
          message: `${count} tab diistirahatkan sementara untuk fokus bandwidth download.`,
          priority: 1
        });
      }
    } catch (e) {}
  } else if (!hasActiveDownloads && tabDiscarded) {
    for (const tabId of discardedTabIds) {
      try { await chrome.tabs.reload(tabId); } catch (e) {}
    }
    const count = discardedTabIds.length;
    if (count > 0) {
      chrome.notifications.create('tabs-restored', {
        type: 'basic', iconUrl: 'icon48.png', title: 'BR Download Manager',
        message: `Download selesai! ${count} tab sudah dikembalikan.`,
        priority: 1
      });
    }
    discardedTabIds = [];
    tabDiscarded = false;
  }
}

chrome.storage.local.get('downloadGids', (data) => {
  if (data.downloadGids) downloadGids = new Set(data.downloadGids);
});
