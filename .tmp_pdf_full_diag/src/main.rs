use lopdf::{Document, Object};
use std::env;

fn dump_stream_if_ref(doc: &Document, obj: &lopdf::Object) -> Option<Vec<u8>> {
    if let Ok(r) = obj.as_reference() {
        if let Ok(o) = doc.get_object(r) {
            if let Object::Stream(s) = o {
                if let Ok(b) = s.decompressed_content() {
                    return Some(b);
                }
            }
        }
    }
    None
}

fn main() {
    let path = env::args().nth(1).expect("Provide PDF path");
    let doc = Document::load(&path).expect("Failed to load PDF");

    println!("Total objects: {}", doc.objects.len());

    // iterate font objects
    for (id, obj) in doc.objects.iter() {
        if let Object::Dictionary(d) = obj {
            if let Ok(t) = d.get(b"Type") {
                if let Ok(name) = t.as_name() {
                    if name == b"Font" {
                        println!(
                            "Font Obj {:?}: dict keys={:?}",
                            id,
                            d.iter().map(|(k, _)| k).collect::<Vec<_>>()
                        );
                        if let Ok(fd) = d.get(b"FontDescriptor") {
                            println!(" FontDescriptor: {:?}", fd);
                            // if FontDescriptor is a reference to a dict, inspect it
                            if let Some(fdref) = dump_stream_if_ref(&doc, &fd) {
                                // it's a stream - print len
                                println!("  FontDescriptor stream len={}", fdref.len());
                            } else if let Ok(fd_ref) = fd.as_reference() {
                                if let Ok(fd_obj) = doc.get_object(fd_ref) {
                                    if let Ok(fd_dict) = fd_obj.as_dict() {
                                        println!(
                                            "  FD keys: {:?}",
                                            fd_dict.iter().map(|(k, _)| k).collect::<Vec<_>>()
                                        );
                                        if fd_dict.get(b"FontFile2").is_ok() {
                                            println!("  Has FontFile2");
                                        }
                                        if fd_dict.get(b"FontFile3").is_ok() {
                                            println!("  Has FontFile3");
                                        }
                                        if let Ok(c) = fd_dict.get(b"CIDToGIDMap") {
                                            println!("  CIDToGIDMap: {:?}", c);
                                            if let Some(bytes) = dump_stream_if_ref(&doc, c) {
                                                println!(
                                                    "   CIDToGIDMap stream len={}",
                                                    bytes.len()
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Print all ToUnicode streams
    for (id, obj) in doc.objects.iter() {
        if let Object::Stream(s) = obj {
            if let Ok(sub) = s.dict.get(b"Subtype") {
                if let Ok(name) = sub.as_name() {
                    if name == b"ToUnicode" || s.dict.get(b"ToUnicode").is_ok() {
                        if let Ok(b) = s.decompressed_content() {
                            println!("ToUnicode stream obj {:?} len={}", id, b.len());
                            let sample = String::from_utf8_lossy(&b[..std::cmp::min(200, b.len())]);
                            println!("Sample: {}", sample);
                        }
                    }
                }
            }
        }
    }
}
