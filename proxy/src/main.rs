//! Beacon proxy — lets the Beacon browser client join any Minecraft Java server.
//! Players need a key from the proxy owner; the admin panel is LAN-only.

mod admin;
mod config;
mod dns;
mod keys;
mod net;
mod proxy;
mod state;

use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use config::Config;
use keys::KeyStore;
use serde_json::json;
use state::{AppState, Shared};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string())
}

fn usage() -> ! {
    eprintln!(
        "beacon-proxy {v}

USAGE:
  beacon-proxy                       run the proxy
  beacon-proxy key create <label> [--days N] [--max N]
  beacon-proxy key list
  beacon-proxy key disable|enable|delete <id>

ENV:
  BEACON_LISTEN        public address        (default 0.0.0.0:8080)
  BEACON_ADMIN_LISTEN  admin panel address   (default 0.0.0.0:8081, LAN-only)
  BEACON_DATA          config + keys folder  (default ./data)
  BEACON_WEB           web client folder     (default ./web)",
        v = env!("CARGO_PKG_VERSION")
    );
    std::process::exit(2)
}

fn key_cli(data: &std::path::Path, args: &[String]) -> anyhow::Result<()> {
    let mut ks = KeyStore::open(data)?;
    match args.first().map(String::as_str) {
        Some("create") => {
            let mut label = String::new();
            let (mut days, mut max) = (0f64, 0usize);
            let mut it = args[1..].iter();
            while let Some(a) = it.next() {
                match a.as_str() {
                    "--days" => days = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0),
                    "--max" => max = it.next().and_then(|v| v.parse().ok()).unwrap_or(0),
                    _ => {
                        if !label.is_empty() {
                            label.push(' ');
                        }
                        label.push_str(a)
                    }
                }
            }
            let exp = if days > 0.0 { keys::now_ms() + (days * 86_400_000.0) as u64 } else { 0 };
            let (e, key) = ks.create(&label, exp, max);
            println!("Created key \"{}\" (id {})\n\n  {key}\n\nGive this to the player. It is shown only once.", e.label, e.id);
        }
        Some("list") => {
            let now = keys::now_ms();
            for e in ks.list() {
                let state = if !e.enabled { "disabled" } else if !e.usable(now) { "expired" } else { "active" };
                println!("{}  {:<10} {}…  uses {:<5} {}", e.id, state, e.hint, e.uses, e.label);
            }
            if ks.list().is_empty() {
                println!("No keys yet. Create one with: beacon-proxy key create <label>");
            }
        }
        Some(cmd @ ("disable" | "enable" | "delete")) => {
            let id = args.get(1).cloned().unwrap_or_else(|| usage());
            let ok = match cmd {
                "delete" => ks.delete(&id),
                _ => ks.update(&id, |e| e.enabled = cmd == "enable"),
            };
            println!("{}", if ok { "Done. A running proxy picks this up automatically." } else { "No key with that id." });
        }
        _ => usage(),
    }
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let data = PathBuf::from(env_or("BEACON_DATA", "./data"));
    let web = PathBuf::from(env_or("BEACON_WEB", "./web"));
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("key") => return key_cli(&data, &args[1..]),
        Some("-h" | "--help" | "help") => usage(),
        Some(_) => usage(),
        None => {}
    }

    let cfg = Config::load(&data)?;
    let ks = KeyStore::open(&data)?;
    let usable = ks.usable_count();
    let st: Shared = Arc::new(AppState::new(data.clone(), web.clone(), cfg.clone(), ks));

    let listen: SocketAddr = env_or("BEACON_LISTEN", "0.0.0.0:8080").parse()?;
    let admin_listen: SocketAddr = env_or("BEACON_ADMIN_LISTEN", "0.0.0.0:8081").parse()?;

    let info = {
        let st = st.clone();
        move || {
            let st = st.clone();
            async move {
                let c = st.cfg();
                (
                    [(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"), (header::CACHE_CONTROL, "no-store")],
                    Json(json!({"beacon": true, "name": c.name, "version": env!("CARGO_PKG_VERSION"), "require_key": c.require_key})),
                )
            }
        }
    };

    let mut public = Router::new()
        .route("/connect", get(proxy::connect))
        .route("/info", get(info))
        .route("/healthz", get(|| async { "ok" }));
    if web.join("index.html").exists() {
        let files = tower::ServiceBuilder::new()
            .layer(SetResponseHeaderLayer::if_not_present(header::X_CONTENT_TYPE_OPTIONS, header::HeaderValue::from_static("nosniff")))
            .layer(SetResponseHeaderLayer::if_not_present(header::REFERRER_POLICY, header::HeaderValue::from_static("no-referrer")))
            .service(ServeDir::new(&web).precompressed_gzip().fallback(ServeFile::new(web.join("index.html"))));
        public = public.fallback_service(files);
    } else {
        public = public.fallback(|| async {
            (StatusCode::OK, "Beacon proxy is running. (No web client found in BEACON_WEB.)").into_response()
        });
    }
    let public = public.with_state(st.clone()).layer(CompressionLayer::new());
    let admin = admin::router(st.clone());

    tracing::info!("Beacon proxy {} — players: http://{listen}  admin (LAN only): http://{admin_listen}", env!("CARGO_PKG_VERSION"));
    if cfg.require_key && usable == 0 {
        tracing::warn!("No player keys yet. Create one in the admin panel or with `beacon-proxy key create <label>`.");
    }
    if !cfg.require_key {
        tracing::warn!("require_key is OFF: anyone who finds this proxy can use it.");
    }

    let pl = tokio::net::TcpListener::bind(listen).await?;
    let al = tokio::net::TcpListener::bind(admin_listen).await?;
    let p = axum::serve(pl, public.into_make_service_with_connect_info::<SocketAddr>());
    let a = axum::serve(al, admin.into_make_service_with_connect_info::<SocketAddr>());
    tokio::select! {
        r = p => r?,
        r = a => r?,
        _ = tokio::signal::ctrl_c() => tracing::info!("shutting down"),
    }
    Ok(())
}
