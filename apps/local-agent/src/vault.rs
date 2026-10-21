//! Encrypted on-disk vault: page documents with revisions and write-only secrets.
//! One random data key per computer, wrapped by Windows DPAPI for the current
//! user. Every file is AES-256-GCM with origin, kind and name as associated data,
//! so a file cannot be swapped for another. Each origin has its own directory.

use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use axum::http::StatusCode;
use chrono::{SecondsFormat, Utc};
use parking_lot::Mutex;
use rand::{RngCore, rngs::OsRng};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::{Host, Url};
use uuid::Uuid;

use crate::model::ApiError;

pub(crate) const MAX_DOCUMENT_BYTES: usize = 1536 * 1024;
pub(crate) const MAX_DOCUMENTS: usize = 64;
pub(crate) const MAX_SECRETS: usize = 256;
pub(crate) const MAX_SECRET_VALUE_BYTES: usize = 8 * 1024;
pub(crate) const MAX_SECRET_HOSTS: usize = 16;
const MAX_NAME_BYTES: usize = 64;
const MAX_HOST_PATTERN_BYTES: usize = 253;
const FILE_MAGIC: &[u8; 5] = b"MDTV\x01";
const FILE_EXTENSION: &str = "mdtv";
const DOCUMENT_PREFIX: &str = "doc-";
const SECRETS_FILE: &str = "secrets.mdtv";
const PLACEHOLDER_OPEN: &[u8] = b"{{secret:";
const PLACEHOLDER_CLOSE: &[u8] = b"}}";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DocumentName {
    pub(crate) name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DocumentWrite {
    pub(crate) name: String,
    /// 0 creates the document; otherwise the revision the page last read.
    pub(crate) base_revision: u64,
    pub(crate) data: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DocumentDelete {
    pub(crate) name: String,
    pub(crate) base_revision: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SecretWrite {
    pub(crate) name: String,
    /// Absent keeps the stored value and replaces only the host list.
    pub(crate) value: Option<String>,
    pub(crate) hosts: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SecretName {
    pub(crate) name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentOutput {
    pub(crate) name: String,
    pub(crate) revision: u64,
    pub(crate) updated_at: String,
    pub(crate) data: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentInfo {
    pub(crate) name: String,
    pub(crate) revision: u64,
    pub(crate) updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevisionOutput {
    pub(crate) revision: u64,
}

/// What a page may see about a secret: never the value.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SecretInfo {
    pub(crate) name: String,
    pub(crate) hosts: Vec<String>,
    pub(crate) updated_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredDocument {
    revision: u64,
    updated_at: String,
    data: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SecretRecord {
    value: String,
    hosts: Vec<String>,
    updated_at: String,
}

pub(crate) type SecretBook = BTreeMap<String, SecretRecord>;

pub(crate) struct Vault {
    root: Option<PathBuf>,
    /// Cached data key. The lock also serializes every file operation.
    key: Mutex<Option<[u8; 32]>>,
}

impl Vault {
    pub(crate) fn new(root: Option<PathBuf>) -> Self {
        Self {
            root,
            key: Mutex::new(None),
        }
    }

    pub(crate) fn available(&self) -> bool {
        self.root.is_some()
    }

    pub(crate) fn list_documents(&self, origin: &str) -> Result<Vec<DocumentInfo>, ApiError> {
        let mut key = self.key.lock();
        let key = self.data_key(&mut key)?;
        let directory = self.origin_directory(origin)?;
        let mut output = Vec::new();
        for name in document_names(&directory)? {
            let document = self.load_document(&key, origin, &directory, &name)?;
            if let Some(document) = document {
                output.push(DocumentInfo {
                    name,
                    revision: document.revision,
                    updated_at: document.updated_at,
                });
            }
        }
        output.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(output)
    }

    pub(crate) fn read_document(
        &self,
        origin: &str,
        name: &str,
    ) -> Result<DocumentOutput, ApiError> {
        validate_document_name(name)?;
        let mut key = self.key.lock();
        let key = self.data_key(&mut key)?;
        let directory = self.origin_directory(origin)?;
        let document = self
            .load_document(&key, origin, &directory, name)?
            .ok_or_else(ApiError::not_found)?;
        Ok(DocumentOutput {
            name: name.to_owned(),
            revision: document.revision,
            updated_at: document.updated_at,
            data: document.data,
        })
    }

    /// Optimistic write: a stale `base_revision` gets `revision_conflict`, so two
    /// desktop windows never silently overwrite each other's save.
    pub(crate) fn write_document(
        &self,
        origin: &str,
        input: DocumentWrite,
    ) -> Result<RevisionOutput, ApiError> {
        validate_document_name(&input.name)?;
        let mut key = self.key.lock();
        let key = self.data_key(&mut key)?;
        let directory = self.origin_directory(origin)?;
        let current = self.load_document(&key, origin, &directory, &input.name)?;
        let revision = match &current {
            Some(document) if document.revision == input.base_revision => document.revision + 1,
            None if input.base_revision == 0 => {
                if document_names(&directory)?.len() >= MAX_DOCUMENTS {
                    return Err(vault_full());
                }
                1
            }
            _ => return Err(revision_conflict()),
        };
        let stored = StoredDocument {
            revision,
            updated_at: now(),
            data: input.data,
        };
        let plaintext = serde_json::to_vec(&stored).map_err(|_| ApiError::invalid_request())?;
        if plaintext.len() > MAX_DOCUMENT_BYTES {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request_too_large",
            ));
        }
        let sealed = seal(&key, &aad(origin, "doc", &input.name), plaintext)?;
        write_atomic(&document_path(&directory, &input.name), &sealed)?;
        Ok(RevisionOutput { revision })
    }

    pub(crate) fn delete_document(
        &self,
        origin: &str,
        input: DocumentDelete,
    ) -> Result<(), ApiError> {
        validate_document_name(&input.name)?;
        let mut key = self.key.lock();
        let key = self.data_key(&mut key)?;
        let directory = self.origin_directory(origin)?;
        let current = self
            .load_document(&key, origin, &directory, &input.name)?
            .ok_or_else(ApiError::not_found)?;
        if current.revision != input.base_revision {
            return Err(revision_conflict());
        }
        fs::remove_file(document_path(&directory, &input.name)).map_err(|_| vault_unavailable())
    }

    pub(crate) fn list_secrets(&self, origin: &str) -> Result<Vec<SecretInfo>, ApiError> {
        Ok(self
            .secret_book(origin)?
            .into_iter()
            .map(|(name, record)| SecretInfo {
                name,
                hosts: record.hosts,
                updated_at: record.updated_at,
            })
            .collect())
    }

    pub(crate) fn write_secret(&self, origin: &str, input: SecretWrite) -> Result<(), ApiError> {
        validate_secret_name(&input.name)?;
        let hosts = normalize_host_patterns(&input.hosts)?;
        if let Some(value) = &input.value {
            validate_secret_value(value)?;
        }
        let mut key = self.key.lock();
        let key = self.data_key(&mut key)?;
        let directory = self.origin_directory(origin)?;
        let mut book = self.load_secrets(&key, origin, &directory)?;
        let value = match (input.value, book.get(&input.name)) {
            (Some(value), _) => value,
            (None, Some(existing)) => existing.value.clone(),
            (None, None) => return Err(ApiError::not_found()),
        };
        if !book.contains_key(&input.name) && book.len() >= MAX_SECRETS {
            return Err(vault_full());
        }
        book.insert(
            input.name,
            SecretRecord {
                value,
                hosts,
                updated_at: now(),
            },
        );
        self.store_secrets(&key, origin, &directory, &book)
    }

    pub(crate) fn delete_secret(&self, origin: &str, name: &str) -> Result<(), ApiError> {
        validate_secret_name(name)?;
        let mut key = self.key.lock();
        let key = self.data_key(&mut key)?;
        let directory = self.origin_directory(origin)?;
        let mut book = self.load_secrets(&key, origin, &directory)?;
        if book.remove(name).is_none() {
            return Err(ApiError::not_found());
        }
        self.store_secrets(&key, origin, &directory, &book)
    }

    /// Values for agent-side substitution. Never serialized back to a page.
    pub(crate) fn secret_book(&self, origin: &str) -> Result<SecretBook, ApiError> {
        let mut key = self.key.lock();
        let key = self.data_key(&mut key)?;
        let directory = self.origin_directory(origin)?;
        self.load_secrets(&key, origin, &directory)
    }

    /// Loads or creates the data key. A missing key next to existing encrypted
    /// files is reported, never replaced: a new key would orphan that data.
    fn data_key(&self, cached: &mut Option<[u8; 32]>) -> Result<[u8; 32], ApiError> {
        if let Some(key) = cached {
            return Ok(*key);
        }
        let root = self.root.as_deref().ok_or_else(vault_unavailable)?;
        create_private_dir(root)?;
        let key_path = root.join(platform::KEY_FILE);
        let key = match fs::read(&key_path) {
            Ok(wrapped) => {
                let raw = platform::unprotect(&wrapped).ok_or_else(key_unavailable)?;
                <[u8; 32]>::try_from(raw.as_slice()).map_err(|_| key_unavailable())?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if has_encrypted_files(root)? {
                    return Err(key_unavailable());
                }
                let mut key = [0_u8; 32];
                OsRng.fill_bytes(&mut key);
                let wrapped = platform::protect(&key).ok_or_else(key_unavailable)?;
                write_atomic(&key_path, &wrapped)?;
                key
            }
            Err(_) => return Err(vault_unavailable()),
        };
        *cached = Some(key);
        Ok(key)
    }

    fn origin_directory(&self, origin: &str) -> Result<PathBuf, ApiError> {
        let root = self.root.as_deref().ok_or_else(vault_unavailable)?;
        let digest = Sha256::digest(origin.as_bytes());
        let directory = root.join(hex::encode(&digest[..16]));
        create_private_dir(&directory)?;
        Ok(directory)
    }

    fn load_document(
        &self,
        key: &[u8; 32],
        origin: &str,
        directory: &Path,
        name: &str,
    ) -> Result<Option<StoredDocument>, ApiError> {
        let Some(plaintext) = read_sealed(
            key,
            &document_path(directory, name),
            &aad(origin, "doc", name),
        )?
        else {
            return Ok(None);
        };
        serde_json::from_slice(&plaintext)
            .map(Some)
            .map_err(|_| vault_corrupt())
    }

    fn load_secrets(
        &self,
        key: &[u8; 32],
        origin: &str,
        directory: &Path,
    ) -> Result<SecretBook, ApiError> {
        let Some(plaintext) = read_sealed(
            key,
            &directory.join(SECRETS_FILE),
            &aad(origin, "secrets", ""),
        )?
        else {
            return Ok(SecretBook::new());
        };
        serde_json::from_slice(&plaintext).map_err(|_| vault_corrupt())
    }

    fn store_secrets(
        &self,
        key: &[u8; 32],
        origin: &str,
        directory: &Path,
        book: &SecretBook,
    ) -> Result<(), ApiError> {
        let plaintext = serde_json::to_vec(book).map_err(|_| vault_corrupt())?;
        let sealed = seal(key, &aad(origin, "secrets", ""), plaintext)?;
        write_atomic(&directory.join(SECRETS_FILE), &sealed)
    }
}

/// `%APPDATA%\MyDevTools\Agent\vault` on Windows, the XDG data directory elsewhere.
pub(crate) fn default_root() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .filter(|value| !value.is_empty())
            .map(|value| {
                PathBuf::from(value)
                    .join("MyDevTools")
                    .join("Agent")
                    .join("vault")
            })
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .filter(|value| !value.is_empty())
                    .map(|home| PathBuf::from(home).join(".local").join("share"))
            })
            .map(|base| base.join("mydevtools-agent").join("vault"))
    }
}

/// Collects the secrets a request uses, checks hosts and redacts echoes.
#[derive(Default)]
pub(crate) struct Substitutions {
    used: Vec<(String, SecretRecord)>,
}

impl Substitutions {
    pub(crate) fn is_empty(&self) -> bool {
        self.used.is_empty()
    }

    /// Replaces every `{{secret:name}}`. An unknown name is an error, and a
    /// malformed placeholder is rejected instead of being sent literally.
    pub(crate) fn apply(&mut self, input: &[u8], book: &SecretBook) -> Result<Vec<u8>, ApiError> {
        let mut output = Vec::with_capacity(input.len());
        let mut rest = input;
        while let Some(start) = find(rest, PLACEHOLDER_OPEN) {
            output.extend_from_slice(&rest[..start]);
            let after_open = &rest[start + PLACEHOLDER_OPEN.len()..];
            let end = find(after_open, PLACEHOLDER_CLOSE).ok_or_else(ApiError::invalid_request)?;
            let name =
                std::str::from_utf8(&after_open[..end]).map_err(|_| ApiError::invalid_request())?;
            validate_secret_name(name)?;
            let record = book.get(name).ok_or_else(secret_not_found)?;
            output.extend_from_slice(record.value.as_bytes());
            if !self.used.iter().any(|(used, _)| used == name) {
                self.used.push((name.to_owned(), record.clone()));
            }
            rest = &after_open[end + PLACEHOLDER_CLOSE.len()..];
        }
        output.extend_from_slice(rest);
        Ok(output)
    }

    /// True when every used secret lists this URL's host.
    pub(crate) fn host_allowed(&self, url: &Url) -> bool {
        let Some(host) = url.host_str() else {
            return false;
        };
        self.used.iter().all(|(_, record)| {
            record
                .hosts
                .iter()
                .any(|pattern| host_matches(pattern, host))
        })
    }

    /// Replaces echoed secret values with their placeholders, longest first.
    /// Covers a plain echo, not an encoded or transformed value.
    pub(crate) fn redact(&self, input: &[u8]) -> Vec<u8> {
        let mut used: Vec<_> = self.used.iter().collect();
        used.sort_by_key(|(_, record)| std::cmp::Reverse(record.value.len()));
        let mut output = input.to_vec();
        for (name, record) in used {
            let placeholder = format!("{{{{secret:{name}}}}}");
            output = replace_all(&output, record.value.as_bytes(), placeholder.as_bytes());
        }
        output
    }

    pub(crate) fn redact_str(&self, input: &str) -> String {
        String::from_utf8(self.redact(input.as_bytes()))
            .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
    }
}

pub(crate) fn mentions_secret(input: &[u8]) -> bool {
    find(input, PLACEHOLDER_OPEN).is_some()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn replace_all(input: &[u8], needle: &[u8], replacement: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(input.len());
    let mut rest = input;
    while let Some(position) = find(rest, needle) {
        output.extend_from_slice(&rest[..position]);
        output.extend_from_slice(replacement);
        rest = &rest[position + needle.len()..];
    }
    output.extend_from_slice(rest);
    output
}

fn host_matches(pattern: &str, host: &str) -> bool {
    match pattern.strip_prefix("*.") {
        Some(domain) => host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.len() > 1 && prefix.ends_with('.')),
        None => pattern == host,
    }
}

/// `api.example.com`, `127.0.0.1`, `[::1]` or `*.example.com`. A wildcard
/// covers subdomains only, needs a dotted domain and never an IP address.
fn normalize_host_patterns(patterns: &[String]) -> Result<Vec<String>, ApiError> {
    if patterns.is_empty() || patterns.len() > MAX_SECRET_HOSTS {
        return Err(ApiError::invalid_request());
    }
    let mut output: Vec<String> = Vec::with_capacity(patterns.len());
    for pattern in patterns {
        let pattern = pattern.trim();
        if pattern.is_empty() || pattern.len() > MAX_HOST_PATTERN_BYTES {
            return Err(ApiError::invalid_request());
        }
        let (wildcard, host) = match pattern.strip_prefix("*.") {
            Some(rest) => (true, rest),
            None => (false, pattern),
        };
        let parsed =
            Url::parse(&format!("http://{host}/")).map_err(|_| ApiError::invalid_request())?;
        let normalized = parsed.host_str().ok_or_else(ApiError::invalid_request)?;
        let plain_domain = matches!(parsed.host(), Some(Host::Domain(domain))
            if domain.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.')));
        // `host:80` would silently lose its default port, so any port is refused.
        let has_port = !host.starts_with('[') && host.contains(':');
        if parsed.as_str() != format!("http://{normalized}/")
            || has_port
            || (matches!(parsed.host(), Some(Host::Domain(_))) && !plain_domain)
        {
            return Err(ApiError::invalid_request());
        }
        let normalized = if wildcard {
            if !matches!(parsed.host(), Some(Host::Domain(domain)) if domain.contains('.')) {
                return Err(ApiError::invalid_request());
            }
            format!("*.{normalized}")
        } else {
            normalized.to_owned()
        };
        if !output.contains(&normalized) {
            output.push(normalized);
        }
    }
    Ok(output)
}

/// Lowercase file-safe names: `http-workspace`, `http-environments`.
fn validate_document_name(name: &str) -> Result<(), ApiError> {
    let mut bytes = name.bytes();
    let valid = name.len() <= MAX_NAME_BYTES
        && bytes
            .next()
            .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        });
    if valid {
        Ok(())
    } else {
        Err(ApiError::invalid_request())
    }
}

fn validate_secret_name(name: &str) -> Result<(), ApiError> {
    let mut bytes = name.bytes();
    let valid = name.len() <= MAX_NAME_BYTES
        && bytes
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(())
    } else {
        Err(ApiError::invalid_request())
    }
}

