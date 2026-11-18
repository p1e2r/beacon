use crate::config::Config;
use crate::keys::{now_ms, KeyStore};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::watch;

#[derive(Serialize, Clone)]
pub struct ConnInfo {
    pub id: String,
    pub client_ip: String,
    pub key_id: Option<String>,
    pub key_label: Option<String>,
    pub target: String,
    pub resolved: String,
    pub username: Option<String>,
    pub protocol: Option<i32>,
    pub intent: Option<i32>,
    pub since: u64,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub secure: bool,
}

pub struct LiveConn {
    pub info: ConnInfo,
    pub up: Arc<AtomicU64>,
    pub down: Arc<AtomicU64>,
    pub kick: watch::Sender<Option<String>>,
}

#[derive(Serialize, Clone)]
pub struct Event {
    pub time: u64,
    pub kind: String,
    pub ip: String,
    pub detail: String,
}

#[derive(Default, Serialize)]
pub struct Counters {
    pub accepted: AtomicU64,
    pub status_pings: AtomicU64,
    pub rejected_key: AtomicU64,
    pub rejected_rate: AtomicU64,
    pub rejected_target: AtomicU64,
    pub rejected_limit: AtomicU64,
    pub rejected_insecure: AtomicU64,
    pub failed_connect: AtomicU64,
    pub bytes_up: AtomicU64,
    pub bytes_down: AtomicU64,
}

impl Counters {
    pub fn inc(c: &AtomicU64) {
        c.fetch_add(1, Ordering::Relaxed);
    }
}

#[derive(Default)]
struct Bucket {
    window_start: u64,
    failures: u32,
    blocked_until: u64,
}

pub struct AppState {
    pub data: PathBuf,
    #[allow(dead_code)]
    pub web: PathBuf,
    pub started_at: u64,
    pub config: RwLock<Config>,
    pub keys: Mutex<KeyStore>,
    pub conns: Mutex<HashMap<String, LiveConn>>,
    events: Mutex<VecDeque<Event>>,
    pub counters: Counters,
    failures: Mutex<HashMap<IpAddr, Bucket>>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub fn new(data: PathBuf, web: PathBuf, config: Config, keys: KeyStore) -> Self {
        Self {
            data,
            web,
            started_at: now_ms(),
            config: RwLock::new(config),
            keys: Mutex::new(keys),
            conns: Mutex::new(HashMap::new()),
            events: Mutex::new(VecDeque::new()),
            counters: Counters::default(),
            failures: Mutex::new(HashMap::new()),
        }
    }

    pub fn cfg(&self) -> Config {
        self.config.read().unwrap().clone()
    }

    pub fn event(&self, kind: &str, ip: impl ToString, detail: impl Into<String>) {
        let detail = detail.into();
        tracing::info!(target: "beacon", "[{kind}] {} {detail}", ip.to_string());
        let mut ev = self.events.lock().unwrap();
        ev.push_front(Event { time: now_ms(), kind: kind.into(), ip: ip.to_string(), detail });
        ev.truncate(200);
    }

    pub fn events(&self) -> Vec<Event> {
        self.events.lock().unwrap().iter().cloned().collect()
    }

    pub fn is_blocked(&self, ip: IpAddr) -> bool {
        let f = self.failures.lock().unwrap();
        f.get(&ip).map(|b| b.blocked_until > now_ms()).unwrap_or(false)
    }

    /// Records a failed key attempt; returns true if the IP is now blocked.
    pub fn record_failure(&self, ip: IpAddr) -> bool {
        let max = self.cfg().max_failures_per_minute.max(1);
        let now = now_ms();
        let mut f = self.failures.lock().unwrap();
        let b = f.entry(ip).or_default();
        if now - b.window_start > 60_000 {
            b.window_start = now;
            b.failures = 0;
        }
        b.failures += 1;
        if b.failures >= max {
            b.blocked_until = now + 10 * 60_000;
        }
        b.blocked_until > now
    }

    pub fn blocked_ips(&self) -> Vec<(String, u64)> {
        let now = now_ms();
        let mut f = self.failures.lock().unwrap();
        f.retain(|_, b| b.blocked_until > now || now - b.window_start < 60_000);
        f.iter().filter(|(_, b)| b.blocked_until > now).map(|(ip, b)| (ip.to_string(), b.blocked_until)).collect()
    }

    pub fn unblock(&self, ip: &str) -> bool {
        match ip.parse::<IpAddr>() {
            Ok(ip) => self.failures.lock().unwrap().remove(&ip).is_some(),
            Err(_) => false,
        }
    }

    pub fn conn_snapshot(&self) -> Vec<ConnInfo> {
        let conns = self.conns.lock().unwrap();
        let mut v: Vec<ConnInfo> = conns
            .values()
            .map(|c| {
                let mut i = c.info.clone();
                i.bytes_up = c.up.load(Ordering::Relaxed);
                i.bytes_down = c.down.load(Ordering::Relaxed);
                i
            })
            .collect();
        v.sort_by_key(|c| c.since);
        v
    }

    pub fn count_for_ip(&self, ip: &str) -> usize {
        self.conns.lock().unwrap().values().filter(|c| c.info.client_ip == ip).count()
    }

    pub fn count_for_key(&self, key_id: &str) -> usize {
        self.conns.lock().unwrap().values().filter(|c| c.info.key_id.as_deref() == Some(key_id)).count()
    }

    pub fn kick(&self, id: &str, reason: &str) -> bool {
        match self.conns.lock().unwrap().get(id) {
            Some(c) => {
                let _ = c.kick.send(Some(reason.to_string()));
                true
            }
            None => false,
        }
    }

    pub fn kick_key(&self, key_id: &str, reason: &str) -> usize {
        let conns = self.conns.lock().unwrap();
        let mut n = 0;
        for c in conns.values().filter(|c| c.info.key_id.as_deref() == Some(key_id)) {
            let _ = c.kick.send(Some(reason.to_string()));
            n += 1;
        }
        n
    }

    pub fn kick_all(&self, reason: &str) -> usize {
        let conns = self.conns.lock().unwrap();
        for c in conns.values() {
            let _ = c.kick.send(Some(reason.to_string()));
        }
        conns.len()
    }
}
