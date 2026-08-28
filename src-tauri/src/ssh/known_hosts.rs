use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::Path;

use ssh_key::known_hosts::{HostPatterns, KnownHosts};
use ssh_key::{HashAlg, PublicKey};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostKeyClassification {
    Trusted,
    Unknown { fingerprint: String },
    Changed { fingerprint: String },
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum HostKeyCheckResult {
    #[serde(rename = "trusted")]
    Trusted,
    #[serde(rename = "unknown")]
    Unknown {
        algorithm: String,
        fingerprint: String,
        public_key: String,
    },
    #[serde(rename = "changed")]
    Changed {
        algorithm: String,
        fingerprint: String,
        public_key: String,
        known_fingerprints: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    pub public_key: String,
}

#[derive(Debug, Error)]
pub enum KnownHostsError {
    #[error("Invalid SSH public key: {0}")]
    InvalidPublicKey(#[from] ssh_key::Error),
    #[error("Known hosts error: {0}")]
    KnownHosts(#[from] russh::keys::Error),
    #[error("Known hosts file error: {0}")]
    Io(#[from] io::Error),
}

#[derive(Debug, Error)]
pub enum TrustHostKeyError {
    #[error("Invalid SSH public key: {0}")]
    InvalidPublicKey(#[from] ssh_key::Error),
    #[error("Host key fingerprint mismatch: expected {expected}, actual {actual}")]
    FingerprintMismatch { expected: String, actual: String },
    #[error("Known hosts error: {0}")]
    KnownHosts(#[from] russh::keys::Error),
    #[error("Known hosts file error: {0}")]
    Io(#[from] io::Error),
}

fn key_fingerprint(public_key: &PublicKey) -> String {
    public_key.fingerprint(HashAlg::Sha256).to_string()
}

fn host_pattern(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    }
}

fn line_matches_host_port(line: &str, target_pattern: &str) -> bool {
    line.split_whitespace()
        .next()
        .is_some_and(|patterns| patterns.split(',').any(|pattern| pattern == target_pattern))
}

fn remove_host_port_entries(path: &Path, host: &str, port: u16) -> Result<(), russh::keys::Error> {
    if !path.exists() {
        return Ok(());
    }

    let target_pattern = host_pattern(host, port);
    let matched_line_numbers: HashSet<usize> =
        russh::keys::known_hosts::known_host_keys_path(host, port, path)?
            .into_iter()
            .map(|(line_number, _)| line_number)
            .collect();
    let content = fs::read_to_string(path)?;
    let mut retained = Vec::new();
    for (index, line) in content.lines().enumerate() {
        let line_number = index + 1;
        if !matched_line_numbers.contains(&line_number)
            && !line_matches_host_port(line, &target_pattern)
        {
            retained.push(line);
        }
    }

    let next_content = if retained.is_empty() {
        String::new()
    } else {
        let mut joined = retained.join("\n");
        joined.push('\n');
        joined
    };
    fs::write(path, next_content)?;
    Ok(())
}

fn append_known_host_entry(
    path: &Path,
    host: &str,
    port: u16,
    public_key: &str,
) -> Result<(), io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut content = if path.exists() {
        fs::read_to_string(path)?
    } else {
        String::new()
    };
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&host_pattern(host, port));
    content.push(' ');
    content.push_str(public_key);
    content.push('\n');
    fs::write(path, content)
}

fn parse_app_host_pattern(pattern: &str) -> Option<(String, u16)> {
    if let Some(rest) = pattern.strip_prefix('[') {
        let (host, port) = rest.split_once("]:")?;
        return Some((host.to_owned(), port.parse().ok()?));
    }

    if !pattern.is_empty() && !pattern.starts_with('|') && !pattern.contains(',') {
        return Some((pattern.to_owned(), 22));
    }

    None
}

fn host_pattern_display(patterns: &HostPatterns) -> (String, u16) {
    if let HostPatterns::Patterns(patterns) = patterns {
        if patterns.len() == 1 {
            if let Some(parsed) = parse_app_host_pattern(&patterns[0]) {
                return parsed;
            }
        }
    }

    (patterns.to_string(), 22)
}

pub fn classify_public_key<P: AsRef<Path>>(
    host: &str,
    port: u16,
    public_key: &PublicKey,
    known_hosts_path: P,
) -> Result<HostKeyClassification, KnownHostsError> {
    let fingerprint = key_fingerprint(public_key);
    let existing =
        russh::keys::known_hosts::known_host_keys_path(host, port, known_hosts_path.as_ref())?;
    if existing.is_empty() {
        return Ok(HostKeyClassification::Unknown { fingerprint });
    }

    let trusted = existing.iter().any(|(_, known_key)| {
        known_key.algorithm() == public_key.algorithm()
            && known_key.key_data() == public_key.key_data()
    });
    if trusted {
        Ok(HostKeyClassification::Trusted)
    } else {
        Ok(HostKeyClassification::Changed { fingerprint })
    }
}

#[cfg(test)]
pub fn classify_host_key<P: AsRef<Path>>(
    host: &str,
    port: u16,
    public_key: &str,
    known_hosts_path: P,
) -> Result<HostKeyClassification, KnownHostsError> {
    let public_key = PublicKey::from_openssh(public_key)?;
    classify_public_key(host, port, &public_key, known_hosts_path)
}

pub fn check_host_key_result<P: AsRef<Path>>(
    host: &str,
    port: u16,
    public_key: &PublicKey,
    known_hosts_path: P,
) -> Result<HostKeyCheckResult, KnownHostsError> {
    let public_key_text = public_key.to_openssh()?;
    let algorithm = public_key.algorithm().as_str().to_owned();
    let fingerprint = key_fingerprint(public_key);
    match classify_public_key(host, port, public_key, known_hosts_path.as_ref())? {
        HostKeyClassification::Trusted => Ok(HostKeyCheckResult::Trusted),
        HostKeyClassification::Unknown { .. } => Ok(HostKeyCheckResult::Unknown {
            algorithm,
            fingerprint,
            public_key: public_key_text,
        }),
        HostKeyClassification::Changed { .. } => {
            let known_fingerprints = russh::keys::known_hosts::known_host_keys_path(
                host,
                port,
                known_hosts_path.as_ref(),
            )?
            .into_iter()
            .map(|(_, key)| key_fingerprint(&key))
            .collect();
            Ok(HostKeyCheckResult::Changed {
                algorithm,
                fingerprint,
                public_key: public_key_text,
                known_fingerprints,
            })
        }
    }
}

pub fn trust_host_key<P: AsRef<Path>>(
    host: &str,
    port: u16,
    public_key: &str,
    fingerprint: &str,
    known_hosts_path: P,
) -> Result<(), TrustHostKeyError> {
    let public_key_text = public_key.to_owned();
    let parsed_public_key = PublicKey::from_openssh(&public_key_text)?;
    let actual = key_fingerprint(&parsed_public_key);
    if actual != fingerprint {
        return Err(TrustHostKeyError::FingerprintMismatch {
            expected: fingerprint.to_owned(),
            actual,
        });
    }

    remove_host_port_entries(known_hosts_path.as_ref(), host, port)?;
    append_known_host_entry(known_hosts_path.as_ref(), host, port, &public_key_text)?;
    Ok(())
}

pub fn delete_known_host<P: AsRef<Path>>(
    host: &str,
    port: u16,
    known_hosts_path: P,
) -> Result<(), russh::keys::Error> {
    remove_host_port_entries(known_hosts_path.as_ref(), host, port)
}

pub fn list_known_hosts<P: AsRef<Path>>(
    known_hosts_path: P,
) -> Result<Vec<KnownHostEntry>, KnownHostsError> {
    let path = known_hosts_path.as_ref();
    if !path.exists() {
        return Ok(Vec::new());
    }

    let entries = KnownHosts::read_file(path)?;
    let mut result = Vec::with_capacity(entries.len());
    for entry in entries {
        let (host, port) = host_pattern_display(entry.host_patterns());
        let public_key = entry.public_key();
        result.push(KnownHostEntry {
            host,
            port,
            algorithm: public_key.algorithm().as_str().to_owned(),
            fingerprint: key_fingerprint(public_key),
            public_key: public_key.to_openssh()?,
        });
    }
    Ok(result)
}
