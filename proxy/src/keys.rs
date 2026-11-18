//! Player keys handed out by the proxy owner. Only SHA-256 hashes are stored on disk;
//! the full key is shown once, when it is created.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const PREFIX: &str = "bk_";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KeyEntry {
    pub id: String,
    pub label: String,
    /// First characters of the key, so the owner can tell keys apart.
    pub hint: String,
    pub hash: String,
    pub created_at: u64,
    #[serde(default)]
    pub last_used_at: u64,
    #[serde(default)]
    pub uses: u64,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Unix ms, 0 = never.
    #[serde(default)]
    pub expires_at: u64,
    /// Simultaneous connections allowed with this key, 0 = unlimited.
    #[serde(default)]
    pub max_connections: usize,
}

fn yes() -> bool {
    true
}

impl KeyEntry {
    pub fn usable(&self, now: u64) -> bool {
        self.enabled && (self.expires_at == 0 || self.expires_at > now)
    }

    /// Copy without the hash, for the admin panel.
    pub fn public(&self) -> serde_json::Value {
        let mut v = serde_json::to_value(self).unwrap();
        v.as_object_mut().unwrap().remove("hash");
        v
    }
}

pub struct KeyStore {
    file: PathBuf,
    entries: Vec<KeyEntry>,
    loaded_mtime: Option<SystemTime>,
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis() as u64
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom_fill(&mut b);
    b
}

fn getrandom_fill(buf: &mut [u8]) {
    use rand::RngExt;
    let mut rng = rand::rng();
    for b in buf.iter_mut() {
        *b = rng.random();
    }
}

pub fn new_token(prefix: &str) -> String {
    let b: [u8; 32] = random_bytes();
    format!("{prefix}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b))
}

pub fn new_id() -> String {
    hex::encode(random_bytes::<6>())
}

pub fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// Constant-time equality for equal-length byte strings.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn ct_eq_str(a: &str, b: &str) -> bool {
    ct_eq(&Sha256::digest(a.as_bytes()), &Sha256::digest(b.as_bytes()))
}

impl KeyStore {
    pub fn open(data: &Path) -> anyhow::Result<Self> {
        let mut s = Self { file: data.join("keys.json"), entries: vec![], loaded_mtime: None };
        s.reload()?;
        Ok(s)
    }

    fn mtime(&self) -> Option<SystemTime> {
        std::fs::metadata(&self.file).and_then(|m| m.modified()).ok()
    }

    fn reload(&mut self) -> anyhow::Result<()> {
        if self.file.exists() {
            self.entries = serde_json::from_str(&std::fs::read_to_string(&self.file)?)?;
        }
        self.loaded_mtime = self.mtime();
        Ok(())
    }

    /// Picks up edits made by the `beacon-proxy key ...` command while the proxy runs.
    pub fn refresh(&mut self) {
        if self.mtime() != self.loaded_mtime {
            if let Err(e) = self.reload() {
                tracing::warn!("could not reload keys.json: {e}");
            }
        }
    }

    fn save(&mut self) {
        let res = (|| -> anyhow::Result<()> {
            if let Some(dir) = self.file.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let tmp = self.file.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_string_pretty(&self.entries)?)?;
            std::fs::rename(&tmp, &self.file)?;
            Ok(())
        })();
        if let Err(e) = res {
            tracing::warn!("could not save keys.json: {e}");
        }
        self.loaded_mtime = self.mtime();
    }

    pub fn list(&self) -> &[KeyEntry] {
        &self.entries
    }

    pub fn get(&self, id: &str) -> Option<&KeyEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    pub fn usable_count(&self) -> usize {
        let now = now_ms();
        self.entries.iter().filter(|e| e.usable(now)).count()
    }

    /// Returns the entry and the full key (show it once).
    pub fn create(&mut self, label: &str, expires_at: u64, max_connections: usize) -> (KeyEntry, String) {
        let key = new_token(PREFIX);
        let entry = KeyEntry {
            id: new_id(),
            label: clean_label(label, &format!("key {}", self.entries.len() + 1)),
            hint: key[..PREFIX.len() + 4].to_string(),
            hash: sha256_hex(&key),
            created_at: now_ms(),
            last_used_at: 0,
            uses: 0,
            enabled: true,
            expires_at,
            max_connections,
        };
        self.entries.push(entry.clone());
        self.save();
        (entry, key)
    }

    /// Finds the usable entry for a key. Checks every entry in constant time.
    pub fn verify(&mut self, key: &str) -> Option<KeyEntry> {
        if !key.starts_with(PREFIX) || key.len() > 128 {
            return None;
        }
        let h = Sha256::digest(key.as_bytes());
        let now = now_ms();
        let mut found: Option<usize> = None;
        for (i, e) in self.entries.iter().enumerate() {
            let eh = hex::decode(&e.hash).unwrap_or_default();
            if ct_eq(&h, &eh) && e.usable(now) {
                found = Some(i);
            }
        }
        let i = found?;
        let e = &mut self.entries[i];
        e.last_used_at = now;
        e.uses += 1;
        let out = e.clone();
        self.save();
        Some(out)
    }

    pub fn is_usable(&self, id: &str) -> bool {
        let now = now_ms();
        self.entries.iter().any(|e| e.id == id && e.usable(now))
    }

    pub fn update(&mut self, id: &str, f: impl FnOnce(&mut KeyEntry)) -> bool {
        match self.entries.iter_mut().find(|e| e.id == id) {
            Some(e) => {
                f(e);
                self.save();
                true
            }
            None => false,
        }
    }

    pub fn delete(&mut self, id: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.id != id);
        let changed = self.entries.len() != before;
        if changed {
            self.save();
        }
        changed
    }
}

pub fn clean_label(s: &str, fallback: &str) -> String {
    let s: String = s.trim().chars().filter(|c| !c.is_control()).take(48).collect();
    if s.is_empty() { fallback.to_string() } else { s }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_verify_revoke() {
        let dir = std::env::temp_dir().join(format!("beacon-test-{}", new_id()));
        let mut ks = KeyStore::open(&dir).unwrap();
        let (e, key) = ks.create("friend", 0, 0);
        assert!(key.starts_with(PREFIX));
        assert_eq!(key.len(), PREFIX.len() + 43);
        assert!(ks.verify(&key).is_some());
        assert!(ks.verify("bk_wrong").is_none());
        assert!(ks.verify(&key[..key.len() - 1]).is_none());
        // persisted as hash only
        let raw = std::fs::read_to_string(dir.join("keys.json")).unwrap();
        assert!(!raw.contains(&key));
        ks.update(&e.id, |e| e.enabled = false);
        assert!(ks.verify(&key).is_none());
        ks.update(&e.id, |e| { e.enabled = true; e.expires_at = 1; });
        assert!(ks.verify(&key).is_none());
        assert!(ks.delete(&e.id));
        let _ = std::fs::remove_dir_all(dir);
    }
}
