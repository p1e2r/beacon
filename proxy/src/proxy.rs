//! `GET /connect?host=…[&port=…]` — WebSocket that becomes a raw TCP pipe to a Minecraft server.
//!
//! The browser asks for the subprotocols `beacon` and `beacon-key.<key>`. The proxy always
//! answers the upgrade, then sends one JSON text frame: `{"t":"connected",…}` or
//! `{"t":"error","code":…,"msg":…}`. After `connected`, binary frames carry the TCP stream
//! both ways. Text frames `ping:<n>` are answered with `pong:<n>` (proxy latency).

use crate::config::host_matches;
use crate::keys::now_ms;
use crate::net::{client_ip, is_non_public, is_secure, sniff, valid_host};
use crate::state::{ConnInfo, Counters, LiveConn, Shared};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};

#[derive(Deserialize)]
pub struct ConnectParams {
    host: Option<String>,
    port: Option<u16>,
    /// `check=1`: only verify the key, then close.
    check: Option<u8>,
}

pub fn requested_protocols(h: &HeaderMap) -> Vec<String> {
    h.get_all("sec-websocket-protocol")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

pub async fn connect(
    ws: WebSocketUpgrade,
    State(st): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(params): Query<ConnectParams>,
) -> Response {
    let protos = requested_protocols(&headers);
    if !protos.iter().any(|p| p == "beacon") {
        return (StatusCode::BAD_REQUEST, "Use the Beacon web client to connect.").into_response();
    }
    let key = protos.iter().find_map(|p| p.strip_prefix("beacon-key.")).map(str::to_string);
    ws.protocols(["beacon"])
        .max_message_size(4 << 20)
        .on_upgrade(move |sock| async move {
            let mut sock = sock;
            if let Err((code, msg)) = run(&mut sock, st, peer, headers, params, key).await {
                let _ = sock.send(Message::Text(json!({"t":"error","code":code,"msg":msg}).to_string().into())).await;
                let _ = sock.send(Message::Close(Some(CloseFrame { code: 4000, reason: code.into() }))).await;
            }
        })
}

type Fail = (&'static str, String);

fn fail<T>(code: &'static str, msg: impl Into<String>) -> Result<T, Fail> {
    Err((code, msg.into()))
}

async fn resolve(host: &str, port: Option<u16>) -> Result<(String, u16, Vec<IpAddr>, bool), Fail> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok((host.to_string(), port.unwrap_or(25565), vec![ip], false));
    }
    let resolver = crate::dns::resolver();
    let (mut target, mut tport, mut via_srv) = (host.to_string(), port.unwrap_or(25565), false);
    if port.is_none() {
        if let Some((t, p)) = crate::dns::srv(&resolver, host).await {
            target = t;
            tport = p;
            via_srv = true;
        }
    }
    let ips = crate::dns::ips(&resolver, &target).await;
    if ips.is_empty() {
        return fail("dns", format!("Could not find a server called {host}."));
    }
    Ok((target, tport, ips, via_srv))
}

