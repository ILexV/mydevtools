use lopdf::Document;
use std::path::Path;

fn main() {
    let path = std::env::args().nth(1).expect("Provide path to PDF");
    let doc = Document::load(&path).expect("Failed to load PDF");
    let mut pages: Vec<u32> = doc.get_pages().keys().cloned().collect();
    pages.sort();
    match doc.extract_text(&pages) {
        Ok(text) => {
            println!("Extracted {} chars", text.len());
            std::fs::write("extracted.txt", text).expect("Failed to write output");
            println!("Wrote extracted.txt");
        }
        Err(e) => {
            eprintln!("extract_text error: {:?}", e);
        }
    }
}
