use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{self, Read, Write};
use std::time::Duration;
use tokio;
use reqwest;

#[derive(Deserialize, Serialize, Debug)]
struct DownloadMessage {
    #[serde(default)]
    url: String,
    filename: Option<String>,
    dir: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    action: Option<String>,
    gid: Option<String>,
    path: Option<String>,
    #[serde(default)]
    is_retry: bool,
    #[serde(default)]
    is_resume: bool,
    #[serde(default)]
    overwrite: bool,
}

#[derive(Serialize)]
struct ResponseMessage {
    status: String,
    message: String,
    gid: Option<String>,
}

const ARIA2_RPC: &str = "http://127.0.0.1:6800/jsonrpc";
const ARIA2_VERSION: &str = "1.37.0";

/// Cek apakah aria2c tersedia di PATH
fn is_aria2_installed() -> bool {
    std::process::Command::new("aria2c")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
}

/// Install aria2c secara otomatis sesuai OS
async fn install_aria2() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "windows")]
    {
        install_aria2_windows().await
    }
    #[cfg(target_os = "linux")]
    {
        install_aria2_linux().await
    }
    #[cfg(target_os = "macos")]
    {
        install_aria2_macos().await
    }
}

#[cfg(target_os = "windows")]
async fn install_aria2_windows() -> Result<(), Box<dyn std::error::Error>> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Coba winget dulu
    let winget = std::process::Command::new("winget")
        .args(["install", "--id", "aria2.aria2", "--accept-package-agreements", "--accept-source-agreements", "--silent"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    if let Ok(out) = winget {
        if out.status.success() {
            return Ok(());
        }
    }

    // Fallback: download dari GitHub
    let url = format!(
        "https://github.com/aria2/aria2/releases/download/release-{}/aria2-{}-win-64bit-build1.zip",
        ARIA2_VERSION, ARIA2_VERSION
    );

    let client = reqwest::Client::new();
    let resp = client.get(&url).send().await?;

    if !resp.status().is_success() {
        return Err(format!("Download aria2 gagal: HTTP {}", resp.status()).into());
    }

    let bytes = resp.bytes().await?;
    let exe_dir = std::env::current_exe()?
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .to_path_buf();
    let zip_path = exe_dir.join("aria2.zip");

    std::fs::write(&zip_path, &bytes)?;

    // Extract zip
    std::process::Command::new("powershell")
        .args([
            "-Command",
            &format!(
                "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                zip_path.display(),
                exe_dir.display()
            ),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;

    // Move aria2c.exe ke folder yang sama
    let extracted_dir = exe_dir.join(format!("aria2-{}-win-64bit-build1", ARIA2_VERSION));
    let src = extracted_dir.join("aria2c.exe");
    let dst = exe_dir.join("aria2c.exe");
    if src.exists() {
        let _ = std::fs::copy(&src, &dst);
    }

    // Cleanup
    let _ = std::fs::remove_file(&zip_path);
    let _ = std::fs::remove_dir_all(&extracted_dir);

    if dst.exists() {
        // Tambah ke PATH untuk session ini
        if let Ok(path) = std::env::var("PATH") {
            let new_path = format!("{};{}", exe_dir.display(), path);
            unsafe { std::env::set_var("PATH", &new_path); }
        }
        Ok(())
    } else {
        Err("Gagal install aria2c".into())
    }
}

#[cfg(target_os = "linux")]
async fn install_aria2_linux() -> Result<(), Box<dyn std::error::Error>> {
    // Coba berbagai package manager
    let managers: Vec<(&str, Vec<&str>)> = vec![
        ("apt-get", vec!["sudo", "apt-get", "install", "-y", "aria2"]),
        ("dnf", vec!["sudo", "dnf", "install", "-y", "aria2"]),
        ("pacman", vec!["sudo", "pacman", "-S", "--noconfirm", "aria2"]),
        ("yum", vec!["sudo", "yum", "install", "-y", "aria2"]),
    ];

    for (name, args) in &managers {
        // Cek apakah package manager ada
        if std::process::Command::new(name)
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok()
        {
            let status = std::process::Command::new(args[0])
                .args(&args[1..])
                .status();
            if status.is_ok() && status.unwrap().success() {
                return Ok(());
            }
        }
    }

    Err("Tidak bisa install aria2. Install manual: sudo apt install aria2".into())
}

#[cfg(target_os = "macos")]
async fn install_aria2_macos() -> Result<(), Box<dyn std::error::Error>> {
    // Coba brew dulu
    let brew = std::process::Command::new("brew")
        .args(["install", "aria2"])
        .status();

    if brew.is_ok() && brew.unwrap().success() {
        return Ok(());
    }

    Err("Tidak bisa install aria2. Install manual: brew install aria2".into())
}

async fn is_aria2_running() -> bool {
    let client = reqwest::Client::new();
    let payload = json!({
        "jsonrpc": "2.0",
        "id": "ping",
        "method": "aria2.getVersion",
        "params": []
    });
    matches!(
        client.post(ARIA2_RPC)
            .timeout(Duration::from_secs(2))
            .json(&payload)
            .send()
            .await,
        Ok(resp) if resp.status().is_success()
    )
}

async fn apply_aria2_config() {
    let _ = aria2_call("aria2.changeGlobalOption", json!([{
        "max-concurrent-downloads": "16",
        "split": "16",
        "min-split-size": "1M",
        "max-connection-per-server": "16",
        "continue": "true"
    }])).await;
}

async fn ensure_aria2_running() {
    if is_aria2_running().await {
        apply_aria2_config().await;
        return;
    }

    // Auto-install jika tidak ada di PATH
    if !is_aria2_installed() {
        let _ = install_aria2().await;
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("aria2c")
            .args([
                "--enable-rpc",
                "--rpc-listen-all",
                "--daemon=true",
                "--max-concurrent-downloads=16",
                "--split=16",
                "--min-split-size=1M",
                "--max-connection-per-server=16",
                "--continue=true",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("aria2c")
            .args([
                "--enable-rpc",
                "--rpc-listen-all",
                "--daemon=true",
                "--max-concurrent-downloads=16",
                "--split=16",
                "--min-split-size=1M",
                "--max-connection-per-server=16",
                "--continue=true",
            ])
            .spawn();
    }

    for _ in 0..10 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if is_aria2_running().await {
            return;
        }
    }
}

async fn aria2_call(method: &str, params: serde_json::Value) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    let payload = json!({
        "jsonrpc": "2.0",
        "id": "br",
        "method": method,
        "params": params
    });
    let res = client.post(ARIA2_RPC)
        .json(&payload)
        .send()
        .await?;
    let body: serde_json::Value = res.json().await?;
    if let Some(err) = body.get("error") {
        return Err(format!("aria2 error: {}", err).into());
    }
    Ok(body.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

fn open_file(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()?;
    }
    Ok(())
}

/// Check if a partial .aria2 control file exists for a given file
/// aria2 creates file.aria2 control files for partial downloads
fn has_aria2_control_file(dir: &str, filename: &str) -> bool {
    let path = std::path::Path::new(dir).join(format!("{}.aria2", filename));
    path.exists()
}

/// Find existing numbered variant on disk: file (1).zip, file (2).zip, etc.
/// Returns the variant name if found and has a partial .aria2 control file
fn find_numbered_variant(dir: &str, filename: &str) -> Option<String> {
    let (stem, ext) = if let Some(dot_pos) = filename.rfind('.') {
        (&filename[..dot_pos], &filename[dot_pos..])
    } else {
        (filename, "")
    };

    // Check the base file first
    if has_aria2_control_file(dir, filename) {
        return Some(filename.to_string());
    }

    // Check numbered variants: (1), (2), ... (999)
    for i in 1..1000 {
        let variant = format!("{} ({}){}", stem, i, ext);
        if has_aria2_control_file(dir, &variant) {
            return Some(variant);
        }
    }

    None
}

/// Generate unique filename if file already exists
/// file.zip -> file (1).zip -> file (2).zip
fn unique_filename(dir: &str, filename: &str) -> String {
    let path = std::path::Path::new(dir).join(filename);
    if !path.exists() {
        return filename.to_string();
    }

    let (stem, ext) = if let Some(dot_pos) = filename.rfind('.') {
        (&filename[..dot_pos], &filename[dot_pos..])
    } else {
        (filename, "")
    };

    for i in 1..1000 {
        let new_name = format!("{} ({}){}", stem, i, ext);
        let new_path = std::path::Path::new(dir).join(&new_name);
        if !new_path.exists() {
            return new_name;
        }
    }

    filename.to_string()
}

async fn add_to_aria2(msg: DownloadMessage) -> Result<String, Box<dyn std::error::Error>> {
    ensure_aria2_running().await;

    let mut options = serde_json::Map::new();

    // Resolve unique filename
    if let Some(filename) = msg.filename {
        let dir = msg.dir.as_deref().unwrap_or(".");
        let out_name = if msg.is_retry || msg.is_resume {
            // Resume/retry: reuse same file
            if let Some(variant) = find_numbered_variant(dir, &filename) {
                options.insert("continue".to_string(), json!("true"));
                options.insert("allow-overwrite".to_string(), json!("true"));
                variant
            } else if msg.is_retry {
                filename.clone()
            } else {
                options.insert("continue".to_string(), json!("true"));
                options.insert("allow-overwrite".to_string(), json!("true"));
                filename.clone()
            }
        } else if msg.overwrite {
            // Overwrite: use same filename, aria2 will overwrite existing file
            options.insert("allow-overwrite".to_string(), json!("true"));
            filename.clone()
        } else {
            unique_filename(dir, &filename)
        };
        options.insert("out".to_string(), json!(out_name));
    }
    if let Some(dir) = msg.dir {
        options.insert("dir".to_string(), json!(dir));
    }
    if let Some(headers) = msg.headers {
        let header_list: Vec<String> = headers
            .into_iter()
            .map(|(k, v)| format!("{}: {}", k, v))
            .collect();
        options.insert("header".to_string(), json!(header_list));
    }

    let result = aria2_call(
        "aria2.addUri",
        json!([[msg.url], options])
    ).await?;

    let gid = result.as_str().unwrap_or("").to_string();
    Ok(gid)
}

async fn handle_action(action: &str, gid: &str) -> Result<String, Box<dyn std::error::Error>> {
    match action {
        "pause" => {
            aria2_call("aria2.pause", json!([gid])).await?;
            Ok("Paused".to_string())
        }
        "unpause" => {
            aria2_call("aria2.unpause", json!([gid])).await?;
            Ok("Resumed".to_string())
        }
        "cancel" => {
            aria2_call("aria2.forceRemove", json!([gid])).await?;
            Ok("Cancelled".to_string())
        }
        "retry" => {
            // Get original download info: URL + file path
            let info = aria2_call("aria2.getFiles", json!([gid])).await?;
            let mut url = String::new();
            let mut out_path = String::new();

            if let Some(files) = info.as_array() {
                if let Some(file) = files.first() {
                    // Get URL
                    if let Some(uris) = file.get("uris") {
                        if let Some(uri_arr) = uris.as_array() {
                            if let Some(uri) = uri_arr.first() {
                                url = uri.get("uri").and_then(|u| u.as_str()).unwrap_or("").to_string();
                            }
                        }
                    }
                    // Get original file path for resume
                    if let Some(path) = file.get("path").and_then(|p| p.as_str()) {
                        out_path = path.to_string();
                    }
                }
            }

            if url.is_empty() {
                return Err("Cannot find original URL for retry".into());
            }

            // Remove old result but keep the partial file on disk
            let _ = aria2_call("aria2.removeDownloadResult", json!([gid])).await;

            // Re-add with same output path so aria2 can resume via .aria2 control file
            let mut options = serde_json::Map::new();
            if !out_path.is_empty() {
                options.insert("out".to_string(), json!(out_path));
            }
            // Force continue/resume
            options.insert("continue".to_string(), json!("true"));
            options.insert("allow-overwrite".to_string(), json!("true"));

            let new_gid = aria2_call("aria2.addUri", json!([[url], options])).await?;
            Ok(new_gid.as_str().unwrap_or("").to_string())
        }
        _ => Err(format!("Unknown action: {}", action).into())
    }
}

fn send_response(status: &str, message: &str, gid: Option<String>) {
    let resp = ResponseMessage {
        status: status.to_string(),
        message: message.to_string(),
        gid,
    };
    let resp_str = serde_json::to_string(&resp).unwrap();
    let len = resp_str.len() as u32;

    let mut stdout = io::stdout();
    let _ = stdout.write_all(&len.to_ne_bytes());
    let _ = stdout.write_all(resp_str.as_bytes());
    let _ = stdout.flush();
}

#[tokio::main]
async fn main() -> io::Result<()> {
    loop {
        let mut length_buf = [0u8; 4];
        if io::stdin().read_exact(&mut length_buf).is_err() {
            break;
        }
        let length = u32::from_ne_bytes(length_buf) as usize;

        let mut msg_buf = vec![0u8; length];
        if io::stdin().read_exact(&mut msg_buf).is_err() {
            break;
        }

        let msg_str = String::from_utf8_lossy(&msg_buf);
        let msg: DownloadMessage = match serde_json::from_str(&msg_str) {
            Ok(m) => m,
            Err(_) => {
                send_response("error", "Invalid JSON format", None);
                continue;
            }
        };

        // Handle action (pause/cancel/retry/unpause/openFile)
        if let Some(ref action) = msg.action {
            // Handle openFile
            if action == "openFile" {
                if let Some(ref path) = msg.path {
                    match open_file(path) {
                        Ok(_) => send_response("success", "Opened", None),
                        Err(e) => send_response("error", &format!("Open error: {}", e), None),
                    }
                    continue;
                }
            }

            if let Some(ref gid) = msg.gid {
                match handle_action(action, gid).await {
                    Ok(result) => {
                        let response_gid = if action == "retry" { Some(result.clone()) } else { None };
                        send_response("success", &result, response_gid);
                    }
                    Err(e) => send_response("error", &format!("Action error: {}", e), None),
                }
                continue;
            }
        }

        // Handle new download
        match add_to_aria2(msg).await {
            Ok(gid) => send_response("success", "Added to aria2", Some(gid)),
            Err(e) => send_response("error", &format!("RPC Error: {}", e), None),
        }
    }
    Ok(())
}
