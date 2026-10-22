//! Vault export and import: every site's documents, secrets and client
//! certificates in one file, sealed with a key derived from a password
//! (Argon2id, then AES-256-GCM). The data key is wrapped by Windows for one
//! user on one computer, so this file is the only way to move a vault.
//! Only the agent window runs it: a page never sees the password or the file.
#![cfg_attr(not(windows), allow(dead_code))]

use std::fs;

use argon2::{Algorithm, Argon2, Params, Version};
use axum::http::StatusCode;
use chrono::Utc;
use rand::{RngCore, rngs::OsRng};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use super::{
    CERTIFICATES_FILE, CertificateBook, CertificateRecord, MAX_CERTIFICATE_PEM_BYTES,
    MAX_CERTIFICATES, MAX_DOCUMENT_BYTES, MAX_DOCUMENTS, MAX_SECRETS, ORIGIN_LABEL_FILE,
    SECRETS_FILE, SecretBook, StoredDocument, Vault, aad, document_names, document_path,
    normalize_host_patterns, now, origin_directory_name, read_sealed, seal, validate_document_name,
    validate_secret_name, validate_secret_value, vault_corrupt, vault_full, vault_unavailable,
    write_atomic,
};
use crate::{http_transport::ClientIdentity, model::ApiError};

pub(crate) const TRANSFER_EXTENSION: &str = "mdtvx";
pub(crate) const MIN_PASSWORD_CHARS: usize = 8;
const MAX_PASSWORD_BYTES: usize = 1024;
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAGIC: &[u8; 6] = b"MDTVX\x01";
const SALT_LEN: usize = 16;
const HEADER_LEN: usize = MAGIC.len() + 12 + SALT_LEN;
const FORMAT: &str = "mydevtools-vault-export";
/// 64 MiB, 3 passes, 1 lane: slow to guess, under a second on a laptop.
const EXPORT_MEMORY_KIB: u32 = 64 * 1024;
const EXPORT_PASSES: u32 = 3;
const EXPORT_LANES: u32 = 1;
/// Bounds a crafted file cannot exceed before the password is even tried.
const MAX_MEMORY_KIB: u32 = 256 * 1024;
const MAX_PASSES: u32 = 10;
const MAX_LANES: u32 = 4;
const MAX_SITES: usize = 64;

