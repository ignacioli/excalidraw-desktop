#![allow(
    dead_code,
    reason = "Phase 2 establishes path authorization before later filesystem commands consume it"
)]

use std::path::{Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum PathSecurityError {
    #[error("failed to canonicalize {path}: {source}")]
    Canonicalize {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("workspace root is not a directory: {0}")]
    WorkspaceNotDirectory(PathBuf),
    #[error("workspace roots overlap: {first} and {second}")]
    WorkspaceOverlap { first: PathBuf, second: PathBuf },
    #[error("path is outside every mounted workspace: {0}")]
    AccessDenied(PathBuf),
    #[error("path has no existing parent that can be authorized: {0}")]
    MissingParent(PathBuf),
}

#[derive(Debug, Clone)]
pub struct WorkspacePathPolicy {
    roots: Vec<PathBuf>,
}

impl WorkspacePathPolicy {
    pub fn new<I, P>(roots: I) -> Result<Self, PathSecurityError>
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let mut canonical_roots: Vec<PathBuf> = Vec::new();
        for root in roots {
            let root = canonicalize(root.as_ref())?;
            if !root.is_dir() {
                return Err(PathSecurityError::WorkspaceNotDirectory(root));
            }
            if let Some(existing) = canonical_roots
                .iter()
                .find(|existing| root.starts_with(existing) || existing.starts_with(&root))
            {
                return Err(PathSecurityError::WorkspaceOverlap {
                    first: existing.clone(),
                    second: root,
                });
            }
            canonical_roots.push(root);
        }
        Ok(Self {
            roots: canonical_roots,
        })
    }

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    pub fn authorize_existing(&self, candidate: &Path) -> Result<PathBuf, PathSecurityError> {
        let canonical = canonicalize(candidate)?;
        self.ensure_allowed(canonical)
    }

    pub fn authorize_for_creation(&self, candidate: &Path) -> Result<PathBuf, PathSecurityError> {
        let file_name = candidate
            .file_name()
            .ok_or_else(|| PathSecurityError::MissingParent(candidate.to_path_buf()))?;
        let parent = candidate
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let canonical_parent = canonicalize(parent)?;
        let authorized_parent = self.ensure_allowed(canonical_parent)?;
        Ok(authorized_parent.join(file_name))
    }

    pub fn contains(&self, canonical_path: &Path) -> bool {
        self.roots
            .iter()
            .any(|root| canonical_path.starts_with(root))
    }

    fn ensure_allowed(&self, canonical: PathBuf) -> Result<PathBuf, PathSecurityError> {
        if self.contains(&canonical) {
            Ok(canonical)
        } else {
            Err(PathSecurityError::AccessDenied(canonical))
        }
    }
}

fn canonicalize(path: &Path) -> Result<PathBuf, PathSecurityError> {
    path.canonicalize()
        .map_err(|source| PathSecurityError::Canonicalize {
            path: path.to_path_buf(),
            source,
        })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn accepts_paths_below_a_workspace_and_rejects_traversal() {
        let fixture = fixture_directory("prefix");
        let workspace = fixture.join("workspace");
        let outside = fixture.join("outside");
        fs::create_dir_all(&workspace).unwrap_or_else(|error| panic!("create workspace: {error}"));
        fs::create_dir_all(&outside).unwrap_or_else(|error| panic!("create outside: {error}"));
        let inside_file = workspace.join("drawing.excalidraw");
        let outside_file = outside.join("secret.excalidraw");
        fs::write(&inside_file, "{}").unwrap_or_else(|error| panic!("write inside file: {error}"));
        fs::write(&outside_file, "{}")
            .unwrap_or_else(|error| panic!("write outside file: {error}"));

        let policy = WorkspacePathPolicy::new([&workspace])
            .unwrap_or_else(|error| panic!("create policy: {error}"));
        assert_eq!(
            policy
                .authorize_existing(&inside_file)
                .unwrap_or_else(|error| panic!("authorize: {error}")),
            inside_file
                .canonicalize()
                .unwrap_or_else(|error| panic!("canonicalize fixture: {error}"))
        );
        assert!(matches!(
            policy.authorize_existing(&workspace.join("../outside/secret.excalidraw")),
            Err(PathSecurityError::AccessDenied(_))
        ));
        assert!(matches!(
            policy.authorize_for_creation(&outside.join("new.excalidraw")),
            Err(PathSecurityError::AccessDenied(_))
        ));
        fs::remove_dir_all(fixture).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_that_escapes_the_workspace() {
        use std::os::unix::fs::symlink;

        let fixture = fixture_directory("symlink");
        let workspace = fixture.join("workspace");
        let outside = fixture.join("outside");
        fs::create_dir_all(&workspace).unwrap_or_else(|error| panic!("create workspace: {error}"));
        fs::create_dir_all(&outside).unwrap_or_else(|error| panic!("create outside: {error}"));
        fs::write(outside.join("secret.excalidraw"), "{}")
            .unwrap_or_else(|error| panic!("write outside file: {error}"));
        symlink(&outside, workspace.join("escape"))
            .unwrap_or_else(|error| panic!("create symlink: {error}"));

        let policy = WorkspacePathPolicy::new([&workspace])
            .unwrap_or_else(|error| panic!("create policy: {error}"));
        assert!(matches!(
            policy.authorize_existing(&workspace.join("escape/secret.excalidraw")),
            Err(PathSecurityError::AccessDenied(_))
        ));
        assert!(matches!(
            policy.authorize_for_creation(&workspace.join("escape/new.excalidraw")),
            Err(PathSecurityError::AccessDenied(_))
        ));
        fs::remove_dir_all(fixture).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    #[test]
    fn rejects_nested_workspace_roots() {
        let fixture = fixture_directory("overlap");
        let nested = fixture.join("nested");
        fs::create_dir_all(&nested).unwrap_or_else(|error| panic!("create nested root: {error}"));
        assert!(matches!(
            WorkspacePathPolicy::new([fixture.as_path(), nested.as_path()]),
            Err(PathSecurityError::WorkspaceOverlap { .. })
        ));
        fs::remove_dir_all(fixture).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    fn fixture_directory(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "excalidraw-security-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory)
            .unwrap_or_else(|error| panic!("create fixture directory: {error}"));
        directory
    }
}
