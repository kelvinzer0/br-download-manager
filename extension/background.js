// Track active downloads with GID
let downloadGids = new Set();
let discardedTabIds = [];
let tabDiscarded = false;

chrome.downloads.onCreated.addListener(async (downloadItem) => {
  if (downloadItem.state !== 'in_progress') return;

  chrome.downloads.cancel(downloadItem.id);
  chrome.downloads.erase({id: downloadItem.id});

  // Use finalUrl (after redirect) if available, fallback to url
  const downloadUrl = downloadItem.finalUrl || downloadItem.url;
  const filename = downloadItem.filename || downloadUrl.split('/').split('?')[0].pop() || 'Unknown';

  chrome.notifications.create(`dl-${downloadItem.id}`, {
    type: 'basic',
    iconUrl: 'icon48.png',
    title: 'BR Download Manager',
    message: `Download dimulai: ${filename}\nDisarankan tunggu download selesai sebelum browsing lagi ya!`,
    priority: 2,
    requireInteraction: true
  });

  // Extract download directory and filename from browser's save path
  let downloadDir = null;
  let outFilename = null;
  if (downloadItem.filename) {
    const parts = downloadItem.filename.replace(/\\/g, '/').split('/');
    outFilename = parts.pop();
    downloadDir = parts.join('/');
  }

  // Fetch cookies for the download URL
  const headers = {
    "User-Agent": navigator.userAgent,
    "Referer": downloadItem.referrer || ""
  };

  try {
    const cookies = await chrome.cookies.getAll({url: downloadUrl});
    if (cookies.length > 0) {
      headers["Cookie"] = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }
  } catch (e) {
    console.log("Cookie fetch error:", e);
  }

  // Also try original URL cookies if different (redirect case)
  if (downloadItem.url && downloadItem.url !== downloadUrl) {
    try {
      const origCookies = await chrome.cookies.getAll({url: downloadItem.url});
      if (origCookies.length > 0 && !headers["Cookie"]) {
        headers["Cookie"] = origCookies.map(c => `${c.name}=${c.value}`).join('; ');
      }
    } catch (e) {}
  }

  sendToNativeHost({
    url: downloadUrl,
    filename: outFilename,
    dir: downloadDir,
    headers: headers
  });
});

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

  if (request.action === 'controlDownload') {
    // Forward pause/cancel/retry/unpause to native host
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

    // Update tab discard based on active downloads
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
    // Restore all discarded tabs by reloading
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
