use serde_json::{Map, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SceneValidationError {
    #[error("scene is {actual_bytes} bytes, exceeding the {maximum_bytes} byte limit")]
    TooLarge {
        actual_bytes: u64,
        maximum_bytes: u64,
    },
    #[error("scene is not valid JSON: {0}")]
    Malformed(#[from] serde_json::Error),
    #[error("scene structure is invalid: {0}")]
    InvalidStructure(&'static str),
}

pub fn validate_scene(bytes: &[u8], maximum_bytes: usize) -> Result<Value, SceneValidationError> {
    if bytes.len() > maximum_bytes {
        return Err(SceneValidationError::TooLarge {
            actual_bytes: bytes.len() as u64,
            maximum_bytes: maximum_bytes as u64,
        });
    }

    let scene: Value = serde_json::from_slice(bytes)?;
    validate_scene_value(&scene)?;
    Ok(scene)
}

fn validate_scene_value(scene: &Value) -> Result<(), SceneValidationError> {
    let object = scene
        .as_object()
        .ok_or(SceneValidationError::InvalidStructure(
            "top-level value must be an object",
        ))?;
    if object.get("type").and_then(Value::as_str) != Some("excalidraw") {
        return Err(SceneValidationError::InvalidStructure(
            "type must equal \"excalidraw\"",
        ));
    }
    let version = object.get("version").and_then(Value::as_u64).ok_or(
        SceneValidationError::InvalidStructure("version must be a positive integer"),
    )?;
    if version == 0 {
        return Err(SceneValidationError::InvalidStructure(
            "version must be a positive integer",
        ));
    }
    if !object.get("elements").is_some_and(Value::is_array) {
        return Err(SceneValidationError::InvalidStructure(
            "elements must be an array",
        ));
    }
    reject_active_content(scene)?;
    Ok(())
}

fn reject_active_content(value: &Value) -> Result<(), SceneValidationError> {
    match value {
        Value::Object(object) => {
            reject_active_content_object(object)?;
            for child in object.values() {
                reject_active_content(child)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                reject_active_content(item)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn reject_active_content_object(object: &Map<String, Value>) -> Result<(), SceneValidationError> {
    for (key, value) in object {
        let normalized = key.to_ascii_lowercase();
        if matches!(
            normalized.as_str(),
            "script" | "srcdoc" | "dangerouslysetinnerhtml"
        ) || (normalized.starts_with("on") && value.is_string())
        {
            return Err(SceneValidationError::InvalidStructure(
                "active-content fields are not allowed",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_type_version_and_elements() {
        for invalid in [
            br#"{}"#.as_slice(),
            br#"{"type":"other","version":2,"elements":[]}"#.as_slice(),
            br#"{"type":"excalidraw","version":0,"elements":[]}"#.as_slice(),
            br#"{"type":"excalidraw","version":2,"elements":{}}"#.as_slice(),
        ] {
            assert!(matches!(
                validate_scene(invalid, 1024),
                Err(SceneValidationError::InvalidStructure(_))
            ));
        }
    }

    #[test]
    fn rejects_active_content_fields_recursively() {
        let scene =
            br#"{"type":"excalidraw","version":2,"elements":[{"customData":{"script":"x"}}]}"#;
        assert!(matches!(
            validate_scene(scene, 1024),
            Err(SceneValidationError::InvalidStructure(_))
        ));
    }
}
