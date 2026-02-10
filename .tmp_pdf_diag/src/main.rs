use lopdf::{Document, Object};
use std::env;

fn main() {
    let path = env::args().nth(1).expect("Provide PDF path");
    let doc = Document::load(&path).expect("Failed to load PDF");

    let mut pages: Vec<u32> = doc.get_pages().keys().cloned().collect();
    pages.sort();

    for p in pages {
        println!("--- PAGE {} ---", p);
        if let Some(&page_id) = doc.get_pages().get(&p) {
            if let Ok(page_obj) = doc.get_object(page_id) {
                if let Ok(page_dict) = page_obj.as_dict() {
                    if let Ok(resources_ref) =
                        page_dict.get(b"Resources").and_then(|r| r.as_reference())
                    {
                        if let Ok(resources_obj) = doc.get_object(resources_ref) {
                            if let Ok(res_dict) = resources_obj.as_dict() {
                                if let Ok(fonts_obj) = res_dict.get(b"Font") {
                                    if let Ok(fonts) = fonts_obj.as_dict() {
                                        for (fname, fval) in fonts.iter() {
                                            let fname_s = String::from_utf8_lossy(fname);
                                            println!("Font resource: {}", fname_s);
                                            if let Ok(fref) = fval.as_reference() {
                                                if let Ok(fobj) = doc.get_object(fref) {
                                                    println!(
                                                        " Font object type: {:?}",
                                                        fobj.type_name()
                                                    );
                                                    if let Ok(fdict) = fobj.as_dict() {
                                                        if let Ok(base) = fdict.get(b"BaseFont") {
                                                            println!("  BaseFont: {:?}", base);
                                                        }
                                                        if let Ok(sub) = fdict.get(b"Subtype") {
                                                            println!("  Subtype: {:?}", sub);
                                                        }
                                                        if let Ok(tu) = fdict.get(b"ToUnicode") {
                                                            println!("  Has ToUnicode: {:?}", tu);
                                                        }
                                                        if let Ok(desc) =
                                                            fdict.get(b"DescendantFonts")
                                                        {
                                                            println!(
                                                                "  DescendantFonts: {:?}",
                                                                desc
                                                            );
                                                        }
                                                        // If DescendantFonts present, inspect
                                                        if let Ok(arr) = fdict
                                                            .get(b"DescendantFonts")
                                                            .and_then(|a| a.as_array())
                                                        {
                                                            for el in arr.iter() {
                                                                if let Ok(dref) = el.as_reference()
                                                                {
                                                                    if let Ok(dobj) =
                                                                        doc.get_object(dref)
                                                                    {
                                                                        if let Ok(dd) =
                                                                            dobj.as_dict()
                                                                        {
                                                                            println!("   Descendant BaseFont: {:?}", dd.get(b"BaseFont"));
                                                                            println!("   CIDToGIDMap: {:?}", dd.get(b"CIDToGIDMap"));
                                                                            println!(
                                                                                "   DW: {:?}",
                                                                                dd.get(b"DW")
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
                            }
                        }
                    }
                }
            }
        }
    }
}