/// A value goes into headers, URLs and bodies, so it must not break a line.
fn validate_secret_value(value: &str) -> Result<(), ApiError> {
    if value.is_empty()
        || value.len() > MAX_SECRET_VALUE_BYTES
        || value.chars().any(|character| character.is_control())
    {
        return Err(ApiError::invalid_request());
    }
    Ok(())
}

fn aad(origin: &str, kind: &str, name: &str) -> Vec<u8> {
    format!("mydevtools-vault-v1\0{origin}\0{kind}\0{name}").into_bytes()
}

fn seal(key: &[u8; 32], aad: &[u8], mut plaintext: Vec<u8>) -> Result<Vec<u8>, ApiError> {
    let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).map_err(|_| vault_corrupt())?);
    let mut nonce = [0_u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(aad),
        &mut plaintext,
    )
    .map_err(|_| vault_corrupt())?;
    let mut output = Vec::with_capacity(FILE_MAGIC.len() + NONCE_LEN + plaintext.len());
    output.extend_from_slice(FILE_MAGIC);
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&plaintext);
    Ok(output)
}

fn read_sealed(key: &[u8; 32], path: &Path, aad: &[u8]) -> Result<Option<Vec<u8>>, ApiError> {
    let sealed = match fs::read(path) {
        Ok(sealed) => sealed,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(vault_unavailable()),
    };
    if sealed.len() < FILE_MAGIC.len() + NONCE_LEN || !sealed.starts_with(FILE_MAGIC) {
        return Err(vault_corrupt());
    }
    let nonce =
        <[u8; NONCE_LEN]>::try_from(&sealed[FILE_MAGIC.len()..FILE_MAGIC.len() + NONCE_LEN])
            .map_err(|_| vault_corrupt())?;
    let mut ciphertext = sealed[FILE_MAGIC.len() + NONCE_LEN..].to_vec();
    let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).map_err(|_| vault_corrupt())?);
    let plaintext = key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(aad),
            &mut ciphertext,
        )
        .map_err(|_| vault_corrupt())?;
    Ok(Some(plaintext.to_vec()))
}

