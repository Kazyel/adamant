use std::sync::LazyLock;

use serde_json::Value;
use uuid::Uuid;

use super::{VaultError, VaultResult};

pub(crate) struct Metadata {
    pub id: Option<String>,
    pub error: Option<String>,
    pub value: Option<Value>,
}

struct Frontmatter<'a> {
    yaml: &'a str,
    start: usize,
    end: usize,
}

fn frontmatter(text: &str) -> Result<Option<Frontmatter<'_>>, String> {
    let bom = usize::from(text.starts_with('\u{feff}')) * '\u{feff}'.len_utf8();
    let mut lines = text[bom..].split_inclusive('\n');
    let Some(first) = lines.next() else {
        return Ok(None);
    };
    if first.trim_end_matches(['\r', '\n', ' ', '\t']) != "---" {
        return Ok(None);
    }
    let start = bom + first.len();
    let mut end = start;
    for line in lines {
        if matches!(
            line.trim_end_matches(['\r', '\n', ' ', '\t']),
            "---" | "..."
        ) {
            return Ok(Some(Frontmatter {
                yaml: &text[start..end],
                start,
                end,
            }));
        }
        end += line.len();
    }
    Err("The YAML frontmatter has no closing delimiter. Source remains editable.".into())
}

fn parse_yaml(yaml: &str) -> Result<Value, String> {
    // No include/property features are enabled: metadata cannot read files or the network.
    let value: Value =
        serde_saphyr::from_str(yaml).map_err(|error| format!("Invalid YAML: {error}"))?;
    if value.is_null()
        && yaml
            .lines()
            .all(|line| line.trim().is_empty() || line.trim_start().starts_with('#'))
    {
        Ok(serde_json::json!({}))
    } else if value.is_object() {
        Ok(value)
    } else {
        Err("YAML metadata must be a mapping.".into())
    }
}

fn validator(source: &'static str) -> jsonschema::Validator {
    let schema: Value = serde_json::from_str(source).expect("Bundled schema must be valid JSON");
    // Only bundled schemas with local fragments are accepted; HTTP/file resolution is disabled.
    fn local_refs(value: &Value) {
        match value {
            Value::Object(map) => {
                for (key, value) in map {
                    if matches!(key.as_str(), "$ref" | "$dynamicRef") {
                        assert!(
                            value
                                .as_str()
                                .is_some_and(|reference| reference.starts_with('#'))
                        );
                    }
                    local_refs(value);
                }
            }
            Value::Array(values) => values.iter().for_each(local_refs),
            _ => {}
        }
    }
    local_refs(&schema);
    jsonschema::options()
        .should_validate_formats(true)
        .build(&schema)
        .expect("Bundled schema must compile")
}

pub(crate) fn manifest_validator() -> &'static jsonschema::Validator {
    static VALIDATOR: LazyLock<jsonschema::Validator> =
        LazyLock::new(|| validator(include_str!("../../../schemas/vault.schema.json")));
    &VALIDATOR
}

fn note_validator() -> &'static jsonschema::Validator {
    static VALIDATOR: LazyLock<jsonschema::Validator> =
        LazyLock::new(|| validator(include_str!("../../../schemas/note.schema.json")));
    &VALIDATOR
}

fn document_validator() -> &'static jsonschema::Validator {
    static VALIDATOR: LazyLock<jsonschema::Validator> =
        LazyLock::new(|| validator(include_str!("../../../schemas/document.schema.json")));
    &VALIDATOR
}

fn inspect(parsed: Result<Value, String>, validator: &jsonschema::Validator) -> Metadata {
    match parsed {
        Err(error) => Metadata {
            id: None,
            error: Some(error),
            value: None,
        },
        Ok(value) => {
            let id = value
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| Uuid::parse_str(id).ok())
                .map(|id| id.to_string());
            let errors = validator
                .iter_errors(&value)
                .map(|error| error.to_string())
                .collect::<Vec<_>>();
            Metadata {
                id,
                error: (!errors.is_empty()).then(|| errors.join("; ")),
                value: Some(value),
            }
        }
    }
}

pub(crate) fn note_metadata(text: &str) -> Metadata {
    let parsed = frontmatter(text).and_then(|frontmatter| {
        frontmatter.map_or_else(
            || Err("This Markdown has no identity. Adopt it explicitly to add metadata.".into()),
            |frontmatter| parse_yaml(frontmatter.yaml),
        )
    });
    inspect(parsed, note_validator())
}

pub(crate) fn companion_metadata(text: &str) -> Metadata {
    inspect(parse_yaml(text), document_validator())
}

