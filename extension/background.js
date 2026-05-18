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

// Fetch download status from aria2 RPC
async function fetchAria2Status() {
  try {
    const res = await fetch('http://localhost:6800/jsonrpc', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'br-status',
        method: 'aria2.tellActive',
        params: []
      })
    });
    const active = await res.json();

    const resWaiting = await fetch('http://localhost:6800/jsonrpc', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'br-waiting',
        method: 'aria2.tellWaiting',
        params: [0, 100]
      })
    });
    const waiting = await resWaiting.json();

    const resStopped = await fetch('http://localhost:6800/jsonrpc', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'br-stopped',
        method: 'aria2.tellStopped',
        params: [0, 50]
      })
    });
    const stopped = await resStopped.json();

    return {
      active: active.result || [],
      waiting: waiting.result || [],
      stopped: stopped.result || []
    };
  } catch (e) {
    return {error: e.message, active: [], waiting: [], stopped: []};
  }
}
