//! The system UI language list, read once at startup for the handshake.
//!
//! Rust only reports the raw BCP-47 tags; choosing the UI language is the
//! frontend's `resolveLanguage`, so the rule lives in one place.

/// Upper bound on the tags forwarded to the frontend.
pub const MAX_PREFERRED_LANGUAGES: usize = 16;

/// macOS: `NSLocale.preferredLanguages`, in the user's order.
#[cfg(target_os = "macos")]
pub fn preferred_languages() -> Vec<String> {
    objc2_foundation::NSLocale::preferredLanguages()
        .to_vec()
        .iter()
        .take(MAX_PREFERRED_LANGUAGES)
        .map(|tag| tag.to_string())
        .collect()
}

/// Other platforms: the POSIX locale from `LC_ALL`, then `LANG`.
#[cfg(not(target_os = "macos"))]
pub fn preferred_languages() -> Vec<String> {
    ["LC_ALL", "LANG"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .find(|value| !value.is_empty())
        .and_then(|value| posix_locale_to_bcp47(&value))
        .into_iter()
        .collect()
}

/// Convert `ll_CC.charset@modifier` to `ll-CC`; `C`/`POSIX` carry no language.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn posix_locale_to_bcp47(value: &str) -> Option<String> {
    let base = value.split(['.', '@']).next().unwrap_or_default();
    if base.is_empty() || base == "C" || base == "POSIX" {
        return None;
    }
    let tag = base.replace('_', "-");
    let valid = tag
        .split('-')
        .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric()));
    valid.then_some(tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_posix_locales_to_bcp47_tags() {
        assert_eq!(
            posix_locale_to_bcp47("zh_CN.UTF-8").as_deref(),
            Some("zh-CN")
        );
        assert_eq!(
            posix_locale_to_bcp47("en_US@euro").as_deref(),
            Some("en-US")
        );
        assert_eq!(posix_locale_to_bcp47("zh").as_deref(), Some("zh"));
    }

    #[test]
    fn treats_neutral_or_malformed_locales_as_unknown() {
        for value in ["", "C", "POSIX", "C.UTF-8", "en__US", "zh CN"] {
            assert_eq!(posix_locale_to_bcp47(value), None, "{value:?}");
        }
    }

    #[test]
    fn never_reports_more_than_the_limit() {
        assert!(preferred_languages().len() <= MAX_PREFERRED_LANGUAGES);
    }
}
