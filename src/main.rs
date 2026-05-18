use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{self, Read, Write};
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

async fn add_to_aria2(msg: DownloadMessage) -> Result<String, Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    let rpc_url = "http://localhost:6800/jsonrpc";

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

    let res = client.post(rpc_url)
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