/// What an export wrote or an import applied. `skipped` counts sites an
/// export could not name: they were last used by an agent before 0.4.0.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct TransferSummary {
    pub(crate) sites: usize,
    pub(crate) documents: usize,
    pub(crate) secrets: usize,
    pub(crate) certificates: usize,
    pub(crate) skipped: usize,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bundle {
    format: String,
    version: u32,
    created_at: String,
    sites: Vec<Site>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Site {
    origin: String,
    documents: Vec<Document>,
    secrets: SecretBook,
    certificates: CertificateBook,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    name: String,
    updated_at: String,
    data: Value,
}

impl Vault {
    /// Writes every named site of this vault to `path`, sealed with `password`.
    pub(crate) fn export_to(
        &self,
        path: &std::path::Path,
        password: &str,
    ) -> Result<TransferSummary, ApiError> {
        check_new_password(password)?;
        let (bundle, summary) = self.collect()?;
        let plaintext = serde_json::to_vec(&bundle).map_err(|_| vault_corrupt())?;
        let sealed = seal_bundle(password, plaintext)?;
        write_atomic(path, &sealed)?;
        Ok(summary)
    }

    /// Reads an export and merges it: an item with the same name is replaced,
    /// everything else stays. Nothing is written unless every site fits.
    pub(crate) fn import_from(
        &self,
        path: &std::path::Path,
        password: &str,
    ) -> Result<TransferSummary, ApiError> {
        let size = fs::metadata(path).map_err(|_| vault_unavailable())?.len();
        if size > MAX_FILE_BYTES {
            return Err(transfer_file_invalid());
        }
        let sealed = fs::read(path).map_err(|_| vault_unavailable())?;
        let plaintext = open_bundle(password, &sealed)?;
        let bundle: Bundle =
            serde_json::from_slice(&plaintext).map_err(|_| transfer_file_invalid())?;
        if bundle.format != FORMAT || bundle.version != 1 || bundle.sites.len() > MAX_SITES {
            return Err(transfer_file_invalid());
        }
        for site in &bundle.sites {
            validate_site(site)?;
        }
        self.merge(bundle.sites)
    }

    fn collect(&self) -> Result<(Bundle, TransferSummary), ApiError> {
        let mut key = self.key.lock();
        let key = self.data_key(&mut key)?;
        let root = self.root.as_deref().ok_or_else(vault_unavailable)?;
        let mut summary = TransferSummary::default();
        let mut sites = Vec::new();
        let mut entries: Vec<_> = fs::read_dir(root)
            .map_err(|_| vault_unavailable())?
            .collect::<Result<_, _>>()
            .map_err(|_| vault_unavailable())?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if !entry.file_type().map_err(|_| vault_unavailable())?.is_dir() {
                continue;
            }
            let Some(directory_name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let directory = entry.path();
            let Some(label) = read_sealed(
                &key,
                &directory.join(ORIGIN_LABEL_FILE),
                &aad(&directory_name, "origin", ""),
            )?
            else {
                if has_site_files(&directory)? {
                    summary.skipped += 1;
                }
                continue;
            };
            let origin = String::from_utf8(label).map_err(|_| vault_corrupt())?;
            if origin_directory_name(&origin) != directory_name {
                return Err(vault_corrupt());
            }
            let mut documents = Vec::new();
            let mut names = document_names(&directory)?;
            names.sort();
            for name in names {
                if let Some(document) = self.load_document(&key, &origin, &directory, &name)? {
                    documents.push(Document {
                        name,
                        updated_at: document.updated_at,
                        data: document.data,
                    });
                }
            }
            let secrets = self.load_secrets(&key, &origin, &directory)?;
            let certificates = self.load_certificates(&key, &origin, &directory)?;
            if documents.is_empty() && secrets.is_empty() && certificates.is_empty() {
                continue;
            }
            summary.sites += 1;
            summary.documents += documents.len();
            summary.secrets += secrets.len();
            summary.certificates += certificates.len();
            sites.push(Site {
                origin,
                documents,
                secrets,
                certificates,
            });
        }
        let bundle = Bundle {
            format: FORMAT.to_owned(),
            version: 1,
            created_at: now(),
            sites,
        };
        Ok((bundle, summary))
    }

    fn merge(&self, sites: Vec<Site>) -> Result<TransferSummary, ApiError> {
        let mut key = self.key.lock();
        let key = self.data_key(&mut key)?;
        // Check every limit first, so a full vault fails before any write.
        let mut plans = Vec::with_capacity(sites.len());
        for site in sites {
            let directory = self.origin_directory(&key, &site.origin)?;
            let existing = document_names(&directory)?;
            let added = site
                .documents
                .iter()
                .filter(|document| !existing.contains(&document.name))
                .count();
            let mut secrets = self.load_secrets(&key, &site.origin, &directory)?;
            let mut certificates = self.load_certificates(&key, &site.origin, &directory)?;
            let secret_count = site.secrets.len();
            let certificate_count = site.certificates.len();
            secrets.extend(site.secrets);
            certificates.extend(site.certificates);
            if existing.len() + added > MAX_DOCUMENTS
                || secrets.len() > MAX_SECRETS
                || certificates.len() > MAX_CERTIFICATES
            {
                return Err(vault_full());
            }
            plans.push((
                site.origin,
                directory,
                site.documents,
                secrets,
                certificates,
                secret_count,
                certificate_count,
            ));
        }
        let mut summary = TransferSummary::default();
        for (
            origin,
            directory,
            documents,
            secrets,
            certificates,
            secret_count,
            certificate_count,
        ) in plans
        {
            for document in &documents {
                let revision = self
                    .load_document(&key, &origin, &directory, &document.name)?
                    .map_or(1, |current| current.revision + 1);
                let stored = StoredDocument {
                    revision,
                    updated_at: now(),
                    data: document.data.clone(),
                };
                let plaintext = serde_json::to_vec(&stored).map_err(|_| vault_corrupt())?;
                let sealed = seal(&key, &aad(&origin, "doc", &document.name), plaintext)?;
                write_atomic(&document_path(&directory, &document.name), &sealed)?;
            }
            if secret_count > 0 {
                self.store_secrets(&key, &origin, &directory, &secrets)?;
            }
            if certificate_count > 0 {
                self.store_certificates(&key, &origin, &directory, &certificates)?;
            }
            summary.sites += 1;
            summary.documents += documents.len();
            summary.secrets += secret_count;
            summary.certificates += certificate_count;
        }
        Ok(summary)
    }
}

/// The suggested file name, such as `mydevtools-vault-2026-10-22.mdtvx`.
pub(crate) fn suggested_file_name() -> String {
    format!(
        "mydevtools-vault-{}.{TRANSFER_EXTENSION}",
        Utc::now().format("%Y-%m-%d")
    )
}

fn check_new_password(password: &str) -> Result<(), ApiError> {
    if password.chars().count() < MIN_PASSWORD_CHARS || password.len() > MAX_PASSWORD_BYTES {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "transfer_password_weak",
        ));
    }
    Ok(())
}

