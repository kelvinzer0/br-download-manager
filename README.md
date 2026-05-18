# 🚀 BR Download Manager

High-performance, cross-platform download manager bridge for **aria2**, built with **Rust** and **Native Messaging**.

This tool automatically intercepts browser downloads and forwards them to `aria2`, allowing for multi-threaded downloading, better management, and support for cookies/headers.

## ✨ Features

- **Blazing Fast:** Native Host built with Rust for minimal overhead.
- **aria2 Integration:** Uses the powerful `aria2c` engine for downloading.
- **Cross-Platform:** Supports Windows, Linux, and macOS.
- **Native Messaging:** Secure communication between Browser and Local Binary.
- **Header & Cookie Support:** Forwards metadata to ensure downloads from authenticated sites work perfectly.
- **Fixed Extension ID:** No manual configuration needed for `allowed_origins`.

## 🛠️ Requirements

- [aria2](https://aria2.github.io/) (Must be running with RPC enabled)
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

### 4. Run aria2
Make sure `aria2c` is running in the background:
```bash
aria2c --enable-rpc --rpc-listen-all
```

## 🚀 Usage

Once installed, simply click any download link in your browser. The extension will:
1. Detect the new download.
2. Cancel the browser's internal download.
3. Send the URL and metadata to the Rust Native Host.
4. The Rust Host will tell `aria2` to start the download.

## 🏗️ Development

If you want to build from source:

```bash
# Build the Rust Host
cargo build --release

# The binary will be at target/release/br-download-manager-rs.exe
```

## 📜 License

MIT
