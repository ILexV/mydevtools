//! Server-Sent Events (`sse.stream`). A 2xx `text/event-stream` reply of
//! `http.request` is parked unread; `/v1/sse/stream` with the same id then
//! sends its events to the page as NDJSON lines while they arrive. The parser
//! follows the WHATWG event stream rules: `event`, `data`, `id`, `retry`,
//! comments, and CR, LF or CRLF line ends.

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use axum::body::Body;
use bytes::Bytes;
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::{OwnedSemaphorePermit, mpsc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    http_client::EventStream,
    state::{ActiveRequestGuard, SessionKey},
};

/// How long a parked stream waits for the page before it is closed.
const PARK_LIFETIME: Duration = Duration::from_secs(30);
const MAX_PARKED: usize = 8;
/// One event's data; a bigger one ends the stream with `event_too_large`.
const MAX_EVENT_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub(crate) struct ParkedStreams(Mutex<HashMap<(SessionKey, Uuid), (Instant, EventStream)>>);

impl ParkedStreams {
    /// Holds the stream for the page; the oldest one makes room when full.
    pub(crate) fn park(&self, session: SessionKey, id: Uuid, stream: EventStream) {
        let mut parked = self.0.lock();
        let now = Instant::now();
        parked.retain(|_, (since, _)| now.duration_since(*since) < PARK_LIFETIME);
        while parked.len() >= MAX_PARKED {
            let Some(oldest) = parked
                .iter()
                .min_by_key(|(_, (since, _))| *since)
                .map(|(key, _)| *key)
            else {
                break;
            };
            parked.remove(&oldest);
        }
        parked.insert((session, id), (now, stream));
    }

    pub(crate) fn take(&self, session: SessionKey, id: Uuid) -> Option<EventStream> {
        let (since, stream) = self.0.lock().remove(&(session, id))?;
        (since.elapsed() < PARK_LIFETIME).then_some(stream)
    }

    /// Closes streams the page did not pick up in time.
    pub(crate) fn prune(&self) {
        self.0
            .lock()
            .retain(|_, (since, _)| since.elapsed() < PARK_LIFETIME);
    }

    pub(crate) fn forget_session(&self, session: &SessionKey) {
        self.0.lock().retain(|(owner, _), _| owner != session);
    }

    pub(crate) fn clear(&self) {
        self.0.lock().clear();
    }
}

/// One NDJSON line of the stream.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum StreamLine {
    #[serde(rename_all = "camelCase")]
    Event {
        event: String,
        data: String,
        #[serde(skip_serializing_if = "String::is_empty")]
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry: Option<u64>,
    },
    End,
    Error {
        code: &'static str,
    },
}

/// Incremental event stream parser: feed chunks, collect complete events.
#[derive(Default)]
pub(crate) struct Parser {
    line: Vec<u8>,
    /// The previous chunk ended with CR: a leading LF belongs to that line end.
    after_cr: bool,
    started: bool,
    event: String,
    data: String,
    has_data: bool,
    last_id: String,
    retry: Option<u64>,
}

impl Parser {
    pub(crate) fn feed(&mut self, chunk: &[u8]) -> Result<Vec<StreamLine>, &'static str> {
        let mut events = Vec::new();
        let mut bytes = chunk;
        if !self.started && !bytes.is_empty() {
            self.started = true;
            bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
        }
        for &byte in bytes {
            if self.after_cr {
                self.after_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            match byte {
                b'\r' | b'\n' => {
                    self.after_cr = byte == b'\r';
                    let line = std::mem::take(&mut self.line);
                    if let Some(event) = self.process(&line) {
                        events.push(event);
                    }
                }
                _ => {
                    if self.line.len() >= MAX_EVENT_BYTES {
                        return Err("event_too_large");
                    }
                    self.line.push(byte);
                }
            }
            if self.data.len() > MAX_EVENT_BYTES {
                return Err("event_too_large");
            }
        }
        Ok(events)
    }

    fn process(&mut self, line: &[u8]) -> Option<StreamLine> {
        if line.is_empty() {
            return self.dispatch();
        }
        if line[0] == b':' {
            return None;
        }
        let text = String::from_utf8_lossy(line);
        let (field, value) = match text.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (text.as_ref(), ""),
        };
        match field {
            "event" => value.clone_into(&mut self.event),
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            "id" if !value.contains('\0') => value.clone_into(&mut self.last_id),
            "retry" if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) => {
                self.retry = value.parse().ok();
            }
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<StreamLine> {
        let event = std::mem::take(&mut self.event);
        let retry = self.retry.take();
        if !self.has_data {
            return None;
        }
        self.has_data = false;
        Some(StreamLine::Event {
            event: if event.is_empty() {
                "message".to_owned()
            } else {
                event
            },
            data: std::mem::take(&mut self.data),
            id: self.last_id.clone(),
            retry,
        })
    }
}

