use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use ssh_key::{HashAlg, PublicKey};

use super::known_hosts::{
    classify_host_key, delete_known_host, list_known_hosts, trust_host_key, HostKeyClassification,
    TrustHostKeyError,
};

const ED25519_KEY_A: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ preflight-alpha";
const ED25519_KEY_B: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X known-host-beta";
const RSA_KEY: &str = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCmjkeMm8k3JkNrf16eb5pG4bc77B6Mt3VN4saltsRV8vASpyWa/PlBgdaeldOaNJ5NK0gqU3KyiUNzHbdcc8572e7IUBDJS/rlaWARiSL4aos2VbNX0k56Z5zYp9m/bq5m9/mlb+PQkNBjIhimgpYNiq2TwBiYeA6tLb79cPtHA0cX5BLk/a5oUpLsiR4kI/f+Q98vVDKasKXXVh5YLkLobrruDB6er2A9fOcIUF0O4JCRLh/Dc161gE3fQrYTMQenbppZzfxrZfQ8YwLPvKjnqm+XRX+pbTtaJuj0EgTSzUK+EZxoSw8CNwiZpxrjwecTMVQ8w/srQmh4ABGuTqk0wP8HcI7hg+fpBv7kiejh5X/Oehxt+Puu85u9GVXb1a0av/vhJvUCBcuISvCA/z1wVJ0xdLhb1/ZiTDdTzyNbZQ0OQijzK+e1SlkNhp+3eGVZu3pNZvnTppwIXv3wg6kV1HodkWGgh1ayY7Buc52Z8okDYqvJat5CzOj5OaQNr/k= known-host-rsa";

const HASHED_EXAMPLE_HOST_PATTERN: &str =
    "|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak=";
const HASHED_EXAMPLE_KEY: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF hashed-example";

static NEXT_FIXTURE_ID: AtomicUsize = AtomicUsize::new(0);

struct KnownHostsFixture {
    root: PathBuf,
    path: PathBuf,
}

impl KnownHostsFixture {
    fn new(test_name: &str) -> Self {
        let id = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "redterm-known-hosts-test-{}-{}-{}",
            std::process::id(),
            id,
            test_name
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("known_hosts");
        Self { root, path }
    }
}

impl Drop for KnownHostsFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn sha256_fingerprint(public_key: &str) -> String {
    PublicKey::from_openssh(public_key)
        .unwrap()
        .fingerprint(HashAlg::Sha256)
        .to_string()
}

fn host_pattern(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    }
}

fn write_known_host(path: &Path, host: &str, port: u16, public_key: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }

    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .unwrap();
    writeln!(file, "{} {}", host_pattern(host, port), public_key).unwrap();
}

fn write_known_host_line(path: &Path, line: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }

    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .unwrap();
    writeln!(file, "{line}").unwrap();
}

#[test]
fn empty_or_missing_known_hosts_classifies_presented_key_as_unknown() {
    for (case_name, create_empty_file) in [("missing", false), ("empty", true)] {
        let fixture = KnownHostsFixture::new(case_name);
        if create_empty_file {
            File::create(&fixture.path).unwrap();
        }

        let classification =
            classify_host_key("new.example.com", 2200, ED25519_KEY_A, &fixture.path).unwrap();

        assert_eq!(
            classification,
            HostKeyClassification::Unknown {
                fingerprint: sha256_fingerprint(ED25519_KEY_A),
            }
        );
    }
}

#[test]
fn exact_existing_host_port_key_is_trusted() {
    let fixture = KnownHostsFixture::new("exact-existing-host-port-key");
    write_known_host(&fixture.path, "trusted.example.com", 2201, ED25519_KEY_A);

    let classification =
        classify_host_key("trusted.example.com", 2201, ED25519_KEY_A, &fixture.path).unwrap();

    assert_eq!(classification, HostKeyClassification::Trusted);
}

#[test]
fn same_algorithm_different_key_for_existing_host_port_is_changed() {
    let fixture = KnownHostsFixture::new("same-algorithm-different-key");
    write_known_host(&fixture.path, "changed.example.com", 2202, ED25519_KEY_B);

    let classification =
        classify_host_key("changed.example.com", 2202, ED25519_KEY_A, &fixture.path).unwrap();

    assert_eq!(
        classification,
        HostKeyClassification::Changed {
            fingerprint: sha256_fingerprint(ED25519_KEY_A),
        }
    );
}

#[test]
fn different_algorithm_entry_for_existing_host_port_is_changed_not_unknown() {
    let fixture = KnownHostsFixture::new("different-algorithm-entry");
    write_known_host(
        &fixture.path,
        "algorithm-conflict.example.com",
        2203,
        RSA_KEY,
    );

    let classification = classify_host_key(
        "algorithm-conflict.example.com",
        2203,
        ED25519_KEY_A,
        &fixture.path,
    )
    .unwrap();

    assert_eq!(
        classification,
        HostKeyClassification::Changed {
            fingerprint: sha256_fingerprint(ED25519_KEY_A),
        }
    );
}