fn derive_key(
    password: &str,
    salt: &[u8],
    memory: u32,
    passes: u32,
    lanes: u32,
) -> Result<[u8; 32], ApiError> {
    let params =
        Params::new(memory, passes, lanes, Some(32)).map_err(|_| transfer_file_invalid())?;
    let mut key = [0_u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|_| transfer_file_invalid())?;
    Ok(key)
}

/// `MAGIC | memory | passes | lanes | salt | nonce | ciphertext+tag`; the
/// header up to the nonce is associated data, so its parameters cannot be swapped.
fn seal_bundle(password: &str, mut plaintext: Vec<u8>) -> Result<Vec<u8>, ApiError> {
    let mut salt = [0_u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(MAGIC);
    for value in [EXPORT_MEMORY_KIB, EXPORT_PASSES, EXPORT_LANES] {
        header.extend_from_slice(&value.to_le_bytes());
    }
    header.extend_from_slice(&salt);
    let key = derive_key(
        password,
        &salt,
        EXPORT_MEMORY_KIB,
        EXPORT_PASSES,
        EXPORT_LANES,
    )?;
    let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key).map_err(|_| vault_corrupt())?);
    let mut nonce = [0_u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(&header),
        &mut plaintext,
    )
    .map_err(|_| vault_corrupt())?;
    let mut output = header;
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&plaintext);
    Ok(output)
}

fn open_bundle(password: &str, sealed: &[u8]) -> Result<Vec<u8>, ApiError> {
    if password.is_empty() || password.len() > MAX_PASSWORD_BYTES {
        return Err(transfer_password_invalid());
    }
    if sealed.len() < HEADER_LEN + NONCE_LEN || !sealed.starts_with(MAGIC) {
        return Err(transfer_file_invalid());
    }
    let number = |at: usize| {
        u32::from_le_bytes([sealed[at], sealed[at + 1], sealed[at + 2], sealed[at + 3]])
    };
    let (memory, passes, lanes) = (number(6), number(10), number(14));
    if memory > MAX_MEMORY_KIB
        || passes == 0
        || passes > MAX_PASSES
        || lanes == 0
        || lanes > MAX_LANES
    {
        return Err(transfer_file_invalid());
    }
    let header = &sealed[..HEADER_LEN];
    let salt = &sealed[18..HEADER_LEN];
    let nonce = <[u8; NONCE_LEN]>::try_from(&sealed[HEADER_LEN..HEADER_LEN + NONCE_LEN])
        .map_err(|_| transfer_file_invalid())?;
    let key = derive_key(password, salt, memory, passes, lanes)?;
    let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &key).map_err(|_| vault_corrupt())?);
    let mut ciphertext = sealed[HEADER_LEN + NONCE_LEN..].to_vec();
    let plaintext = key
        .open_in_place(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(header),
            &mut ciphertext,
        )
        .map_err(|_| transfer_password_invalid())?;
    Ok(plaintext.to_vec())
}