async fn run(
    sock: &mut WebSocket,
    st: Shared,
    peer: SocketAddr,
    headers: HeaderMap,
    params: ConnectParams,
    key: Option<String>,
) -> Result<(), Fail> {
    let cfg = st.cfg();
    let ip = client_ip(peer, &headers, cfg.trust_proxy_headers);
    let secure = is_secure(peer, &headers, cfg.trust_proxy_headers);
    let c = &st.counters;

    if st.is_blocked(ip) {
        Counters::inc(&c.rejected_rate);
        return fail("rate_limited", "Too many wrong keys from your network. Try again in 10 minutes.");
    }
    if cfg.require_key && !secure && !cfg.allow_insecure {
        Counters::inc(&c.rejected_insecure);
        st.event("insecure", ip, "plain ws:// from a public address refused");
        return fail("insecure", "This proxy only accepts encrypted wss:// connections, so your key can't be read in transit.");
    }

    // Key
    let mut key_entry = None;
    if cfg.require_key {
        let Some(k) = key.as_deref() else {
            Counters::inc(&c.rejected_key);
            return fail("key_required", "This proxy needs a key from its owner.");
        };
        let found = {
            let mut ks = st.keys.lock().unwrap();
            ks.refresh();
            ks.verify(k)
        };
        match found {
            Some(e) => key_entry = Some(e),
            None => {
                Counters::inc(&c.rejected_key);
                let blocked = st.record_failure(ip);
                st.event("bad_key", ip, if blocked { "wrong key, IP blocked for 10 min" } else { "wrong key" });
                return fail("bad_key", "That key is wrong, disabled or expired.");
            }
        }
    }
    if let Some(e) = &key_entry {
        if e.max_connections > 0 && st.count_for_key(&e.id) >= e.max_connections {
            Counters::inc(&c.rejected_limit);
            return fail("key_limit", format!("This key is already in use on {} connection(s).", e.max_connections));
        }
    }
    if params.check == Some(1) {
        let _ = sock
            .send(Message::Text(
                json!({"t":"ok","name":cfg.name,"key":key_entry.as_ref().map(|e| e.label.clone())}).to_string().into(),
            ))
            .await;
        let _ = sock.send(Message::Close(None)).await;
        return Ok(());
    }

    // Limits
    if cfg.max_connections > 0 && st.conns.lock().unwrap().len() >= cfg.max_connections {
        Counters::inc(&c.rejected_limit);
        return fail("full", "The proxy is full right now.");
    }
    if cfg.max_connections_per_ip > 0 && st.count_for_ip(&ip.to_string()) >= cfg.max_connections_per_ip {
        Counters::inc(&c.rejected_limit);
        return fail("ip_limit", "Too many connections from your network.");
    }

    // Target
    let host = params.host.unwrap_or_default().trim().trim_end_matches('.').to_ascii_lowercase();
    let host = host.trim_start_matches('[').trim_end_matches(']').to_string();
    if !valid_host(&host) {
        Counters::inc(&c.rejected_target);
        return fail("bad_host", "That server address doesn't look right.");
    }
    if cfg.blocked_hosts.iter().any(|p| host_matches(p, &host)) {
        Counters::inc(&c.rejected_target);
        st.event("blocked_host", ip, host.clone());
        return fail("target_blocked", "The proxy owner has blocked that server.");
    }
    let (target, port, ips, via_srv) = resolve(&host, params.port).await?;
    if cfg.blocked_hosts.iter().any(|p| host_matches(p, &target)) {
        Counters::inc(&c.rejected_target);
        return fail("target_blocked", "The proxy owner has blocked that server.");
    }
    let explicitly_allowed = cfg.allowed_hosts.iter().any(|p| host_matches(p, &host) || host_matches(p, &target));
    let ips: Vec<IpAddr> =
        ips.into_iter().filter(|a| explicitly_allowed || cfg.allow_private_targets || !is_non_public(*a)).collect();
    if ips.is_empty() {
        Counters::inc(&c.rejected_target);
        st.event("private_target", ip, format!("{host} resolves to a private address"));
        return fail("target_private", "That server is on a private network, which this proxy doesn't allow.");
    }
    if !explicitly_allowed && !cfg.port_allowed(port) {
        Counters::inc(&c.rejected_target);
        return fail("port_blocked", format!("This proxy doesn't allow port {port}."));
    }

    let mut tcp = None;
    let mut last_err = String::new();
    for a in &ips {
        match tokio::time::timeout(Duration::from_secs(8), TcpStream::connect((*a, port))).await {
            Ok(Ok(s)) => {
                tcp = Some((s, *a));
                break;
            }
            Ok(Err(e)) => last_err = e.to_string(),
            Err(_) => last_err = "timed out".into(),
        }
    }
    let Some((tcp, addr)) = tcp else {
        Counters::inc(&c.failed_connect);
        st.event("connect_failed", ip, format!("{host}:{port} {last_err}"));
        return fail("connect_failed", format!("Couldn't reach {host}:{port} ({last_err})."));
    };
    let _ = tcp.set_nodelay(true);

    // Register
    let id = crate::keys::new_id();
    let up = Arc::new(AtomicU64::new(0));
    let down = Arc::new(AtomicU64::new(0));
    let (kick_tx, mut kick_rx) = watch::channel::<Option<String>>(None);
    let info = ConnInfo {
        id: id.clone(),
        client_ip: ip.to_string(),
        key_id: key_entry.as_ref().map(|e| e.id.clone()),
        key_label: key_entry.as_ref().map(|e| e.label.clone()),
        target: if via_srv { format!("{host} → {target}:{port}") } else { format!("{host}:{port}") },
        resolved: SocketAddr::new(addr, port).to_string(),
        username: None,
        protocol: None,
        intent: None,
        since: now_ms(),
        bytes_up: 0,
        bytes_down: 0,
        secure,
    };
    st.conns.lock().unwrap().insert(id.clone(), LiveConn { info, up: up.clone(), down: down.clone(), kick: kick_tx });
    Counters::inc(&c.accepted);
    st.event("connect", ip, format!("{} → {host}:{port}", key_entry.as_ref().map(|e| e.label.as_str()).unwrap_or("no key")));

    let _ = sock
        .send(Message::Text(json!({"t":"connected","host":target,"ip":addr.to_string(),"port":port,"srv":via_srv}).to_string().into()))
        .await;

    let reason = pump(sock, tcp, &st, &id, up.clone(), down.clone(), &mut kick_rx).await;

    st.conns.lock().unwrap().remove(&id);
    c.bytes_up.fetch_add(up.load(Ordering::Relaxed), Ordering::Relaxed);
    c.bytes_down.fetch_add(down.load(Ordering::Relaxed), Ordering::Relaxed);
    st.event("disconnect", ip, format!("{host}:{port} ({reason})"));
    Ok(())
}

