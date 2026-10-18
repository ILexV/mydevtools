use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};

use axum::http::StatusCode;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{SecondsFormat, Utc};
use parking_lot::Mutex;
use rand::{RngCore, rngs::OsRng};
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::model::{ApiError, HTTP_CAPABILITY, PairRequest, PairResponse};

const PAIRING_LIFETIME: Duration = Duration::from_secs(5 * 60);
const SESSION_LIFETIME: Duration = Duration::from_secs(8 * 60 * 60);
const PAIRING_ATTEMPT_WINDOW: Duration = Duration::from_secs(60);
const MAX_FAILED_PAIRING_ATTEMPTS: usize = 10;
const MAX_SESSIONS: usize = 32;
const MAX_CONCURRENT_REQUESTS: usize = 8;
const MAX_CANCELLATION_TOMBSTONES: usize = 256;
const CANCELLATION_TOMBSTONE_LIFETIME: Duration = Duration::from_secs(5 * 60);

pub(crate) type SessionKey = [u8; 32];

#[derive(Clone, Debug)]
pub(crate) struct AgentConfig {
    pub(crate) port: u16,
    pub(crate) allow_private: bool,
    pub(crate) allowed_origins: HashSet<String>,
}

pub(crate) struct AgentState {
    pub(crate) config: AgentConfig,
    pub(crate) expected_host: String,
    pairing: Mutex<PairingState>,
    pairing_code: watch::Sender<String>,
    sessions: Mutex<HashMap<SessionKey, Session>>,
    concurrency: Arc<Semaphore>,
}

struct PairingState {
    code: [u8; 16],
    expires: Instant,
    failed_attempts: VecDeque<Instant>,
}

struct Session {
    origin: String,
    expires: Instant,
    http_request_allowed: bool,
    active: HashMap<Uuid, CancellationToken>,
    cancellation_tombstones: HashMap<Uuid, Instant>,
}

pub(crate) struct ActiveRequestGuard {
    state: Arc<AgentState>,
    session_key: SessionKey,
    request_id: Uuid,
}

impl AgentState {
    pub(crate) fn new(config: AgentConfig) -> Arc<Self> {
        let pairing = PairingState::new();
        let (pairing_code, _) = watch::channel(pairing.code_string());
        let expected_host = format!("127.0.0.1:{}", config.port);
        Arc::new(Self {
            config,
            expected_host,
            pairing: Mutex::new(pairing),
            pairing_code,
            sessions: Mutex::new(HashMap::new()),
            concurrency: Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS)),
        })
    }

    pub(crate) fn pairing_codes(&self) -> watch::Receiver<String> {
        self.pairing_code.subscribe()
    }

    pub(crate) fn rotate_pairing_if_expired(&self) {
        let mut pairing = self.pairing.lock();
        if Instant::now() < pairing.expires {
            return;
        }
        pairing.refresh();
        self.pairing_code.send_replace(pairing.code_string());
    }

    pub(crate) fn pair(
        &self,
        request: PairRequest,
        origin: &str,
    ) -> Result<PairResponse, ApiError> {
        if request.capabilities.len() != 1 || request.capabilities[0] != HTTP_CAPABILITY {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "unsupported_capability",
            ));
        }

        let now = Instant::now();
        let mut pairing = self.pairing.lock();
        while pairing
            .failed_attempts
            .front()
            .is_some_and(|attempt| now.duration_since(*attempt) >= PAIRING_ATTEMPT_WINDOW)
        {
            pairing.failed_attempts.pop_front();
        }
        if pairing.failed_attempts.len() >= MAX_FAILED_PAIRING_ATTEMPTS {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "pairing_rate_limited",
            ));
        }
        if now >= pairing.expires {
            pairing.refresh();
            self.pairing_code.send_replace(pairing.code_string());
            return Err(ApiError::new(StatusCode::GONE, "pairing_expired"));
        }

        let mut presented = [0_u8; 16];
        let code_matches = hex::decode_to_slice(request.code.as_bytes(), &mut presented).is_ok()
            && constant_time_eq::constant_time_eq(&pairing.code, &presented);
        if !code_matches {
            pairing.failed_attempts.push_back(now);
            return Err(ApiError::new(StatusCode::UNAUTHORIZED, "pairing_invalid"));
        }
        pairing.refresh();
        self.pairing_code.send_replace(pairing.code_string());

        let mut sessions = self.sessions.lock();
        remove_expired_sessions(&mut sessions, now);
        if sessions.len() >= MAX_SESSIONS {
            return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "busy"));
        }

        let (token, token_digest) = loop {
            let mut token_bytes = [0_u8; 32];
            OsRng.fill_bytes(&mut token_bytes);
            let token = URL_SAFE_NO_PAD.encode(token_bytes);
            let digest = token_digest(&token);
            if !sessions.contains_key(&digest) {
                break (token, digest);
            }
        };
        let expires_at = (Utc::now() + chrono::Duration::hours(8))
            .to_rfc3339_opts(SecondsFormat::Secs, true);
        sessions.insert(
            token_digest,
            Session {
                origin: origin.to_owned(),
                expires: now + SESSION_LIFETIME,
                http_request_allowed: true,
                active: HashMap::new(),
                cancellation_tombstones: HashMap::new(),
            },
        );

        Ok(PairResponse {
            token,
            capabilities: [HTTP_CAPABILITY],
            expires_at,
        })
    }

    pub(crate) fn authorize_http(
        &self,
        authorization: Option<&str>,
        origin: &str,
    ) -> Result<SessionKey, ApiError> {
        let key = parse_authorization(authorization)?;
        let now = Instant::now();
        let mut sessions = self.sessions.lock();
        if sessions.get(&key).is_some_and(|session| now >= session.expires) {
            if let Some(expired) = sessions.remove(&key) {
                cancel_session(expired);
            }
            return Err(ApiError::unauthorized());
        }
        let session = sessions.get(&key).ok_or_else(ApiError::unauthorized)?;
        if session.origin != origin {
            return Err(ApiError::forbidden());
        }
        if !session.http_request_allowed {
            return Err(ApiError::forbidden());
        }
        Ok(key)
    }

    pub(crate) fn revoke(&self, session_key: SessionKey) {
        if let Some(session) = self.sessions.lock().remove(&session_key) {
            cancel_session(session);
        }
    }

    pub(crate) fn revoke_all(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock());
        for session in sessions.into_values() {
            cancel_session(session);
        }
    }

    pub(crate) fn expire_sessions(&self) {
        remove_expired_sessions(&mut self.sessions.lock(), Instant::now());
    }

    pub(crate) fn try_acquire_request_slot(&self) -> Result<OwnedSemaphorePermit, ApiError> {
        Arc::clone(&self.concurrency)
            .try_acquire_owned()
            .map_err(|_| ApiError::new(StatusCode::TOO_MANY_REQUESTS, "busy"))
    }

    pub(crate) fn register_request(
        self: &Arc<Self>,
        session_key: SessionKey,
        request_id: Uuid,
        cancellation: CancellationToken,
    ) -> Result<ActiveRequestGuard, ApiError> {
        let now = Instant::now();
        let mut sessions = self.sessions.lock();
        let session = sessions
            .get_mut(&session_key)
            .ok_or_else(ApiError::unauthorized)?;
        prune_tombstones(session, now);
        if session.cancellation_tombstones.remove(&request_id).is_some() {
            cancellation.cancel();
            return Err(ApiError::new(StatusCode::CONFLICT, "cancelled"));
        }
        if session.active.contains_key(&request_id) {
            return Err(ApiError::invalid_request());
        }
        session.active.insert(request_id, cancellation);
        Ok(ActiveRequestGuard {
            state: Arc::clone(self),
            session_key,
            request_id,
        })
    }

    pub(crate) fn cancel_request(
        &self,
        session_key: SessionKey,
        request_id: Uuid,
    ) -> Result<(), ApiError> {
        let now = Instant::now();
        let mut sessions = self.sessions.lock();
        let session = sessions
            .get_mut(&session_key)
            .ok_or_else(ApiError::unauthorized)?;
        if let Some(cancellation) = session.active.get(&request_id) {
            cancellation.cancel();
            return Ok(());
        }

        prune_tombstones(session, now);
        if session.cancellation_tombstones.len() >= MAX_CANCELLATION_TOMBSTONES {
            if let Some(oldest) = session
                .cancellation_tombstones
                .iter()
                .min_by_key(|(_, created)| **created)
                .map(|(id, _)| *id)
            {
                session.cancellation_tombstones.remove(&oldest);
            }
        }
        session.cancellation_tombstones.insert(request_id, now);
        Ok(())
    }
}

