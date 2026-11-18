use axum::http::HeaderMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// Loopback, private, link-local, CGNAT, unique-local, unspecified, multicast, documentation…
/// anything that is not a normal public internet address.
pub fn is_non_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_non_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_non_public_v4(v4);
            }
            let s = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local
                || (s[0] & 0xffc0) == 0xfe80 // link local
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || (s[0] == 0x0064 && s[1] == 0xff9b) // NAT64 (could reach v4 private)
                || (s[0] == 0x2002) // 6to4 (embeds v4)
                || v6 == Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 1)
        }
    }
}

fn is_non_public_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_documentation()
        || o[0] == 0
        || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10 CGNAT / Tailscale
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24
        || (o[0] == 198 && (o[1] & 0xfe) == 18) // 198.18.0.0/15 benchmarking
        || o[0] >= 240 // reserved
}

const FORWARD_HEADERS: [&str; 5] = ["cf-connecting-ip", "x-forwarded-for", "x-real-ip", "forwarded", "true-client-ip"];

pub fn has_forward_headers(h: &HeaderMap) -> bool {
    FORWARD_HEADERS.iter().any(|n| h.contains_key(*n))
}

/// The player's real IP: the TCP peer, or the forwarded address when the peer is a local
/// reverse proxy / tunnel and `trust` is on.
pub fn client_ip(peer: SocketAddr, h: &HeaderMap, trust: bool) -> IpAddr {
    let peer_ip = peer.ip();
    if !(trust && is_non_public(peer_ip)) {
        return peer_ip;
    }
    let header = |n: &str| h.get(n).and_then(|v| v.to_str().ok()).map(str::trim);
    if let Some(ip) = header("cf-connecting-ip").and_then(|v| v.parse().ok()) {
        return ip;
    }
    if let Some(ip) = header("x-forwarded-for").and_then(|v| v.split(',').next()).and_then(|v| v.trim().parse().ok()) {
        return ip;
    }
    if let Some(ip) = header("x-real-ip").and_then(|v| v.parse().ok()) {
        return ip;
    }
    peer_ip
}

/// Whether the browser→proxy hop is encrypted (or never left the local network).
pub fn is_secure(peer: SocketAddr, h: &HeaderMap, trust: bool) -> bool {
    let local_peer = is_non_public(peer.ip());
    if local_peer && trust {
        let proto = h.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).unwrap_or("");
        let visitor = h.get("cf-visitor").and_then(|v| v.to_str().ok()).unwrap_or("");
        if proto.eq_ignore_ascii_case("https") || visitor.contains("\"https\"") {
            return true;
        }
        // A direct LAN/localhost connection with no proxy in front.
        return !has_forward_headers(h);
    }
    local_peer
}

/// Hostname or IP literal a player may ask for.
pub fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    if host.parse::<IpAddr>().is_ok() {
        return true;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            && !label.starts_with('-')
    })
}

/// What we learn from the first bytes the client sends (Minecraft handshake + login start).
#[derive(Default, Clone, Debug)]
pub struct Sniffed {
    pub protocol: Option<i32>,
    pub intent: Option<i32>,
    pub username: Option<String>,
}

fn read_varint(b: &[u8], pos: &mut usize) -> Option<i32> {
    let mut v: i32 = 0;
    for i in 0..5 {
        let byte = *b.get(*pos)?;
        *pos += 1;
        v |= ((byte & 0x7f) as i32) << (7 * i);
        if byte & 0x80 == 0 {
            return Some(v);
        }
    }
    None
}

fn read_string(b: &[u8], pos: &mut usize) -> Option<String> {
    let len = read_varint(b, pos)? as usize;
    if len > 1024 {
        return None;
    }
    let s = b.get(*pos..*pos + len)?;
    *pos += len;
    String::from_utf8(s.to_vec()).ok()
}

/// Parses the uncompressed handshake (and login start, if present). Best effort.
pub fn sniff(b: &[u8]) -> Sniffed {
    let mut out = Sniffed::default();
    let mut pos = 0;
    let Some(len) = read_varint(b, &mut pos) else { return out };
    let end = pos + len as usize;
    if read_varint(b, &mut pos) != Some(0) {
        return out;
    }
    out.protocol = read_varint(b, &mut pos);
    if read_string(b, &mut pos).is_none() {
        return out;
    }
    pos += 2;
    out.intent = read_varint(b, &mut pos);
    if out.intent == Some(2) || out.intent == Some(3) {
        let mut p = end;
        if read_varint(b, &mut p).is_some() && read_varint(b, &mut p) == Some(0) {
            out.username = read_string(b, &mut p).filter(|n| n.len() <= 16);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify() {
        for s in ["10.1.2.3", "192.168.1.1", "127.0.0.1", "100.100.1.1", "169.254.1.1", "::1", "fd00::1", "fe80::1", "::ffff:192.168.0.1", "0.0.0.0"] {
            assert!(is_non_public(s.parse().unwrap()), "{s}");
        }
        for s in ["1.1.1.1", "8.8.8.8", "2606:4700::1111", "172.32.0.1"] {
            assert!(!is_non_public(s.parse().unwrap()), "{s}");
        }
    }

    #[test]
    fn hosts() {
        assert!(valid_host("play.example.com"));
        assert!(valid_host("1.2.3.4"));
        assert!(valid_host("::1"));
        assert!(!valid_host("a..b"));
        assert!(!valid_host("evil host"));
        assert!(!valid_host("-x.com"));
    }

    #[test]
    fn sniff_login() {
        // handshake: id 0, proto 776, "a", port, intent 2 ; login start: id 0, "Steve", uuid
        let mut hs = vec![0x00];
        hs.extend([0x88, 0x06]); // 776
        hs.extend([1, b'a']);
        hs.extend([0x63, 0xdd]);
        hs.push(2);
        let mut b = vec![hs.len() as u8];
        b.extend(&hs);
        let mut ls = vec![0x00, 5];
        ls.extend(b"Steve");
        ls.extend([0u8; 16]);
        b.push(ls.len() as u8);
        b.extend(&ls);
        let s = sniff(&b);
        assert_eq!(s.protocol, Some(776));
        assert_eq!(s.intent, Some(2));
        assert_eq!(s.username.as_deref(), Some("Steve"));
    }
}
