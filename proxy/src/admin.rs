//! Admin panel: its own port, answers only direct requests from localhost / LAN.
//! The page talks to `/ws` (WebSocket) for live status and key management.

use crate::config::Config;
use crate::keys::{clean_label, ct_eq_str, now_ms};
use crate::net::{has_forward_headers, is_non_public};
use crate::proxy::requested_protocols;
use crate::state::Shared;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::time::Duration;

const PAGE: &str = include_str!("../admin/index.html");

pub fn router(st: Shared) -> Router {
    Router::new()
        .route("/", get(|| async { ([(header::CACHE_CONTROL, "no-store")], Html(PAGE)) }))
        .route("/ws", get(ws))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(middleware::from_fn(lan_only))
        .with_state(st)
}

/// 404 for anything that isn't a direct request from this machine or the local network.
async fn lan_only(ConnectInfo(peer): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    if !is_non_public(peer.ip()) || has_forward_headers(req.headers()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::X_FRAME_OPTIONS, "DENY".parse().unwrap());
    h.insert("referrer-policy", "no-referrer".parse().unwrap());
    res
}

async fn ws(
    ws: WebSocketUpgrade,
    State(st): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: axum::http::HeaderMap,
) -> Response {
    let cfg = st.cfg();
    let protos = requested_protocols(&headers);
    if !cfg.admin_token.is_empty() {
        let given = protos.iter().find_map(|p| p.strip_prefix("beacon-admin.")).unwrap_or("");
        if !ct_eq_str(given, &cfg.admin_token) {
            st.event("admin_denied", peer.ip(), "wrong admin token");
            return (StatusCode::UNAUTHORIZED, "wrong admin token").into_response();
        }
    }
    ws.protocols(["beacon-admin"]).on_upgrade(move |sock| session(sock, st, peer))
}

fn config_json(c: &Config) -> Value {
    let mut v = serde_json::to_value(c).unwrap();
    let o = v.as_object_mut().unwrap();
    o.remove("admin_token");
    o.insert("has_admin_token".into(), json!(!c.admin_token.is_empty()));
    v
}

fn status(st: &Shared) -> Value {
    let cfg = st.cfg();
    let c = &st.counters;
    let keys: Vec<Value> = {
        let mut ks = st.keys.lock().unwrap();
        ks.refresh();
        ks.list().iter().map(|k| k.public()).collect()
    };
    let conns = st.conn_snapshot();
    let live_up: u64 = conns.iter().map(|c| c.bytes_up).sum();
    let live_down: u64 = conns.iter().map(|c| c.bytes_down).sum();
    let mut events = st.events();
    events.truncate(80);
    json!({
        "t": "status",
        "version": env!("CARGO_PKG_VERSION"),
        "now": now_ms(),
        "started_at": st.started_at,
        "config": config_json(&cfg),
        "keys": keys,
        "conns": conns,
        "events": events,
        "blocked": st.blocked_ips().into_iter().map(|(ip, until)| json!({"ip": ip, "until": until})).collect::<Vec<_>>(),
        "counters": {
            "accepted": c.accepted.load(Ordering::Relaxed),
            "status_pings": c.status_pings.load(Ordering::Relaxed),
            "rejected_key": c.rejected_key.load(Ordering::Relaxed),
            "rejected_rate": c.rejected_rate.load(Ordering::Relaxed),
            "rejected_target": c.rejected_target.load(Ordering::Relaxed),
            "rejected_limit": c.rejected_limit.load(Ordering::Relaxed),
            "rejected_insecure": c.rejected_insecure.load(Ordering::Relaxed),
            "failed_connect": c.failed_connect.load(Ordering::Relaxed),
            "bytes_up": c.bytes_up.load(Ordering::Relaxed) + live_up,
            "bytes_down": c.bytes_down.load(Ordering::Relaxed) + live_down,
        }
    })
}

fn days_to_expiry(v: &Value) -> Option<u64> {
    let d = v.as_f64()?;
    Some(if d <= 0.0 { 0 } else { now_ms() + (d * 86_400_000.0) as u64 })
}