/// Insert only missing fields. Existing YAML spelling, comments, line endings and body are never serialized.
pub(crate) fn adopt(text: &str) -> VaultResult<String> {
    let front = frontmatter(text).map_err(VaultError::invalid)?;
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let Some(front) = front else {
        let bom = usize::from(text.starts_with('\u{feff}')) * '\u{feff}'.len_utf8();
        return Ok(format!(
            "{}---{newline}id: {}{newline}kind: note{newline}---{newline}{}",
            &text[..bom],
            Uuid::new_v4(),
            &text[bom..]
        ));
    };
    let value = parse_yaml(front.yaml).map_err(VaultError::invalid)?;
    if let Some(id) = value.get("id")
        && id
            .as_str()
            .is_none_or(|id| id.len() != 36 || Uuid::parse_str(id).is_err())
    {
        return Err(VaultError::invalid(
            "Existing identity is invalid; edit the source explicitly rather than replacing it during adoption.",
        ));
    }

    let mut additions = Vec::new();
    if value.get("id").is_none() {
        additions.push(format!("id: {}", Uuid::new_v4()));
    }
    if value.get("kind").is_none() {
        additions.push("kind: note".into());
    }
    if additions.is_empty() {
        return Ok(text.to_owned());
    }

    let first = front
        .yaml
        .lines()
        .find(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'));
    let mut result = text.to_owned();
    if let Some(line) = first.filter(|line| line.trim_start().starts_with('{')) {
        let offset = front.start
            + (line.as_ptr() as usize - front.yaml.as_ptr() as usize)
            + line.find('{').unwrap()
            + 1;
        let rest = text[offset..front.end].trim_start();
        let separator = if rest.starts_with('}') { "" } else { ", " };
        result.insert_str(offset, &format!("{}{separator}", additions.join(", ")));
    } else {
        let indent = first.map_or("", |line| {
            &line[..line.len() - line.trim_start_matches(' ').len()]
        });
        let fields = additions
            .iter()
            .map(|field| format!("{indent}{field}{newline}"))
            .collect::<String>();
        result.insert_str(front.end, &fields);
    }
    // Exotic YAML mappings may need a manual source edit; never write a malformed transformation.
    let after = note_metadata(&result);
    if after.id.is_none()
        || after.value.as_ref().is_none_or(|value| {
            additions.iter().any(|field| {
                field.starts_with("kind:")
                    && value.get("kind").and_then(Value::as_str) != Some("note")
            })
        })
    {
        return Err(VaultError::invalid(
            "This YAML layout cannot be adopted without rewriting it. Add id/kind explicitly in the source.",
        ));
    }
    Ok(result)
}

/// YAML's parser supplies the scalar offsets: nested `id` keys, flow mappings,
/// comments and quotes must not be mistaken for the document's identity.
pub(crate) fn duplicate_source(
    text: &str,
    note: bool,
    fresh: &str,
    identities: &std::collections::HashMap<String, String>,
) -> VaultResult<String> {
    #[derive(serde::Deserialize)]
    struct Reference {
        kind: String,
        id: serde_saphyr::Spanned<String>,
    }
    #[derive(serde::Deserialize)]
    struct Fields {
        id: serde_saphyr::Spanned<String>,
        #[serde(default)]
        refs: Vec<Reference>,
    }
    let adopted;
    let text = if note && frontmatter(text).map_err(VaultError::invalid)?.is_none() {
        adopted = adopt(text)?;
        adopted.as_str()
    } else {
        text
    };
    let inspected = if note {
        note_metadata(text)
    } else {
        companion_metadata(text)
    };
    if inspected.error.is_some() || inspected.id.is_none() {
        return Err(VaultError::invalid(
            "Invalid or missing identity metadata cannot be duplicated safely. Adopt or repair it explicitly first.",
        ));
    }
    let (yaml, offset) = if note {
        let front = frontmatter(text).map_err(VaultError::invalid)?.unwrap();
        (front.yaml, front.start)
    } else {
        (text, 0)
    };
    let fields: Fields = serde_saphyr::from_str(yaml)
        .map_err(|error| VaultError::invalid(format!("Cannot locate identity scalars: {error}")))?;
    let mut replacements = vec![(fields.id, fresh.to_owned())];
    for reference in fields.refs {
        if matches!(
            reference.kind.as_str(),
            "note" | "topic" | "document" | "documentation-page"
        ) && let Ok(id) = Uuid::parse_str(&reference.id.value)
            && let Some(replacement) = identities.get(&id.to_string())
        {
            replacements.push((reference.id, replacement.clone()));
        }
    }
    let mut edits = Vec::new();
    for (scalar, replacement) in replacements {
        if scalar.referenced != scalar.defined {
            return Err(VaultError::invalid(
                "Aliased or merged identities require an explicit source edit before duplication.",
            ));
        }
        let span = scalar.referenced.span();
        let start = span
            .byte_offset()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| VaultError::invalid("Identity scalar has no byte location."))?;
        let len = span
            .byte_len()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| VaultError::invalid("Identity scalar has no byte extent."))?;
        let raw = yaml
            .get(start..start + len)
            .ok_or_else(|| VaultError::invalid("Identity scalar location is invalid."))?;
        let value = scalar.value.as_str();
        let inner = if raw == value {
            0
        } else if (raw.starts_with('"') && raw.ends_with('"')
            || raw.starts_with('\'') && raw.ends_with('\''))
            && raw.get(1..raw.len() - 1) == Some(value)
        {
            1
        } else {
            return Err(VaultError::invalid(
                "This identity scalar spelling cannot be duplicated without rewriting source.",
            ));
        };
        edits.push((
            offset + start + inner,
            offset + start + inner + value.len(),
            replacement,
        ));
    }
    edits.sort_by_key(|edit| edit.0);
    if edits.windows(2).any(|pair| pair[0].1 > pair[1].0) {
        return Err(VaultError::invalid("Identity scalar locations overlap."));
    }
    let mut result = text.to_owned();
    for (start, end, replacement) in edits.into_iter().rev() {
        result.replace_range(start..end, &replacement);
    }
    let verified = if note {
        note_metadata(&result)
    } else {
        companion_metadata(&result)
    };
    if verified.id.as_deref() != Some(fresh) || verified.error.is_some() {
        return Err(VaultError::invalid(
            "Duplicated identity metadata failed validation.",
        ));
    }
    Ok(result)
}
