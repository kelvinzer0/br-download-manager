// Track active downloads for popup
let activeDownloads = [];

chrome.downloads.onCreated.addListener((downloadItem) => {
  if (downloadItem.state !== 'in_progress') return;

  // Cancel browser download
  chrome.downloads.cancel(downloadItem.id);
  chrome.downloads.erase({id: downloadItem.id});

  const filename = downloadItem.filename || downloadItem.url.split('/').pop() || 'Unknown';

  // Show notification
  chrome.notifications.create(`dl-${downloadItem.id}`, {
    type: 'basic',
    iconUrl: 'icon48.png',
    title: 'BR Download Manager',
    message: `Download dimulai: ${filename}\nDisarankan tunggu download selesai sebelum browsing lagi ya!`,
    priority: 2,
    requireInteraction: true
  });

  // Send to native host
  const port = chrome.runtime.connectNative('com.br.download.manager');

  port.postMessage({
    url: downloadItem.url,
    filename: downloadItem.filename || null,
    headers: {
      "User-Agent": navigator.userAgent,
      "Referer": downloadItem.referrer || ""
    }
  });

  port.onMessage.addListener((response) => {
    console.log("Response from Rust:", response);
    port.disconnect();
  });

  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) {
      console.error("Native Host Error:", chrome.runtime.lastError.message);
    }
  });
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getDownloads') {
    fetchAria2Status().then(sendResponse);
    return true; // async response
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
    return {active, waiting, stopped};
  } catch (e) {
    const msg = e.name === 'AbortError'
      ? 'Timeout - aria2 tidak merespons dalam 3 detik'
      : 'Gagal konek ke aria2 di 127.0.0.1:6800 - ' + e.message;
    return {error: msg, active: [], waiting: [], stopped: []};
  }
}