fn line(value: &StreamLine) -> Bytes {
    let mut bytes = serde_json::to_vec(value).unwrap_or_default();
    bytes.push(b'\n');
    Bytes::from(bytes)
}

/// The response body: events while they arrive, then `end` or `error`. A page
/// that stops reading, a cancel or a revoked session closes the upstream.
pub(crate) fn body(
    mut stream: EventStream,
    cancellation: CancellationToken,
    guard: ActiveRequestGuard,
    permit: OwnedSemaphorePermit,
) -> Body {
    let (sender, receiver) = mpsc::channel::<Bytes>(16);
    tokio::spawn(async move {
        let _held = (guard, permit);
        let mut parser = Parser::default();
        let last = loop {
            let chunk = tokio::select! {
                _ = cancellation.cancelled() => break StreamLine::End,
                _ = sender.closed() => return,
                chunk = stream.body.chunk() => chunk,
            };
            let chunk = match chunk {
                None => break StreamLine::End,
                Some(Err(error)) => break StreamLine::Error { code: error.code },
                Some(Ok(chunk)) => chunk,
            };
            match parser.feed(&chunk) {
                Ok(events) => {
                    for event in events {
                        let event = match event {
                            StreamLine::Event {
                                event,
                                data,
                                id,
                                retry,
                            } if !stream.substitutions.is_empty() => StreamLine::Event {
                                event,
                                data: stream.substitutions.redact_str(&data),
                                id,
                                retry,
                            },
                            other => other,
                        };
                        if sender.send(line(&event)).await.is_err() {
                            return;
                        }
                    }
                }
                Err(code) => break StreamLine::Error { code },
            }
        };
        let _ = sender.send(line(&last)).await;
    });
    Body::from_stream(futures_util::stream::unfold(
        receiver,
        |mut receiver| async move {
            receiver
                .recv()
                .await
                .map(|bytes| (Ok::<_, std::convert::Infallible>(bytes), receiver))
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(chunks: &[&[u8]]) -> Vec<StreamLine> {
        let mut parser = Parser::default();
        chunks
            .iter()
            .flat_map(|chunk| parser.feed(chunk).unwrap())
            .collect()
    }

    fn event(event: &str, data: &str, id: &str, retry: Option<u64>) -> StreamLine {
        StreamLine::Event {
            event: event.to_owned(),
            data: data.to_owned(),
            id: id.to_owned(),
            retry,
        }
    }

    #[test]
    fn fields_comments_and_multiline_data() {
        assert_eq!(
            events(&[
                b"\xEF\xBB\xBF: comment\ndata: first\ndata:second\n\n",
                b"event: update\nid: 7\nretry: 1500\ndata: {\"a\":1}\n\n",
                b"data\n\nid\nevent: ping\n\n",
                b"data: unterminated"
            ]),
            [
                event("message", "first\nsecond", "", None),
                event("update", "{\"a\":1}", "7", Some(1500)),
                event("message", "", "7", None),
            ]
        );
    }

    #[test]
    fn line_ends_split_across_chunks() {
        assert_eq!(
            events(&[b"data: a\r", b"\ndata: b\r\r", b"data: c\n", b"\n"]),
            [
                event("message", "a\nb", "", None),
                event("message", "c", "", None),
            ]
        );
        assert_eq!(
            events(&[b"da", b"ta: x", b"\r\n\r", b"\n"]),
            [event("message", "x", "", None)]
        );
    }

    #[test]
    fn an_oversized_event_stops_the_stream() {
        let mut parser = Parser::default();
        let big = vec![b'x'; 600 * 1024];
        let mut chunk = b"data: ".to_vec();
        chunk.extend_from_slice(&big);
        chunk.push(b'\n');
        assert!(parser.feed(&chunk).is_ok());
        assert_eq!(parser.feed(&chunk), Err("event_too_large"));
    }

    #[test]
    fn lines_serialize_for_the_page() {
        assert_eq!(
            line(&event("message", "hi", "", None)),
            Bytes::from_static(b"{\"type\":\"event\",\"event\":\"message\",\"data\":\"hi\"}\n")
        );
        assert_eq!(
            line(&StreamLine::End),
            Bytes::from_static(b"{\"type\":\"end\"}\n")
        );
    }
}