fn document_path(directory: &Path, name: &str) -> PathBuf {
    directory.join(format!("{DOCUMENT_PREFIX}{name}.{FILE_EXTENSION}"))
}

fn document_names(directory: &Path) -> Result<Vec<String>, ApiError> {
    let entries = fs::read_dir(directory).map_err(|_| vault_unavailable())?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| vault_unavailable())?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let Some(name) = file_name
            .strip_prefix(DOCUMENT_PREFIX)
            .and_then(|rest| rest.strip_suffix(&format!(".{FILE_EXTENSION}")))
        else {
            continue;
        };
        if validate_document_name(name).is_ok() {
            names.push(name.to_owned());
        }
    }
    Ok(names)
}

fn has_encrypted_files(root: &Path) -> Result<bool, ApiError> {
    let entries = fs::read_dir(root).map_err(|_| vault_unavailable())?;
    for entry in entries {
        let entry = entry.map_err(|_| vault_unavailable())?;
        if !entry.file_type().map_err(|_| vault_unavailable())?.is_dir() {
            continue;
        }
        let inner = fs::read_dir(entry.path()).map_err(|_| vault_unavailable())?;
        for file in inner {
            let file = file.map_err(|_| vault_unavailable())?;
            if file
                .path()
                .extension()
                .is_some_and(|extension| extension == FILE_EXTENSION)
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Temporary file, flush to disk, then rename over the target: a crash leaves
/// either the old file or the new one, never a torn write.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), ApiError> {
    let directory = path.parent().ok_or_else(vault_unavailable)?;
    let temporary = directory.join(format!(".tmp-{}", Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(vault_unavailable());
    }
    Ok(())
}

fn create_private_dir(path: &Path) -> Result<(), ApiError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|_| vault_unavailable())
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// No data directory, or the disk refused a read or write.
fn vault_unavailable() -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "vault_unavailable")
}

