//! Bounded text extraction. Originals are only read; no scripts or external resources run.
use std::{
    io::{Cursor, Read},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use quick_xml::{Reader, events::Event};

pub(super) const MAX_SOURCE_BYTES: usize = 16 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_PAGES: usize = 256;
const MAX_EXTRACTION_TIME: Duration = Duration::from_secs(2);

pub(super) struct PageText {
    pub start: usize,
    pub end: usize,
    pub page: usize,
}

pub(super) struct ExtractedText {
    pub text: String,
    pub pages: Vec<PageText>,
}

impl ExtractedText {
    pub(super) fn plain(text: String) -> Self {
        Self {
            text,
            pages: Vec::new(),
        }
    }
}

pub(super) fn extract(kind: &str, bytes: &[u8], cancel: &AtomicBool) -> Option<ExtractedText> {
    let started = Instant::now();
    let stopped = || cancel.load(Ordering::Acquire) || started.elapsed() >= MAX_EXTRACTION_TIME;
    if stopped() || bytes.len() > MAX_SOURCE_BYTES {
        return None;
    }
    let text = match kind {
        "pdf" => pdf(bytes, &stopped),
        "docx" => docx(bytes, &stopped).map(ExtractedText::plain),
        _ => None,
    }?;
    (!text.text.trim().is_empty() && text.text.len() <= MAX_TEXT_BYTES && !stopped())
        .then_some(text)
}

fn pdf(bytes: &[u8], stopped: &impl Fn() -> bool) -> Option<ExtractedText> {
    let document = lopdf::Document::load_mem_with_options(
        bytes,
        lopdf::LoadOptions::with_max_decompressed_size(MAX_TEXT_BYTES),
    )
    .ok()?;
    if document.is_encrypted() {
        return None;
    }
    let pages = document.get_pages();
    if pages.len() > MAX_PAGES {
        return None;
    }
    let mut text = String::new();
    let mut ranges = Vec::with_capacity(pages.len());
    for page in pages.keys() {
        if stopped() {
            return None;
        }
        let part = document
            .extract_text_with_limit(&[*page], MAX_TEXT_BYTES)
            .ok()?;
        if text.len() + part.len() + 1 > MAX_TEXT_BYTES {
            return None;
        }
        let start = text.len();
        text.push_str(&part);
        ranges.push(PageText {
            start,
            end: text.len(),
            page: *page as usize,
        });
        text.push('\n');
    }
    Some(ExtractedText {
        text,
        pages: ranges,
    })
}

fn docx(bytes: &[u8], stopped: &impl Fn() -> bool) -> Option<String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).ok()?;
    // Do not unpack paths or load relationships, embedded files, scripts, or external resources.
    let mut part = archive.by_name("word/document.xml").ok()?;
    if part.size() > MAX_TEXT_BYTES as u64 {
        return None;
    }
    let mut xml = String::new();
    part.by_ref()
        .take((MAX_TEXT_BYTES + 1) as u64)
        .read_to_string(&mut xml)
        .ok()?;
    if xml.len() > MAX_TEXT_BYTES || stopped() {
        return None;
    }
    let mut reader = Reader::from_str(&xml);
    let mut text = String::new();
    let mut in_text = false;
    loop {
        if stopped() || text.len() > MAX_TEXT_BYTES {
            return None;
        }
        match reader.read_event().ok()? {
            Event::Start(tag) if tag.local_name().as_ref() == "t" => in_text = true,
            Event::End(tag) => match tag.local_name().as_ref() {
                "t" => in_text = false,
                "p" | "tr" => text.push('\n'),
                "tc" => text.push('\t'),
                _ => {}
            },
            Event::Empty(tag) => match tag.local_name().as_ref() {
                "tab" => text.push('\t'),
                "br" | "cr" => text.push('\n'),
                _ => {}
            },
            Event::Text(value) if in_text => text.push_str(&value.xml10_content()),
            Event::CData(value) if in_text => text.push_str(&value.xml10_content()),
            Event::GeneralRef(value) if in_text => {
                if let Some(character) = value.resolve_char_ref().ok()? {
                    text.push(character);
                } else {
                    text.push_str(match value.as_ref() {
                        "amp" => "&",
                        "lt" => "<",
                        "gt" => ">",
                        "quot" => "\"",
                        "apos" => "'",
                        _ => return None,
                    });
                }
            }
            Event::DocType(_) => return None,
            Event::Eof => return Some(text),
            _ => {}
        }
    }
}
