use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{self, Read, Write};
use std::time::Duration;
use tokio;
use reqwest;

#[derive(Deserialize, Serialize, Debug)]
struct DownloadMessage {
    url: String,
    filename: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
}

#[derive(Serialize)]
struct ResponseMessage {
    status: String,
    message: String,
}

const ARIA2_RPC: &str = "http://127.0.0.1:6800/jsonrpc";

/// Cek apakah aria2 RPC sudah berjalan
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

/// Jalankan aria2c sebagai daemon jika belum running
async fn ensure_aria2_running() {
    if is_aria2_running().await {
        return;
    }

    // Spawn aria2c di background
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("aria2c")
            .args(["--enable-rpc", "--rpc-listen-all", "--daemon=true"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("aria2c")
            .args(["--enable-rpc", "--rpc-listen-all", "--daemon=true"])
            .spawn();
    }

    // Tunggu sampai aria2 siap (max 5 detik)
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if is_aria2_running().await {
            return;
        }
    }
}

async fn add_to_aria2(msg: DownloadMessage) -> Result<String, Box<dyn std::error::Error>> {
    // Pastikan aria2 berjalan
    ensure_aria2_running().await;

    let client = reqwest::Client::new();

    let mut options = serde_json::Map::new();
    if let Some(filename) = msg.filename {
        options.insert("out".to_string(), json!(filename));
    }
    
    if let Some(headers) = msg.headers {
        let header_list: Vec<String> = headers
            .into_iter()
            .map(|(k, v)| format!("{}: {}", k, v))
            .collect();
        options.insert("header".to_string(), json!(header_list));
    }

    let payload = json!({
        "jsonrpc": "2.0",
        "id": "br-dl",
        "method": "aria2.addUri",
        "params": [vec![msg.url], options]
    });

    let res = client.post(ARIA2_RPC)
        .json(&payload)
        .send()
        .await?;

    Ok(res.text().await?)
}

#[tokio::main]
async fn main() -> io::Result<()> {
    loop {
        // Baca 4 byte panjang pesan
        let mut length_buf = [0u8; 4];
        if io::stdin().read_exact(&mut length_buf).is_err() {
            break;
        }
        let length = u32::from_ne_bytes(length_buf) as usize;

        // Baca pesan JSON
        let mut msg_buf = vec![0u8; length];
        if io::stdin().read_exact(&mut msg_buf).is_err() {
            break;
        }

        let msg_str = String::from_utf8_lossy(&msg_buf);
        let msg: DownloadMessage = match serde_json::from_str(&msg_str) {
            Ok(m) => m,
            Err(_) => {
                send_response("error", "Invalid JSON format");
                continue;
            }
        };

        // Kirim ke aria2
        match add_to_aria2(msg).await {
            Ok(_) => send_response("success", "Added to aria2"),
            Err(e) => send_response("error", &format!("RPC Error: {}", e)),
        }
    }
    Ok(())
}

fn send_response(status: &str, message: &str) {
    let resp = ResponseMessage {
        status: status.to_string(),
        message: message.to_string(),
    };
    let resp_str = serde_json::to_string(&resp).unwrap();
    let len = resp_str.len() as u32;
    
    let mut stdout = io::stdout();
    let _ = stdout.write_all(&len.to_ne_bytes());
    let _ = stdout.write_all(resp_str.as_bytes());
    let _ = stdout.flush();
}