/// The key could not be unwrapped (another Windows user or computer), or it is
/// missing while encrypted files remain.
fn key_unavailable() -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "vault_key_unavailable")
}

/// A file failed authentication or does not parse.
fn vault_corrupt() -> ApiError {
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "vault_corrupt")
}

fn vault_full() -> ApiError {
    ApiError::new(StatusCode::INSUFFICIENT_STORAGE, "vault_full")
}

fn revision_conflict() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "revision_conflict")
}

pub(crate) fn secret_not_found() -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "secret_not_found")
}

pub(crate) fn secret_host_denied() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "secret_host_denied")
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };

    pub(super) const KEY_FILE: &str = "key.dpapi";
    const ENTROPY: &[u8] = b"MyDevTools Local Agent vault key v1";

    /// DPAPI in the current user's scope: only this Windows account can unwrap.
    pub(super) fn protect(data: &[u8]) -> Option<Vec<u8>> {
        transform(data, true)
    }

    pub(super) fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        transform(data, false)
    }

    fn transform(data: &[u8], protect: bool) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(data.len()).ok()?,
            pbData: data.as_ptr().cast_mut(),
        };
        let entropy = CRYPT_INTEGER_BLOB {
            cbData: ENTROPY.len() as u32,
            pbData: ENTROPY.as_ptr().cast_mut(),
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: the blobs point at live slices for the duration of the call;
        // DPAPI allocates the output with LocalAlloc and it is freed below.
        let ok = unsafe {
            if protect {
                CryptProtectData(
                    &input,
                    std::ptr::null(),
                    &entropy,
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    std::ptr::null_mut(),
                    &entropy,
                    std::ptr::null(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            }
        };
        if ok == 0 || output.pbData.is_null() {
            return None;
        }
        // SAFETY: DPAPI returned `cbData` bytes at `pbData`.
        let bytes =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        // SAFETY: `pbData` came from DPAPI's LocalAlloc.
        unsafe { LocalFree(output.pbData.cast()) };
        Some(bytes)
    }
}

/// Development builds only: the key is a `0600` file, not encryption at rest.
#[cfg(not(windows))]
mod platform {
    pub(super) const KEY_FILE: &str = "key.bin";

    pub(super) fn protect(data: &[u8]) -> Option<Vec<u8>> {
        Some(data.to_vec())
    }

    pub(super) fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        Some(data.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book() -> SecretBook {
        SecretBook::from([(
            "apiToken".to_owned(),
            SecretRecord {
                value: "s3cr3t-value".to_owned(),
                hosts: vec!["api.example.com".to_owned(), "*.example.org".to_owned()],
                updated_at: now(),
            },
        )])
    }

    #[test]
    fn placeholders_substitute_check_hosts_and_redact_echoes() {
        let mut substitutions = Substitutions::default();
        let output = substitutions
            .apply(b"Bearer {{secret:apiToken}}", &book())
            .unwrap();
        assert_eq!(output, b"Bearer s3cr3t-value");
        assert!(substitutions.host_allowed(&Url::parse("https://api.example.com/x").unwrap()));
        assert!(substitutions.host_allowed(&Url::parse("https://a.b.example.org/").unwrap()));
        assert!(!substitutions.host_allowed(&Url::parse("https://example.org/").unwrap()));
        assert!(!substitutions.host_allowed(&Url::parse("https://evil-example.org/").unwrap()));
        assert!(!substitutions.host_allowed(&Url::parse("https://api.example.com.evil/").unwrap()));
        assert_eq!(
            substitutions.redact(b"echo: s3cr3t-value!"),
            b"echo: {{secret:apiToken}}!"
        );

        let mut empty = Substitutions::default();
        assert_eq!(
            empty.apply(b"no placeholder", &book()).unwrap(),
            b"no placeholder"
        );
        assert!(empty.is_empty());
        assert_eq!(
            empty
                .apply(b"{{secret:missing}}", &book())
                .unwrap_err()
                .code,
            "secret_not_found"
        );
        assert_eq!(
            empty.apply(b"{{secret:apiToken", &book()).unwrap_err().code,
            "invalid_request"
        );
        assert_eq!(
            empty.apply(b"{{secret:../x}}", &book()).unwrap_err().code,
            "invalid_request"
        );
    }

    #[test]
    fn host_patterns_are_normalized_and_broad_wildcards_rejected() {
        assert_eq!(
            normalize_host_patterns(&[
                " API.Example.com ".to_owned(),
                "*.Example.org".to_owned(),
                "127.0.0.1".to_owned(),
                "[::1]".to_owned(),
                "api.example.com".to_owned(),
            ])
            .unwrap(),
            vec!["api.example.com", "*.example.org", "127.0.0.1", "[::1]"]
        );
        for bad in [
            "*.com",
            "*.127.0.0.1",
            "api.example.com:443",
            "user@api.example.com",
            "api.example.com/path",
            "api.example.com:80",
            "*",
            "",
        ] {
            assert!(
                normalize_host_patterns(&[bad.to_owned()]).is_err(),
                "{bad} must be rejected"
            );
        }
        assert!(normalize_host_patterns(&[]).is_err());
    }
}
