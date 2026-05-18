# 🚀 BR Download Manager

High-performance, cross-platform download manager bridge for **aria2**, built with **Rust** and **Native Messaging**.

Automatically intercepts browser downloads, forwards them to `aria2` with **16-channel multi-threaded downloading**, and manages browser tabs for optimal bandwidth.

## ✨ Features

- **Auto-Start aria2:** Rust native host automatically starts `aria2c` daemon if not running - no manual setup needed.
- **16-Channel Downloads:** Configured with `--max-concurrent-downloads=16 --split=16 --max-connection-per-server=16` for blazing fast speeds.
- **Download Notifications:** Notification popup when download starts, with suggestion to wait before browsing.
- **Progress Popup:** Click the extension icon to see real-time download progress with speed, ETA, and progress bars.
- **Download Control:** Pause, Resume, Cancel, and Retry downloads directly from the popup.
- **Tab Management:** Automatically discards background browser tabs during active downloads to free bandwidth for the 16 channels. Tabs are restored automatically when downloads finish.
- **Header & Cookie Support:** Forwards User-Agent and Referer headers for authenticated site downloads.
- **Cross-Platform:** Supports Windows, Linux, and macOS.
- **Fixed Extension ID:** No manual configuration needed for `allowed_origins`.

## 🛠️ Requirements

- [aria2](https://aria2.github.io/) (auto-started by the native host, or run manually)
- Chrome or Edge Browser

## 📥 Installation

### 1. Download the Binary
Go to the [Releases](https://github.com/kelvinzer0/br-download-manager/releases) page and download the version for your OS.

### 2. Install Native Host (Windows)
1. Extract the downloaded files to a permanent folder.
2. Right-click `install.ps1` and select **Run with PowerShell**.
3. This will register the Native Messaging host in your Windows Registry.

### 3. Load the Extension
1. Open Chrome/Edge and go to `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `extension` folder from this repository.
4. The Extension ID is fixed to: `obbofbgglodjehllcnfggbmjhpcphlbl`.

> **Note:** You do NOT need to manually run `aria2c`. The native host will start it automatically when a download is detected.

## 🚀 Usage

### Downloading
Simply click any download link in your browser. The extension will:
1. Detect the new download and cancel the browser's internal download.
2. Show a notification: *"Download dimulai: [filename]. Disarankan tunggu download selesai sebelum browsing lagi ya!"*
3. Auto-start `aria2c` if not running (with 16-channel config).
4. Send the URL and metadata to the Rust Native Host.
5. Discard background browser tabs to free bandwidth.
6. Forward the download to `aria2` with 16 parallel connections.

### Extension Popup
Click the extension icon in the toolbar to open the popup:
- **Active tab:** Shows currently downloading files with progress bar, speed (MB/s), and ETA.
- **Waiting tab:** Shows queued downloads.
- **Completed tab:** Shows finished/errored downloads.
- **Per-download buttons:**
  - `Pause` / `Resume` - pause and resume downloads
  - `Cancel` - cancel download
  - `Retry` - retry failed/cancelled downloads

### Tab Management
When a download starts:
- Background browser tabs are automatically **discarded** (suspended) to free network bandwidth.
- A notification tells you how many tabs were suspended.
- When all downloads finish/pause/cancel, tabs are **automatically restored** with a notification.

## 📊 Monitoring

### Via Extension Popup (Recommended)
Click the extension icon for real-time progress with speed, ETA, and progress bars.

### Via AriaNg Web UI
Use [AriaNg](https://github.com/mayswind/AriaNg) for an advanced web dashboard. Open the AriaNg page and it will connect to your local `aria2` automatically.

### Download Directory
By default, files are saved in the **folder where `aria2c` was started**.
To specify a custom download folder, create a file `aria2.conf` with:
```
dir=C:\Downloads
```
Or the native host can be configured to pass `--dir` when starting `aria2c`.

## 🏗️ Development

### Build from source
```bash
# Build the Rust Host
cargo build --release

# Binary will be at target/release/br-download-manager-rs.exe
```

### Install (Windows)
```bash
# Copy binary to expected name
cp target/release/br-download-manager-rs.exe br-dl-windows.exe

# Register native host in Windows Registry
powershell -ExecutionPolicy Bypass -File install.ps1
```

### aria2 Config (auto-applied by native host)
```
--enable-rpc --rpc-listen-all
--max-concurrent-downloads=16
--split=16
--min-split-size=1M
--max-connection-per-server=16
--continue=true
```

## 📜 License

MIT
