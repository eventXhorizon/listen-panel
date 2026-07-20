use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::sync::broadcast;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::layer::Context;

/// How many live entries may queue up for a slow SSE client before it is told
/// it fell behind (and simply resumes from the next line).
const BROADCAST_CAPACITY: usize = 256;

/// One captured log line, shaped for the 日志 page.
#[derive(Clone, Debug, Serialize)]
pub struct LogEntry {
    /// Monotonic per-process counter. Lets the stream replay the backlog and
    /// then push live lines without the client having to guess which ones it
    /// already has, and gives the UI a stable key.
    pub seq: u64,
    pub ts: DateTime<Utc>,
    pub level: String,
    pub target: String,
    pub message: String,
}

/// A bounded, in-memory ring of the most recent log lines, plus a broadcast
/// channel so open SSE streams get each new line as it happens.
///
/// The server logs to stdout, which the browser can't read, and writing a log
/// file would drag in rotation and a disk budget for something only ever read
/// live. Keeping the tail in memory answers "what is the server doing / why
/// did that request fail" at the cost of starting empty after a restart.
#[derive(Clone)]
pub struct LogBuffer {
    entries: Arc<Mutex<VecDeque<LogEntry>>>,
    capacity: usize,
    next_seq: Arc<AtomicU64>,
    tx: broadcast::Sender<LogEntry>,
}

impl LogBuffer {
    pub fn new(capacity: usize) -> Self {
        let (tx, _rx) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            entries: Arc::new(Mutex::new(VecDeque::new())),
            capacity: capacity.max(1),
            next_seq: Arc::new(AtomicU64::new(1)),
            tx,
        }
    }

    fn push(&self, mut entry: LogEntry) {
        entry.seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        {
            // A poisoned lock must never take the process down over a log line.
            let Ok(mut entries) = self.entries.lock() else {
                return;
            };
            while entries.len() >= self.capacity {
                entries.pop_front();
            }
            entries.push_back(entry.clone());
        }
        // Errors here only mean nobody is streaming right now.
        let _ = self.tx.send(entry);
    }

    /// The most recent `limit` entries, oldest first.
    pub fn snapshot(&self, limit: usize) -> Vec<LogEntry> {
        let Ok(entries) = self.entries.lock() else {
            return Vec::new();
        };
        let skip = entries.len().saturating_sub(limit);
        entries.iter().skip(skip).cloned().collect()
    }

    /// Live feed of lines logged from now on.
    pub fn subscribe(&self) -> broadcast::Receiver<LogEntry> {
        self.tx.subscribe()
    }
}

/// Feeds a [`LogBuffer`] from the tracing pipeline.
pub struct LogLayer {
    buffer: LogBuffer,
}

impl LogLayer {
    pub fn new(buffer: LogBuffer) -> Self {
        Self { buffer }
    }
}

impl<S: Subscriber> Layer<S> for LogLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        let meta = event.metadata();
        self.buffer.push(LogEntry {
            seq: 0, // assigned by push()
            ts: Utc::now(),
            level: meta.level().to_string(),
            target: meta.target().to_string(),
            message: visitor.finish(),
        });
    }
}

/// Pulls `message` out of an event and keeps any other fields as `key=value`,
/// so structured logs stay readable rather than losing their context.
#[derive(Default)]
struct MessageVisitor {
    message: String,
    fields: Vec<String>,
}

impl MessageVisitor {
    fn finish(self) -> String {
        if self.fields.is_empty() {
            self.message
        } else if self.message.is_empty() {
            self.fields.join(" ")
        } else {
            format!("{} {}", self.message, self.fields.join(" "))
        }
    }
}

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
        } else {
            self.fields.push(format!("{}={:?}", field.name(), value));
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.fields.push(format!("{}={value}", field.name()));
        }
    }
}
