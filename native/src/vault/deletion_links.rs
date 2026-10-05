//! Byte-preserving removal of links to explicitly deleted Vault paths.

use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};

use super::{VaultError, VaultResult, metadata, mutations};

const MAX_UNLINK_PASSES: usize = 64;

pub(super) fn unlink_markdown(
    text: &str,
    referrer: &str,
    deleted_paths: &[String],
) -> VaultResult<String> {
    if deleted_paths.iter().all(String::is_empty) {
        return Ok(text.to_owned());
    }
    let mut current = text.to_owned();
    // Unwrapping a link can expose previously inactive syntax or a shadow definition.
    // Each pass only removes bytes; the extra final pass verifies the fixed point.
    for _ in 0..MAX_UNLINK_PASSES {
        let updated = unlink_pass(&current, referrer, deleted_paths)?;
        if updated == current {
            return Ok(current);
        }
        current = updated;
    }
    if unlink_pass(&current, referrer, deleted_paths)? == current {
        return Ok(current);
    }
    Err(VaultError::invalid(
        "Deleted local link nesting exceeds the safe cleanup limit; simplify these links before deleting their target.",
    ))
}

fn unlink_pass(text: &str, referrer: &str, deleted_paths: &[String]) -> VaultResult<String> {
    let body_start = metadata::note_body_start(text);
    if body_start == 0
        && text
            .strip_prefix('\u{feff}')
            .unwrap_or(text)
            .lines()
            .next()
            .is_some_and(|line| line.trim_end_matches(['\r', ' ', '\t']) == "---")
    {
        return Err(VaultError::invalid(
            "The Note frontmatter cannot be separated safely; close its delimiter before deleting linked files.",
        ));
    }
    let removed = |target: &str| {
        mutations::local_link_target(target, referrer).is_some_and(|path| {
            deleted_paths.iter().any(|root| {
                !root.is_empty() && (path == *root || path.starts_with(&format!("{root}/")))
            })
        })
    };
    let body = &text[body_start..];
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES;
    let parser = Parser::new_ext(body, options);
    let mut edits = Vec::new();
    for (_, definition) in parser.reference_definitions().iter() {
        if removed(&definition.dest) {
            edits.push(body_start + definition.span.start..body_start + definition.span.end);
        }
    }
    for (event, span) in parser.into_offset_iter() {
        let (destination, link_type) = match event {
            Event::Start(Tag::Link {
                dest_url,
                link_type,
                ..
            })
            | Event::Start(Tag::Image {
                dest_url,
                link_type,
                ..
            }) => (dest_url, link_type),
            _ => continue,
        };
        if !removed(&destination) {
            continue;
        }
        let raw = &body[span.clone()];
        let close = mutations::label_end(raw).ok_or_else(|| {
            VaultError::invalid(
                "A deleted local link cannot be unlinked byte-safely; edit its layout explicitly first.",
            )
        })?;
        let start = body_start + span.start;
        let opening = if raw.starts_with('!') { 2 } else { 1 };
        // pulldown-cmark's collapsed-reference event excludes the consumed trailing [].
        let end = if link_type == LinkType::Collapsed && body[span.end..].starts_with("[]") {
            span.end + 2
        } else {
            span.end
        };
        edits.push(start..start + opening);
        edits.push(start + close..body_start + end);
    }
    edits.sort_by_key(|span| (span.start, span.end));
    edits.dedup();
    if edits.windows(2).any(|pair| pair[0].end > pair[1].start) {
        return Err(VaultError::invalid(
            "Deleted local links overlap source spans; edit their layout explicitly first.",
        ));
    }
    let mut result = text.to_owned();
    for span in edits.into_iter().rev() {
        result.replace_range(span, "");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::unlink_markdown;

    #[test]
    fn unlink_deleted_paths_preserves_labels_code_metadata_and_unrelated_source() {
        let text = concat!(
            "\u{feff}---\r\n",
            "title: '[metadata](../gone/one.md)'\n",
            "---\r\n",
            "[**label** `x[y]`](../gone/one.md#section)\r\n",
            "[encoded](/gone/space%20name.pdf?download#part)\n",
            "![image](../gone/photo.png)\r\n",
            "[![cover](../gone/photo.png)](../keep.md)\n",
            "[![web image](https://example.test/image.png)](../gone/one.md)\r\n",
            "[![both](../gone/photo.png)](../gone/one.md)\n",
            "[escaped \\[x\\] `a ] b` **bold**](<../gone/one.md> \"title\")\r\n",
            "[sibling](../gone-old/one.md) [web](https://example.test/gone/one.md) [here](#gone)\n",
            "`[inline](../gone/one.md)`\r\n",
            "```md\n[fenced](../gone/one.md)\n```\r\n",
        );
        let expected = concat!(
            "\u{feff}---\r\n",
            "title: '[metadata](../gone/one.md)'\n",
            "---\r\n",
            "**label** `x[y]`\r\n",
            "encoded\n",
            "image\r\n",
            "[cover](../keep.md)\n",
            "![web image](https://example.test/image.png)\r\n",
            "both\n",
            "escaped \\[x\\] `a ] b` **bold**\r\n",
            "[sibling](../gone-old/one.md) [web](https://example.test/gone/one.md) [here](#gone)\n",
            "`[inline](../gone/one.md)`\r\n",
            "```md\n[fenced](../gone/one.md)\n```\r\n",
        );
        assert_eq!(
            unlink_markdown(text, "notes/referrer.md", &["gone".into()]).unwrap(),
            expected
        );
    }

    #[test]
    fn unlink_reference_links_and_definitions_keeps_unaffected_references() {
        let text = concat!(
            "[**full**][deleted] [collapsed][] [shortcut] ![picture][deleted]\r\n",
            "[retained][keep] [multiline][wrapped]\n",
            "\n",
            "[deleted]: /gone/note.md \"title\"\r\n",
            "[collapsed]: ../gone/file.docx\n",
            "[shortcut]: ../gone/file.pdf#page\r\n",
            "[wrapped]:\n  <../gone/one.md>\r\n  \"two-line title\"\n",
            "[keep]: ../gone-old/note.md\n",
        );
        let expected = concat!(
            "**full** collapsed shortcut picture\r\n",
            "[retained][keep] multiline\n",
            "\n",
            "\r\n",
            "\n",
            "\r\n",
            "\n",
            "[keep]: ../gone-old/note.md\n",
        );
        assert_eq!(
            unlink_markdown(text, "notes/referrer.md", &["gone".into()]).unwrap(),
            expected
        );
    }

    #[test]
    fn unlink_rechecks_exposed_syntax_and_refuses_excessive_nesting() {
        let source = "[[target]](gone.md)\n\n[target]: gone.md\n[target]: gone.md\n";
        assert_eq!(
            unlink_markdown(source, "source.md", &["gone.md".into()]).unwrap(),
            "target\n\n\n\n"
        );
        let mut nested = "target".to_owned();
        for _ in 0..128 {
            nested = format!("[{nested}](gone.md)");
        }
        let error = unlink_markdown(&nested, "source.md", &["gone.md".into()]).unwrap_err();
        assert_eq!(error.kind, "invalid");
        assert!(error.message.contains("nesting"));
    }
}