fn handle(st: &Shared, msg: &Value) -> Value {
    let op = msg["op"].as_str().unwrap_or("");
    let rid = msg.get("rid").cloned().unwrap_or(Value::Null);
    let ok = |m: &str| json!({"t":"ok","op":op,"rid":rid,"msg":m});
    let err = |m: &str| json!({"t":"error","op":op,"rid":rid,"msg":m});
    let id = msg["id"].as_str().unwrap_or("");
    match op {
        "create_key" => {
            let label = msg["label"].as_str().unwrap_or("");
            let expires = days_to_expiry(&msg["expires_days"]).unwrap_or(0);
            let max = msg["max_connections"].as_u64().unwrap_or(0) as usize;
            let (entry, key) = st.keys.lock().unwrap().create(label, expires, max);
            st.event("key_created", "admin", entry.label.clone());
            json!({"t":"key_created","rid":rid,"key":key,"entry":entry.public()})
        }
        "update_key" => {
            let mut disabled = false;
            let found = st.keys.lock().unwrap().update(id, |e| {
                if let Some(l) = msg["label"].as_str() {
                    e.label = clean_label(l, &e.label);
                }
                if let Some(en) = msg["enabled"].as_bool() {
                    e.enabled = en;
                    disabled = !en;
                }
                if let Some(x) = days_to_expiry(&msg["expires_days"]) {
                    e.expires_at = x;
                }
                if let Some(m) = msg["max_connections"].as_u64() {
                    e.max_connections = m as usize;
                }
            });
            if !found {
                return err("No such key.");
            }
            let mut kicked = 0;
            if disabled || !st.keys.lock().unwrap().is_usable(id) {
                kicked = st.kick_key(id, "Your key was disabled by the proxy owner.");
            }
            ok(&if kicked > 0 { format!("Saved. Disconnected {kicked} player(s) using it.") } else { "Saved.".into() })
        }
        "delete_key" => {
            let label = st.keys.lock().unwrap().get(id).map(|e| e.label.clone());
            if !st.keys.lock().unwrap().delete(id) {
                return err("No such key.");
            }
            let kicked = st.kick_key(id, "Your key was revoked by the proxy owner.");
            st.event("key_deleted", "admin", label.unwrap_or_default());
            ok(&format!("Key deleted{}.", if kicked > 0 { format!(", disconnected {kicked} player(s)") } else { String::new() }))
        }
        "kick" => {
            if st.kick(id, msg["reason"].as_str().unwrap_or("Disconnected by the proxy owner.")) { ok("Disconnected.") } else { err("Not connected any more.") }
        }
        "kick_all" => {
            let n = st.kick_all("The proxy owner disconnected everyone.");
            ok(&format!("Disconnected {n}."))
        }
        "unblock" => {
            if st.unblock(msg["ip"].as_str().unwrap_or("")) { ok("Unblocked.") } else { err("That IP isn't blocked.") }
        }
        "set_config" => {
            let patch = &msg["config"];
            let mut cfg = st.cfg();
            let mut cur = serde_json::to_value(&cfg).unwrap();
            if let (Some(c), Some(p)) = (cur.as_object_mut(), patch.as_object()) {
                for (k, v) in p {
                    if k == "admin_token" || !c.contains_key(k) {
                        continue;
                    }
                    c.insert(k.clone(), v.clone());
                }
            }
            match serde_json::from_value::<Config>(cur) {
                Ok(new) => {
                    if !Config::ports_valid(&new.allowed_ports) {
                        return err("Ports must look like 25565 or 1024-65535, separated by commas.");
                    }
                    cfg = new;
                }
                Err(e) => return err(&format!("Invalid setting: {e}")),
            }
            if let Err(e) = cfg.save(&st.data) {
                return err(&format!("Could not save config.json: {e}"));
            }
            *st.config.write().unwrap() = cfg;
            st.event("config", "admin", "settings changed");
            ok("Settings saved.")
        }
        _ => err("Unknown action."),
    }
}

async fn session(sock: WebSocket, st: Shared, peer: SocketAddr) {
    st.event("admin", peer.ip(), "admin panel opened");
    let (mut tx, mut rx) = sock.split();
    let mut tick = tokio::time::interval(Duration::from_millis(1000));
    loop {
        tokio::select! {
            _ = tick.tick() => {
                if tx.send(Message::Text(status(&st).to_string().into())).await.is_err() { break; }
            }
            m = rx.next() => {
                match m {
                    Some(Ok(Message::Text(t))) => {
                        let reply = match serde_json::from_str::<Value>(t.as_str()) {
                            Ok(v) => handle(&st, &v),
                            Err(_) => json!({"t":"error","msg":"bad message"}),
                        };
                        if tx.send(Message::Text(reply.to_string().into())).await.is_err() { break; }
                        let _ = tx.send(Message::Text(status(&st).to_string().into())).await;
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }
}
