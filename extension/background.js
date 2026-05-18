chrome.downloads.onCreated.addListener((downloadItem) => {
  // Abaikan jika download sudah selesai atau dibatalkan (keamanan)
  if (downloadItem.state !== 'in_progress') return;

  // Batalkan download bawaan browser
  chrome.downloads.cancel(downloadItem.id);
  chrome.downloads.erase({id: downloadItem.id});

  console.log("Forwarding to Rust Host:", downloadItem.url);

  // Kirim ke Native Host Rust
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
