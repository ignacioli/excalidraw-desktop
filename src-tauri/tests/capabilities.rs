//! The frontend may write text to the clipboard (Copy Path) and nothing
//! else: no clipboard read, image, HTML or clear permission in any
//! capability file.

use std::fs;
use std::path::PathBuf;

fn capability_permissions() -> Vec<(String, String)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("capabilities");
    let mut permissions = Vec::new();
    for entry in fs::read_dir(&dir).expect("capabilities directory is readable") {
        let path = entry.expect("capability entry is readable").path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let text = fs::read_to_string(&path).expect("capability file is readable");
        let json: serde_json::Value =
            serde_json::from_str(&text).expect("capability file is valid JSON");
        let file = path.display().to_string();
        for permission in json["permissions"]
            .as_array()
            .expect("capability lists permissions")
        {
            let identifier = permission
                .as_str()
                .or_else(|| permission["identifier"].as_str())
                .expect("permission has an identifier");
            permissions.push((file.clone(), identifier.to_owned()));
        }
    }
    permissions
}

#[test]
fn clipboard_grants_write_text_only() {
    let clipboard: Vec<_> = capability_permissions()
        .into_iter()
        .filter(|(_, identifier)| identifier.starts_with("clipboard-manager:"))
        .collect();
    assert!(
        clipboard
            .iter()
            .any(|(_, identifier)| identifier == "clipboard-manager:allow-write-text"),
        "Copy Path needs clipboard-manager:allow-write-text"
    );
    let extra: Vec<_> = clipboard
        .iter()
        .filter(|(_, identifier)| identifier != "clipboard-manager:allow-write-text")
        .collect();
    assert!(
        extra.is_empty(),
        "only clipboard text writing is granted, found {extra:?}"
    );
}