async fn pump(
    sock: &mut WebSocket,
    tcp: TcpStream,
    st: &Shared,
    id: &str,
    up: Arc<AtomicU64>,
    down: Arc<AtomicU64>,
    kick_rx: &mut watch::Receiver<Option<String>>,
) -> String {
    let (mut tcp_r, mut tcp_w) = tcp.into_split();
    let (ws_tx, mut ws_rx) = sock.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(64);

    // Single writer to the WebSocket.
    let writer = async move {
        let mut ws_tx = ws_tx;
        while let Some(m) = out_rx.recv().await {
            let close = matches!(m, Message::Close(_));
            if ws_tx.send(m).await.is_err() || close {
                break;
            }
        }
        let _ = ws_tx.close().await;
    };

    // Server → browser
    let out_tcp = out_tx.clone();
    let down2 = down.clone();
    let tcp_to_ws = async move {
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match tcp_r.read(&mut buf).await {
                Ok(0) => return "server closed the connection".to_string(),
                Ok(n) => {
                    down2.fetch_add(n as u64, Ordering::Relaxed);
                    if out_tcp.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                        return "browser went away".into();
                    }
                }
                Err(e) => return format!("server error: {e}"),
            }
        }
    };

    // Browser → server
    let out_ws = out_tx.clone();
    let st2 = st.clone();
    let id2 = id.to_string();
    let ws_to_tcp = async move {
        let mut head: Vec<u8> = Vec::new();
        let mut sniffed = false;
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Binary(b)) => {
                    up.fetch_add(b.len() as u64, Ordering::Relaxed);
                    if !sniffed {
                        head.extend_from_slice(&b);
                        let s = sniff(&head);
                        if s.username.is_some() || head.len() > 2048 || s.intent == Some(1) {
                            sniffed = true;
                            if s.intent == Some(1) {
                                Counters::inc(&st2.counters.status_pings);
                            }
                            if let Some(c) = st2.conns.lock().unwrap().get_mut(&id2) {
                                c.info.username = s.username.clone();
                                c.info.protocol = s.protocol;
                                c.info.intent = s.intent;
                            }
                            head = Vec::new();
                        }
                    }
                    if tcp_w.write_all(&b).await.is_err() {
                        return "server write failed".to_string();
                    }
                }
                Ok(Message::Text(t)) => {
                    if let Some(n) = t.as_str().strip_prefix("ping:") {
                        let _ = out_ws.send(Message::Text(format!("pong:{n}").into())).await;
                    }
                }
                Ok(Message::Ping(p)) => {
                    let _ = out_ws.send(Message::Pong(p)).await;
                }
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(Message::Pong(_)) => {}
            }
        }
        let _ = tcp_w.shutdown().await;
        "player left".to_string()
    };

    let main = async move {
        let reason = tokio::select! {
            r = tcp_to_ws => r,
            r = ws_to_tcp => r,
            _ = kick_rx.changed() => {
                let why = kick_rx.borrow().clone().unwrap_or_else(|| "kicked".into());
                let _ = out_tx.send(Message::Text(json!({"t":"error","code":"kicked","msg":why}).to_string().into())).await;
                format!("kicked: {why}")
            }
        };
        let _ = out_tx.send(Message::Close(Some(CloseFrame { code: 1000, reason: "".into() }))).await;
        drop(out_tx);
        reason
    };
    let (reason, _) = tokio::join!(main, writer);
    reason
}
