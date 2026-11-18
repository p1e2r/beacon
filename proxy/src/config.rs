use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Settings stored in `<data>/config.json`. Most can be changed live from the admin panel.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Shown to players in the browser client.
    pub name: String,
    /// Public address of this proxy (e.g. https://mc.example.com), used for invite links.
    pub public_url: String,
    /// When false, anyone who knows the proxy address can use it.
    pub require_key: bool,
    /// Allow joining servers on private/LAN/loopback addresses. Off by default so key
    /// holders cannot reach devices on your home network through the proxy.
    pub allow_private_targets: bool,
    /// Hosts (exact, or `*.example.com`) that are always allowed, even if private.
    pub allowed_hosts: Vec<String>,
    /// Hosts (exact, or `*.example.com`) that can never be joined.
    pub blocked_hosts: Vec<String>,
    /// Allowed target ports, e.g. "1024-65535" or "25565,25566,30000-30100".
    pub allowed_ports: String,
    /// Limits (0 = unlimited).
    pub max_connections: usize,
    pub max_connections_per_ip: usize,
    /// Failed key attempts per IP per minute before a 10 minute block.
    pub max_failures_per_minute: u32,
    /// Plain ws:// from a public IP sends the key unencrypted. When false (default) the proxy
    /// only accepts TLS (via a reverse proxy/tunnel that sets X-Forwarded-Proto: https)
    /// and direct LAN/localhost connections.
    pub allow_insecure: bool,
    /// Trust CF-Connecting-IP / X-Forwarded-For when the TCP peer is local (cloudflared, nginx).
    pub trust_proxy_headers: bool,
    /// Optional extra password for the admin panel (it is LAN-only either way). Empty = none.
    pub admin_token: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            name: "Beacon proxy".into(),
            public_url: String::new(),
            require_key: true,
            allow_private_targets: false,
            allowed_hosts: vec![],
            blocked_hosts: vec![],
            allowed_ports: "1024-65535".into(),
            max_connections: 0,
            max_connections_per_ip: 4,
            max_failures_per_minute: 5,
            allow_insecure: false,
            trust_proxy_headers: true,
            admin_token: String::new(),
        }
    }
}

impl Config {
    pub fn path(data: &Path) -> PathBuf {
        data.join("config.json")
    }

    pub fn load(data: &Path) -> anyhow::Result<Self> {
        let p = Self::path(data);
        let cfg = if p.exists() {
            serde_json::from_str(&std::fs::read_to_string(&p)?)?
        } else {
            Self::default()
        };
        cfg.save(data)?;
        Ok(cfg)
    }

    pub fn save(&self, data: &Path) -> anyhow::Result<()> {
        std::fs::create_dir_all(data)?;
        let p = Self::path(data);
        let tmp = p.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(tmp, p)?;
        Ok(())
    }

    pub fn port_allowed(&self, port: u16) -> bool {
        let spec = self.allowed_ports.trim();
        if spec.is_empty() {
            return true;
        }
        spec.split(',').any(|part| {
            let part = part.trim();
            match part.split_once('-') {
                Some((a, b)) => match (a.trim().parse::<u16>(), b.trim().parse::<u16>()) {
                    (Ok(a), Ok(b)) => (a..=b).contains(&port),
                    _ => false,
                },
                None => part.parse::<u16>().map(|p| p == port).unwrap_or(false),
            }
        })
    }

    pub fn ports_valid(spec: &str) -> bool {
        spec.trim().is_empty()
            || spec.split(',').all(|part| {
                let part = part.trim();
                match part.split_once('-') {
                    Some((a, b)) => matches!((a.trim().parse::<u16>(), b.trim().parse::<u16>()), (Ok(a), Ok(b)) if a <= b),
                    None => part.parse::<u16>().is_ok(),
                }
            })
    }
}

pub fn host_matches(pattern: &str, host: &str) -> bool {
    let pattern = pattern.trim().to_ascii_lowercase();
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if pattern.is_empty() {
        return false;
    }
    match pattern.strip_prefix("*.") {
        Some(suffix) => host == suffix || host.ends_with(&format!(".{suffix}")),
        None => host == pattern,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports() {
        let c = Config { allowed_ports: "25565, 30000-30010".into(), ..Default::default() };
        assert!(c.port_allowed(25565));
        assert!(c.port_allowed(30005));
        assert!(!c.port_allowed(25566));
        assert!(Config::ports_valid("1-2,5"));
        assert!(!Config::ports_valid("5-1"));
        assert!(!Config::ports_valid("abc"));
    }

    #[test]
    fn hosts() {
        assert!(host_matches("*.example.com", "mc.example.com"));
        assert!(host_matches("*.example.com", "example.com"));
        assert!(!host_matches("*.example.com", "badexample.com"));
        assert!(host_matches("Play.Foo.net", "play.foo.net."));
    }
}
