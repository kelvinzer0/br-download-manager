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
    headers: Option<std::collections::HashMap<String, String>>,
    action: Option<String>,
    gid: Option<String>,
}

#[derive(Serialize)]
struct ResponseMessage {
    status: String,
    message: String,
    gid: Option<String>,
}

const ARIA2_RPC: &str = "http://127.0.0.1:6800/jsonrpc";

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

async fn add_to_aria2(msg: DownloadMessage) -> Result<String, Box<dyn std::error::Error>> {
    ensure_aria2_running().await;

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
            let info = aria2_call("aria2.getFiles", json!([gid])).await?;
            let url = if let Some(files) = info.as_array() {
                if let Some(file) = files.first() {
                    if let Some(uris) = file.get("uris") {
                        if let Some(uri_arr) = uris.as_array() {
                            if let Some(uri) = uri_arr.first() {
                                uri.get("uri").and_then(|u| u.as_str()).unwrap_or("")
                            } else { "" }
                        } else { "" }
                    } else { "" }
                } else { "" }
            } else { "" };

            if url.is_empty() {
                return Err("Cannot find original URL for retry".into());
            }

            let _ = aria2_call("aria2.removeDownloadResult", json!([gid])).await;
            let new_gid = aria2_call("aria2.addUri", json!([[url]])).await?;
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

        // Handle action (pause/cancel/retry/unpause)
        if let Some(ref action) = msg.action {
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