impl Drop for ActiveRequestGuard {
    fn drop(&mut self) {
        if let Some(session) = self.state.sessions.lock().get_mut(&self.session_key) {
            session.active.remove(&self.request_id);
        }
    }
}

impl PairingState {
    fn new() -> Self {
        let mut state = Self {
            code: [0; 16],
            expires: Instant::now(),
            failed_attempts: VecDeque::new(),
        };
        state.refresh();
        state
    }

    fn refresh(&mut self) {
        OsRng.fill_bytes(&mut self.code);
        self.expires = Instant::now() + PAIRING_LIFETIME;
        self.failed_attempts.clear();
    }

    fn code_string(&self) -> String {
        hex::encode(self.code)
    }
}

fn parse_authorization(authorization: Option<&str>) -> Result<SessionKey, ApiError> {
    let authorization = authorization.ok_or_else(ApiError::unauthorized)?;
    let token = authorization
        .strip_prefix("Bearer ")
        .filter(|token| token.len() == 43 && !token.bytes().any(|byte| byte.is_ascii_whitespace()))
        .ok_or_else(ApiError::unauthorized)?;
    Ok(token_digest(token))
}

fn token_digest(token: &str) -> SessionKey {
    Sha256::digest(token.as_bytes()).into()
}

fn remove_expired_sessions(sessions: &mut HashMap<SessionKey, Session>, now: Instant) {
    let expired: Vec<_> = sessions
        .iter()
        .filter_map(|(key, session)| (now >= session.expires).then_some(*key))
        .collect();
    for key in expired {
        if let Some(session) = sessions.remove(&key) {
            cancel_session(session);
        }
    }
}

fn cancel_session(session: Session) {
    for cancellation in session.active.into_values() {
        cancellation.cancel();
    }
}

fn prune_tombstones(session: &mut Session, now: Instant) {
    session.cancellation_tombstones.retain(|_, created| {
        now.duration_since(*created) < CANCELLATION_TOMBSTONE_LIFETIME
    });
}

#[cfg(test)]
impl AgentState {
    pub(crate) fn replace_pairing_code(&self, code: [u8; 16]) -> String {
        let mut pairing = self.pairing.lock();
        pairing.code = code;
        pairing.expires = Instant::now() + PAIRING_LIFETIME;
        pairing.failed_attempts.clear();
        let code = pairing.code_string();
        self.pairing_code.send_replace(code.clone());
        code
    }
}