/// The same rules a page's own writes pass, so an import cannot plant what
/// the routes would refuse.
fn validate_site(site: &Site) -> Result<(), ApiError> {
    let url = Url::parse(&site.origin).map_err(|_| transfer_file_invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.origin().ascii_serialization() != site.origin
    {
        return Err(transfer_file_invalid());
    }
    if site.documents.len() > MAX_DOCUMENTS
        || site.secrets.len() > MAX_SECRETS
        || site.certificates.len() > MAX_CERTIFICATES
    {
        return Err(transfer_file_invalid());
    }
    let mut names = Vec::with_capacity(site.documents.len());
    for document in &site.documents {
        validate_document_name(&document.name).map_err(|_| transfer_file_invalid())?;
        if names.contains(&&document.name) {
            return Err(transfer_file_invalid());
        }
        names.push(&document.name);
        let size = serde_json::to_vec(&document.data)
            .map_err(|_| transfer_file_invalid())?
            .len();
        if size > MAX_DOCUMENT_BYTES {
            return Err(transfer_file_invalid());
        }
    }
    for (name, record) in &site.secrets {
        validate_secret_name(name).map_err(|_| transfer_file_invalid())?;
        validate_secret_value(&record.value).map_err(|_| transfer_file_invalid())?;
        if normalize_host_patterns(&record.hosts).map_err(|_| transfer_file_invalid())?
            != record.hosts
        {
            return Err(transfer_file_invalid());
        }
    }
    for (name, record) in &site.certificates {
        validate_certificate(name, record)?;
    }
    Ok(())
}

fn validate_certificate(name: &str, record: &CertificateRecord) -> Result<(), ApiError> {
    validate_secret_name(name).map_err(|_| transfer_file_invalid())?;
    if record.certificate_pem.len() > MAX_CERTIFICATE_PEM_BYTES
        || record.key_pem.len() > MAX_CERTIFICATE_PEM_BYTES
        || normalize_host_patterns(&record.hosts).map_err(|_| transfer_file_invalid())?
            != record.hosts
    {
        return Err(transfer_file_invalid());
    }
    ClientIdentity::from_pem(&record.certificate_pem, &record.key_pem)
        .map_err(|_| transfer_file_invalid())?;
    Ok(())
}

/// A directory without a label but with data: written before labels existed.
fn has_site_files(directory: &std::path::Path) -> Result<bool, ApiError> {
    Ok(!document_names(directory)?.is_empty()
        || directory.join(SECRETS_FILE).exists()
        || directory.join(CERTIFICATES_FILE).exists())
}

/// Not an export, a damaged one, or limits a real export never has.
fn transfer_file_invalid() -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "transfer_file_invalid")
}