#[test]
fn trust_host_key_persists_exact_public_key_and_then_classifies_as_trusted() {
    let fixture = KnownHostsFixture::new("trust-exact-public-key");
    let fingerprint = sha256_fingerprint(ED25519_KEY_A);

    trust_host_key(
        "store.example.com",
        2204,
        ED25519_KEY_A,
        &fingerprint,
        &fixture.path,
    )
    .unwrap();

    let known_hosts = fs::read_to_string(&fixture.path).unwrap();
    assert_eq!(
        known_hosts,
        format!(
            "{} {}\n",
            host_pattern("store.example.com", 2204),
            ED25519_KEY_A
        )
    );

    let classification =
        classify_host_key("store.example.com", 2204, ED25519_KEY_A, &fixture.path).unwrap();
    assert_eq!(classification, HostKeyClassification::Trusted);
}

#[test]
fn trust_host_key_replaces_existing_changed_host_port_entry() {
    let fixture = KnownHostsFixture::new("trust-replaces-changed-host-port");
    let target_host = "replace.example.com";
    let target_port = 2207;
    let target_pattern = host_pattern(target_host, target_port);
    let before_line = format!(
        "{} {}",
        host_pattern("keep-before.example.com", 2207),
        ED25519_KEY_B
    );
    let after_line = format!(
        "{} {}",
        host_pattern("keep-after.example.com", 2208),
        RSA_KEY
    );
    let new_target_line = format!("{target_pattern} {ED25519_KEY_A}");
    let target_prefix = format!("{target_pattern} ");

    write_known_host(
        &fixture.path,
        "keep-before.example.com",
        2207,
        ED25519_KEY_B,
    );
    write_known_host(&fixture.path, target_host, target_port, ED25519_KEY_B);
    write_known_host(&fixture.path, "keep-after.example.com", 2208, RSA_KEY);

    trust_host_key(
        target_host,
        target_port,
        ED25519_KEY_A,
        &sha256_fingerprint(ED25519_KEY_A),
        &fixture.path,
    )
    .unwrap();

    let known_hosts = fs::read_to_string(&fixture.path).unwrap();
    let lines: Vec<&str> = known_hosts.lines().collect();
    let target_lines: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| line.starts_with(&target_prefix))
        .collect();
    assert_eq!(target_lines, vec![new_target_line.as_str()]);
    assert!(lines.contains(&before_line.as_str()));
    assert!(lines.contains(&after_line.as_str()));

    let classification =
        classify_host_key(target_host, target_port, ED25519_KEY_A, &fixture.path).unwrap();
    assert_eq!(classification, HostKeyClassification::Trusted);
}

#[test]
fn trust_host_key_replaces_existing_hashed_host_entry_before_appending_plain_entry() {
    let fixture = KnownHostsFixture::new("trust-replaces-hashed-host-entry");
    let target_host = "example.com";
    let target_port = 22;
    let hashed_target_line = format!("{HASHED_EXAMPLE_HOST_PATTERN} {HASHED_EXAMPLE_KEY}");
    let keep_line = format!(
        "{} {}",
        host_pattern("keep-hashed-neighbor.example.com", 22),
        RSA_KEY
    );
    let plain_target_line = format!(
        "{} {}",
        host_pattern(target_host, target_port),
        ED25519_KEY_A
    );
    let target_prefix = format!("{} ", host_pattern(target_host, target_port));

    write_known_host_line(&fixture.path, &hashed_target_line);
    write_known_host(
        &fixture.path,
        "keep-hashed-neighbor.example.com",
        22,
        RSA_KEY,
    );

    let classification =
        classify_host_key(target_host, target_port, ED25519_KEY_A, &fixture.path).unwrap();
    assert_eq!(
        classification,
        HostKeyClassification::Changed {
            fingerprint: sha256_fingerprint(ED25519_KEY_A),
        }
    );

    trust_host_key(
        target_host,
        target_port,
        ED25519_KEY_A,
        &sha256_fingerprint(ED25519_KEY_A),
        &fixture.path,
    )
    .unwrap();

    let known_hosts = fs::read_to_string(&fixture.path).unwrap();
    let lines: Vec<&str> = known_hosts.lines().collect();
    let target_lines: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| line.starts_with(&target_prefix))
        .collect();
    assert_eq!(target_lines, vec![plain_target_line.as_str()]);
    assert!(!lines.contains(&hashed_target_line.as_str()));
    assert!(lines.contains(&keep_line.as_str()));
}

