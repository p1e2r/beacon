use hickory_resolver::proto::rr::RData;
use hickory_resolver::TokioResolver;
use std::net::IpAddr;
use std::sync::OnceLock;

static RESOLVER: OnceLock<TokioResolver> = OnceLock::new();

pub fn resolver() -> &'static TokioResolver {
    RESOLVER.get_or_init(|| {
        TokioResolver::builder_tokio()
            .and_then(|b| b.build())
            .expect("could not set up DNS (check /etc/resolv.conf)")
    })
}

/// `_minecraft._tcp.<host>` → (target, port), lowest priority first.
pub async fn srv(r: &TokioResolver, host: &str) -> Option<(String, u16)> {
    let lookup = r.srv_lookup(format!("_minecraft._tcp.{host}.")).await.ok()?;
    let mut best: Option<(u16, String, u16)> = None;
    for rec in lookup.answers() {
        if let RData::SRV(s) = &rec.data {
            let target = s.target.to_utf8().trim_end_matches('.').to_string();
            if target.is_empty() {
                continue;
            }
            if best.as_ref().map(|b| s.priority < b.0).unwrap_or(true) {
                best = Some((s.priority, target, s.port));
            }
        }
    }
    best.map(|(_, t, p)| (t, p))
}

pub async fn ips(r: &TokioResolver, host: &str) -> Vec<IpAddr> {
    match r.lookup_ip(format!("{host}.")).await {
        Ok(l) => {
            let mut v: Vec<IpAddr> = l.iter().collect();
            // Prefer IPv4: home servers often have broken IPv6 routing.
            v.sort_by_key(|a| a.is_ipv6());
            v.dedup();
            v
        }
        Err(_) => vec![],
    }
}