/// The password does not open this file.
fn transfer_password_invalid() -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "transfer_password_invalid")
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::json;
    use uuid::Uuid;

    use super::*;
    use crate::vault::{CertificateWrite, DocumentWrite, SecretWrite};

    const ORIGIN: &str = "https://mydevtools.app";
    const DEV_ORIGIN: &str = "http://127.0.0.1:3312";
    const PASSWORD: &str = "correct horse battery";

    struct TempVault {
        root: PathBuf,
        vault: Vault,
    }

    impl TempVault {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("mdt-vault-transfer-{}", Uuid::new_v4()));
            Self {
                vault: Vault::new(Some(root.clone())),
                root,
            }
        }

        fn file(&self, name: &str) -> PathBuf {
            self.root.with_extension(name)
        }
    }

    impl Drop for TempVault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
            for extension in ["mdtvx", "bad"] {
                let _ = fs::remove_file(self.root.with_extension(extension));
            }
        }
    }

    fn write_doc(vault: &Vault, origin: &str, name: &str, data: Value) {
        let base_revision = vault
            .read_document(origin, name)
            .map_or(0, |document| document.revision);
        vault
            .write_document(
                origin,
                DocumentWrite {
                    name: name.to_owned(),
                    base_revision,
                    data,
                },
            )
            .unwrap();
    }

    fn write_secret(vault: &Vault, origin: &str, name: &str, value: &str) {
        vault
            .write_secret(
                origin,
                SecretWrite {
                    name: name.to_owned(),
                    value: Some(value.to_owned()),
                    hosts: vec!["api.example.com".to_owned()],
                },
            )
            .unwrap();
    }

    /// A self-signed P-256 certificate and its unencrypted key, from openssl.
    fn certificate() -> (String, String) {
        let dir = std::env::temp_dir().join(format!("mdt-transfer-cert-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let status = std::process::Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "ec",
                "-pkeyopt",
                "ec_paramgen_curve:P-256",
            ])
            .arg("-keyout")
            .arg(dir.join("key.pem"))
            .arg("-out")
            .arg(dir.join("cert.pem"))
            .args(["-days", "2", "-nodes", "-subj", "/CN=mdt-transfer"])
            .stderr(std::process::Stdio::null())
            .status()
            .expect("openssl");
        assert!(status.success(), "openssl certificate");
        let read = |name: &str| fs::read_to_string(dir.join(name)).unwrap();
        let pair = (read("cert.pem"), read("key.pem"));
        let _ = fs::remove_dir_all(&dir);
        pair
    }

    fn code(error: ApiError) -> &'static str {
        error.code
    }

    fn contains(haystack: &[u8], needle: &str) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle.as_bytes())
    }

    #[test]
    fn export_moves_every_site_to_another_vault_and_merges_by_name() {
        let source = TempVault::new();
        let (certificate_pem, key_pem) = certificate();
        write_doc(
            &source.vault,
            ORIGIN,
            "http-workspace",
            json!({"requests": ["moved"]}),
        );
        write_secret(&source.vault, ORIGIN, "apiToken", "s3cr3t-moved-value");
        source
            .vault
            .write_certificate(
                ORIGIN,
                CertificateWrite {
                    name: "client".to_owned(),
                    hosts: vec!["api.example.com".to_owned()],
                    certificate_pem: Some(certificate_pem),
                    key_pem: Some(key_pem),
                },
            )
            .unwrap();
        write_doc(
            &source.vault,
            DEV_ORIGIN,
            "http-history",
            json!({"entries": 1}),
        );
        let file = source.file("mdtvx");
        let exported = source.vault.export_to(&file, PASSWORD).unwrap();
        assert_eq!(
            exported,
            TransferSummary {
                sites: 2,
                documents: 2,
                secrets: 1,
                certificates: 1,
                skipped: 0
            }
        );
        let sealed = fs::read(&file).unwrap();
        assert!(sealed.starts_with(MAGIC));
        for plain in ["s3cr3t-moved-value", "moved", "PRIVATE KEY", ORIGIN] {
            assert!(
                !contains(&sealed, plain),
                "{plain} is readable in the export"
            );
        }

        let target = TempVault::new();
        write_doc(
            &target.vault,
            ORIGIN,
            "http-workspace",
            json!({"requests": ["old"]}),
        );
        write_doc(
            &target.vault,
            ORIGIN,
            "http-workspace",
            json!({"requests": ["older"]}),
        );
        write_secret(&target.vault, ORIGIN, "keepMe", "kept-value");
        let imported = target.vault.import_from(&file, PASSWORD).unwrap();
        assert_eq!(
            imported,
            TransferSummary {
                sites: 2,
                documents: 2,
                secrets: 1,
                certificates: 1,
                skipped: 0
            }
        );

        let workspace = target
            .vault
            .read_document(ORIGIN, "http-workspace")
            .unwrap();
        assert_eq!(workspace.data, json!({"requests": ["moved"]}));
        assert_eq!(
            workspace.revision, 3,
            "an imported document continues the revision count"
        );
        let book = target.vault.secret_book(ORIGIN).unwrap();
        assert_eq!(book["apiToken"].value, "s3cr3t-moved-value");
        assert_eq!(book["keepMe"].value, "kept-value");
        let client = target.vault.certificate(ORIGIN, "client").unwrap();
        assert!(client.identity().is_ok());
        assert_eq!(
            target
                .vault
                .read_document(DEV_ORIGIN, "http-history")
                .unwrap()
                .data,
            json!({"entries": 1})
        );
        assert!(target.vault.list_secrets(DEV_ORIGIN).unwrap().is_empty());
    }

    #[test]
    fn a_wrong_password_a_weak_one_and_a_tampered_file_are_refused() {
        let source = TempVault::new();
        write_secret(&source.vault, ORIGIN, "apiToken", "value-one");
        let file = source.file("mdtvx");
        assert_eq!(
            code(source.vault.export_to(&file, "short").unwrap_err()),
            "transfer_password_weak"
        );
        assert!(!file.exists());
        source.vault.export_to(&file, PASSWORD).unwrap();

        let target = TempVault::new();
        assert_eq!(
            code(
                target
                    .vault
                    .import_from(&file, "wrong password")
                    .unwrap_err()
            ),
            "transfer_password_invalid"
        );
        let mut sealed = fs::read(&file).unwrap();
        sealed[10] ^= 1; // passes: still in bounds, so it derives another key
        let bad = source.file("bad");
        fs::write(&bad, &sealed).unwrap();
        assert_eq!(
            code(target.vault.import_from(&bad, PASSWORD).unwrap_err()),
            "transfer_password_invalid"
        );
        sealed[10] ^= 1;
        sealed[6..10].copy_from_slice(&u32::MAX.to_le_bytes());
        fs::write(&bad, &sealed).unwrap();
        assert_eq!(
            code(target.vault.import_from(&bad, PASSWORD).unwrap_err()),
            "transfer_file_invalid",
            "an oversized memory cost is refused before deriving"
        );
        fs::write(&bad, b"not an export").unwrap();
        assert_eq!(
            code(target.vault.import_from(&bad, PASSWORD).unwrap_err()),
            "transfer_file_invalid"
        );
        assert!(target.vault.list_secrets(ORIGIN).unwrap().is_empty());
    }

    #[test]
    fn content_the_routes_would_refuse_is_not_imported() {
        let target = TempVault::new();
        let file = target.file("bad");
        for site in [
            json!({"origin": "https://mydevtools.app/path", "documents": [], "secrets": {}, "certificates": {}}),
            json!({"origin": ORIGIN, "documents": [{"name": "Bad Name", "updatedAt": "", "data": 1}], "secrets": {}, "certificates": {}}),
            json!({"origin": ORIGIN, "documents": [], "secrets": {"apiToken": {"value": "line\nbreak", "hosts": ["api.example.com"], "updatedAt": ""}}, "certificates": {}}),
            json!({"origin": ORIGIN, "documents": [], "secrets": {"apiToken": {"value": "ok", "hosts": ["*"], "updatedAt": ""}}, "certificates": {}}),
            json!({"origin": ORIGIN, "documents": [], "secrets": {}, "certificates": {"client": {"certificatePem": "x", "keyPem": "y", "hosts": ["api.example.com"], "subject": "", "notAfter": null, "updatedAt": ""}}}),
        ] {
            let bundle = json!({"format": FORMAT, "version": 1, "createdAt": "", "sites": [site]});
            let sealed = seal_bundle(PASSWORD, serde_json::to_vec(&bundle).unwrap()).unwrap();
            fs::write(&file, sealed).unwrap();
            assert_eq!(
                code(target.vault.import_from(&file, PASSWORD).unwrap_err()),
                "transfer_file_invalid",
                "{site}"
            );
        }
        assert!(
            !target
                .root
                .join(origin_directory_name(ORIGIN))
                .join(SECRETS_FILE)
                .exists()
        );
    }

    #[test]
    fn a_full_vault_takes_nothing_from_an_import() {
        let source = TempVault::new();
        write_secret(&source.vault, ORIGIN, "fromExport", "imported-value");
        write_doc(&source.vault, ORIGIN, "one-more", json!(1));
        let file = source.file("mdtvx");
        source.vault.export_to(&file, PASSWORD).unwrap();

        let target = TempVault::new();
        for index in 0..MAX_DOCUMENTS {
            write_doc(&target.vault, ORIGIN, &format!("doc-{index}"), json!(index));
        }
        assert_eq!(
            code(target.vault.import_from(&file, PASSWORD).unwrap_err()),
            "vault_full"
        );
        assert!(
            target.vault.list_secrets(ORIGIN).unwrap().is_empty(),
            "no partial import"
        );
    }

    #[test]
    fn a_site_written_before_labels_is_reported_as_skipped() {
        let source = TempVault::new();
        write_secret(&source.vault, ORIGIN, "apiToken", "value");
        write_doc(&source.vault, DEV_ORIGIN, "http-history", json!([]));
        let directory = source.root.join(origin_directory_name(ORIGIN));
        fs::remove_file(directory.join(ORIGIN_LABEL_FILE)).unwrap();
        let file = source.file("mdtvx");
        let summary = source.vault.export_to(&file, PASSWORD).unwrap();
        assert_eq!(
            summary,
            TransferSummary {
                sites: 1,
                documents: 1,
                secrets: 0,
                certificates: 0,
                skipped: 1
            }
        );
        // The next request from that site writes its label again.
        source.vault.list_secrets(ORIGIN).unwrap();
        assert_eq!(source.vault.export_to(&file, PASSWORD).unwrap().sites, 2);
    }
}