#[test]
fn trust_host_key_rejects_public_key_when_fingerprint_pair_does_not_match() {
    let fixture = KnownHostsFixture::new("reject-fingerprint-mismatch");
    let fingerprint_for_other_key = sha256_fingerprint(ED25519_KEY_B);

    let result = trust_host_key(
        "mismatch.example.com",
        2205,
        ED25519_KEY_A,
        &fingerprint_for_other_key,
        &fixture.path,
    );

    assert!(matches!(
        result,
        Err(TrustHostKeyError::FingerprintMismatch { .. })
    ));
    assert!(!fixture.path.exists());
}

#[test]
fn delete_known_host_removes_only_requested_host_port() {
    let fixture = KnownHostsFixture::new("delete-only-requested-host-port");
    write_known_host(&fixture.path, "delete.example.com", 2206, ED25519_KEY_A);
    write_known_host(&fixture.path, "delete.example.com", 22, ED25519_KEY_B);
    write_known_host(&fixture.path, "keep.example.com", 2206, ED25519_KEY_B);

    delete_known_host("delete.example.com", 2206, &fixture.path).unwrap();

    let deleted_classification =
        classify_host_key("delete.example.com", 2206, ED25519_KEY_A, &fixture.path).unwrap();
    assert_eq!(
        deleted_classification,
        HostKeyClassification::Unknown {
            fingerprint: sha256_fingerprint(ED25519_KEY_A),
        }
    );

    let same_host_other_port =
        classify_host_key("delete.example.com", 22, ED25519_KEY_B, &fixture.path).unwrap();
    assert_eq!(same_host_other_port, HostKeyClassification::Trusted);

    let other_host_same_port =
        classify_host_key("keep.example.com", 2206, ED25519_KEY_B, &fixture.path).unwrap();
    assert_eq!(other_host_same_port, HostKeyClassification::Trusted);
}

#[test]
fn delete_known_host_removes_hashed_host_entry_for_requested_host_port() {
    let fixture = KnownHostsFixture::new("delete-hashed-host-entry");
    let hashed_target_line = format!("{HASHED_EXAMPLE_HOST_PATTERN} {HASHED_EXAMPLE_KEY}");

    write_known_host_line(&fixture.path, &hashed_target_line);
    write_known_host(&fixture.path, "example.com", 2206, ED25519_KEY_A);

    let existing_classification =
        classify_host_key("example.com", 22, HASHED_EXAMPLE_KEY, &fixture.path).unwrap();
    assert_eq!(existing_classification, HostKeyClassification::Trusted);

    delete_known_host("example.com", 22, &fixture.path).unwrap();

    let known_hosts = fs::read_to_string(&fixture.path).unwrap();
    let lines: Vec<&str> = known_hosts.lines().collect();
    assert!(!lines.contains(&hashed_target_line.as_str()));

    let deleted_classification =
        classify_host_key("example.com", 22, HASHED_EXAMPLE_KEY, &fixture.path).unwrap();
    assert_eq!(
        deleted_classification,
        HostKeyClassification::Unknown {
            fingerprint: sha256_fingerprint(HASHED_EXAMPLE_KEY),
        }
    );

    let same_host_other_port =
        classify_host_key("example.com", 2206, ED25519_KEY_A, &fixture.path).unwrap();
    assert_eq!(same_host_other_port, HostKeyClassification::Trusted);
}

#[test]
fn list_known_hosts_for_app_generated_plain_patterns_exposes_settings_display_fields() {
    let fixture = KnownHostsFixture::new("list-app-generated-plain-patterns");
    write_known_host(
        &fixture.path,
        "nonstandard.example.com",
        2207,
        ED25519_KEY_A,
    );
    write_known_host(&fixture.path, "default.example.com", 22, RSA_KEY);

    let entries = list_known_hosts(&fixture.path).unwrap();

    assert_eq!(entries.len(), 2);

    let nonstandard_entry = entries
        .iter()
        .find(|entry| entry.host == "nonstandard.example.com")
        .expect("non-22 host entry should be listed");
    assert_eq!(nonstandard_entry.host, "nonstandard.example.com");
    assert_eq!(nonstandard_entry.port, 2207);
    assert_eq!(nonstandard_entry.algorithm, "ssh-ed25519");
    assert_eq!(nonstandard_entry.public_key, ED25519_KEY_A);
    assert_eq!(
        nonstandard_entry.fingerprint,
        sha256_fingerprint(ED25519_KEY_A)
    );

    let default_port_entry = entries
        .iter()
        .find(|entry| entry.host == "default.example.com")
        .expect("default port host entry should be listed");
    assert_eq!(default_port_entry.host, "default.example.com");
    assert_eq!(default_port_entry.port, 22);
    assert_eq!(default_port_entry.algorithm, "ssh-rsa");
    assert_eq!(default_port_entry.public_key, RSA_KEY);
    assert_eq!(default_port_entry.fingerprint, sha256_fingerprint(RSA_KEY));
}
