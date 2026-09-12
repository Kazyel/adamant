use reqwest::{Client, Method, RequestBuilder};
use serde_json::{Value, json};

use super::{clip, models::*, now_iso, request_json, request_write, safe_url};

const PAGE_SIZE: usize = 50;
const MAX_PAGES: u32 = 20;
const MAX_COMMENT: usize = 8192;
const MAX_PATCH: usize = 8192;

fn scope(value: &str) -> Result<&str, String> {
    let Some((owner, repository)) = value.split_once('/') else {
        return Err("Use a GitHub repository scope in owner/repository form.".into());
    };
    if owner.is_empty()
        || owner.len() > 39
        || owner.starts_with('-')
        || owner.ends_with('-')
        || !owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || repository.is_empty()
        || repository.len() > 100
        || matches!(repository, "." | "..")
        || !repository
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(
            "Use a GitHub repository scope in owner/repository form, without a URL, query or path."
                .into(),
        );
    }
    Ok(value)
}

fn number(value: &str) -> Result<u64, String> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("The GitHub item number is invalid.".into());
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|number| *number > 0)
        .ok_or_else(|| "The GitHub item number is invalid.".into())
}

fn target(connection: &Connection, remote: &RemoteRef) -> Result<String, String> {
    if connection.provider != "github"
        || connection.host != "github.com"
        || remote.provider != "github"
        || remote.host != "github.com"
    {
        return Err("This item does not belong to this GitHub connection.".into());
    }
    Ok(format!(
        "repos/{}/issues/{}",
        scope(&remote.scope)?,
        number(&remote.number)?
    ))
}

fn authorized(request: RequestBuilder, token: &str) -> RequestBuilder {
    request
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
}

fn request(client: &Client, token: &str, method: Method, path: &str) -> RequestBuilder {
    authorized(
        client.request(method, format!("https://api.github.com/{path}")),
        token,
    )
}

async fn get(client: &Client, token: &str, path: &str) -> Result<Value, String> {
    request_json(request(client, token, Method::GET, path)).await
}

async fn write(
    client: &Client,
    token: &str,
    method: Method,
    path: &str,
    body: Value,
) -> Result<Value, String> {
    let bytes = serde_json::to_vec(&body).map_err(|_| "Could not encode the GitHub action.")?;
    request_write(
        request(client, token, method, path)
            .header("Content-Type", "application/json")
            .body(bytes),
    )
    .await
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn values(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn login(value: &Value) -> String {
    clip(text(value, "login"), 256)
}
fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
}

fn filter(value: &str) -> Result<(), String> {
    if value.len() > 4096 || value.chars().any(char::is_control) || value.contains(['(', ')', '\\'])
    {
        return Err("The GitHub filter is invalid. Use issue search text and qualifiers within this repository.".into());
    }
    let mut quoted = false;
    let mut current = String::new();
    let mut terms = Vec::new();
    for character in value.chars() {
        if character == '"' {
            quoted = !quoted;
        }
        if character.is_whitespace() && !quoted {
            if !current.is_empty() {
                terms.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if quoted {
        return Err("Close the quoted text in the GitHub filter.".into());
    }
    if !current.is_empty() {
        terms.push(current);
    }
    for term in terms {
        let lower = term.to_ascii_lowercase();
        if matches!(lower.as_str(), "or" | "and" | "not") {
            return Err("Boolean operators are not supported in repository-scoped GitHub filters. Use multiple qualifiers instead.".into());
        }
        if let Some((qualifier, _)) = lower.split_once(':') {
            let qualifier = qualifier.trim_start_matches('-');
            if !matches!(
                qualifier,
                "is" | "state"
                    | "label"
                    | "assignee"
                    | "author"
                    | "mentions"
                    | "involves"
                    | "review-requested"
                    | "reviewed-by"
                    | "team-review-requested"
                    | "commenter"
                    | "sort"
                    | "created"
                    | "updated"
                    | "closed"
                    | "merged"
                    | "milestone"
                    | "reason"
                    | "draft"
                    | "status"
                    | "review"
                    | "no"
                    | "has"
                    | "in"
                    | "comments"
                    | "interactions"
                    | "reactions"
                    | "linked"
                    | "type"
            ) {
                return Err("This GitHub qualifier is unsupported. Repository, organization and user scope cannot be overridden.".into());
            }
        }
    }
    Ok(())
}

fn item(value: &Value, repository: &str) -> Result<WorkItem, String> {
    let id = value
        .get("id")
        .and_then(Value::as_u64)
        .filter(|id| *id > 0)
        .ok_or("GitHub returned an incomplete item identity.")?;
    let number = value
        .get("number")
        .and_then(Value::as_u64)
        .filter(|number| *number > 0)
        .ok_or("GitHub returned an invalid item number.")?;
    let is_pr = value.get("pull_request").is_some() || value.get("head").is_some();
    let title = text(value, "title");
    if title.is_empty() {
        return Err("GitHub returned an item without a title.".into());
    }
    let state =
        if flag(value, "merged") || value.get("merged_at").is_some_and(|value| !value.is_null()) {
            "merged"
        } else {
            text(value, "state")
        };
    Ok(WorkItem {
        id: format!("github:github.com:{id}"),
        kind: if is_pr { "github-pr" } else { "github-issue" }.into(),
        title: clip(title, 4096),
        description: clip(text(value, "body"), 65536),
        remote: Some(RemoteRef {
            provider: "github".into(),
            host: "github.com".into(),
            scope: repository.into(),
            number: number.to_string(),
        }),
        url: Some(format!(
            "https://github.com/{repository}/{}/{number}",
            if is_pr { "pull" } else { "issues" }
        )),
        remote_state: Some(clip(state, 64)),
        assignee: login(&value["assignee"]),
        labels: values(&value["labels"])
            .iter()
            .take(100)
            .map(|label| clip(text(label, "name"), 255))
            .collect(),
        priority: "none".into(),
        due_date: String::new(),
        checklist: Vec::new(),
        links: Vec::new(),
        updated_at: clip(text(value, "updated_at"), 64),
        fetched_at: Some(now_iso()),
    })
}

pub(super) async fn list(
    client: &Client,
    connection: &Connection,
    token: &str,
    source: &WorkSource,
    cursor: Option<&str>,
) -> Result<RemotePage, String> {
    if connection.provider != "github"
        || connection.host != "github.com"
        || source.host != "github.com"
        || source.provider != "github"
    {
        return Err("This source does not belong to GitHub.".into());
    }
    let repository = scope(&source.scope)?;
    filter(&source.filter)?;
    let page = match cursor {
        None => 1,
        Some(value) => value
            .parse::<u32>()
            .ok()
            .filter(|page| (1..=MAX_PAGES).contains(page))
            .ok_or("The GitHub page cursor is invalid.")?,
    };
    let query = format!("repo:{repository} {}", source.filter.trim());
    let mut url = reqwest::Url::parse("https://api.github.com/search/issues")
        .map_err(|_| "Could not construct the GitHub search endpoint.")?;
    url.query_pairs_mut()
        .append_pair("q", &query)
        .append_pair("per_page", &PAGE_SIZE.to_string())
        .append_pair("page", &page.to_string())
        .append_pair("sort", "updated")
        .append_pair("order", "desc");
    let response = request_json(authorized(client.get(url), token)).await?;
    let rows = response
        .get("items")
        .and_then(Value::as_array)
        .ok_or("GitHub returned an invalid issue search response.")?;
    let expected = format!("https://api.github.com/repos/{repository}");
    let mut items = Vec::with_capacity(rows.len().min(PAGE_SIZE));
    let mut warning = flag(&response, "incomplete_results").then(|| {
        "GitHub returned incomplete search results; narrow the filter and refresh.".to_owned()
    });
    for row in rows.iter().take(PAGE_SIZE) {
        if !text(row, "repository_url").eq_ignore_ascii_case(&expected) {
            return Err("GitHub returned an item outside the configured repository; the result was rejected.".into());
        }
        if text(row, "body").len() > 65536
            || text(row, "title").len() > 4096
            || values(&row["labels"]).len() > 100
        {
            warning = Some("Some item content was truncated to keep the source bounded. Open it on GitHub for full content.".into());
        }
        items.push(item(row, repository)?);
    }
    let total = response
        .get("total_count")
        .and_then(Value::as_u64)
        .unwrap_or(rows.len() as u64);
    let more = page as u64 * (PAGE_SIZE as u64) < total && rows.len() >= PAGE_SIZE;
    if more && page == MAX_PAGES {
        warning = Some("GitHub search is limited to the first 1,000 results. Narrow this source filter for additional items.".into());
    }
    Ok(RemotePage {
        items,
        next_cursor: (more && page < MAX_PAGES).then(|| (page + 1).to_string()),
        warning,
    })
}

fn partial(detail: &mut RemoteDetail, warning: impl Into<String>) {
    detail.partial = true;
    detail.warnings.push(warning.into());
}

async fn section(
    client: &Client,
    token: &str,
    path: &str,
    label: &str,
    detail: &mut RemoteDetail,
) -> Option<Value> {
    match get(client, token, path).await {
        Ok(value) => Some(value),
        Err(error) => {
            partial(detail, format!("{label} unavailable: {error}"));
            None
        }
    }
}

fn comment(row: &Value, prefix: &str) -> Comment {
    Comment {
        id: format!("{prefix}:{}", row["id"]),
        author: login(&row["user"]),
        body: clip(text(row, "body"), MAX_COMMENT),
        updated_at: clip(text(row, "updated_at"), 64),
    }
}

fn base_detail(item: WorkItem) -> RemoteDetail {
    RemoteDetail {
        item,
        comments: Vec::new(),
        commits: Vec::new(),
        checks: Vec::new(),
        files: Vec::new(),
        transitions: Vec::new(),
        priorities: Vec::new(),
        actions: Vec::new(),
        editable_fields: Vec::new(),
        head_sha: None,
        partial: false,
        stale: false,
        warnings: Vec::new(),
    }
}

fn editable(repository: &Value) -> bool {
    flag(&repository["permissions"], "push")
        || flag(&repository["permissions"], "triage")
        || flag(&repository["permissions"], "maintain")
        || flag(&repository["permissions"], "admin")
}

fn head_guard(pull: &Value, expected_sha: &str) -> Result<(), String> {
    if expected_sha.len() != 40
        || !expected_sha.bytes().all(|byte| byte.is_ascii_hexdigit())
        || text(&pull["head"], "sha") != expected_sha
    {
        return Err("The pull request head changed or is missing. Refresh and explicitly confirm the new head before reviewing or merging.".into());
    }
    Ok(())
}

fn merge_guard(pull: &Value, expected_sha: &str) -> Result<(), String> {
    head_guard(pull, expected_sha)?;
    if text(pull, "state") != "open" || flag(pull, "draft") || flag(pull, "merged") {
        return Err("Only an open, non-draft, unmerged pull request can be merged.".into());
    }
    if pull.get("mergeable").and_then(Value::as_bool) != Some(true)
        || text(pull, "mergeable_state") != "clean"
    {
        return Err("GitHub has not confirmed this pull request is clean and mergeable. Required checks, reviews and branch rules are never bypassed; refresh after they complete.".into());
    }
    Ok(())
}

fn review_context(reviews: &Value, detail: &mut RemoteDetail) {
    if !reviews.is_array() {
        partial(detail, "GitHub returned an invalid review response.");
    }
    for row in values(reviews).iter().take(50) {
        let mut review = comment(row, "review");
        review.body = format!("[{}]\n{}", clip(text(row, "state"), 32), review.body);
        review.updated_at = clip(text(row, "submitted_at"), 64);
        detail.comments.push(review);
    }
    if values(reviews).len() >= 50
        || values(reviews)
            .iter()
            .any(|row| text(row, "body").len() > MAX_COMMENT)
    {
        partial(
            detail,
            "Review history is limited to 50 reviews and 8 KiB per review; open GitHub for the complete discussion.",
        );
    }
}

fn commit_context(commits: &Value, pull: &Value, detail: &mut RemoteDetail) {
    if !commits.is_array() {
        partial(detail, "GitHub returned an invalid commit response.");
    }
    detail.commits = values(commits)
        .iter()
        .take(100)
        .map(|row| Commit {
            sha: clip(text(row, "sha"), 64),
            message: clip(text(&row["commit"], "message"), 8192),
            author: clip(text(&row["commit"]["author"], "name"), 256),
        })
        .collect();
    if pull["commits"].as_u64().unwrap_or(0) > detail.commits.len() as u64
        || values(commits).len() >= 100
        || values(commits)
            .iter()
            .any(|row| text(&row["commit"], "message").len() > 8192)
    {
        partial(
            detail,
            "Commit history is limited to 100 commits and 8 KiB per message; open GitHub for the complete history.",
        );
    }
}

fn file_context(files: &Value, pull: &Value, detail: &mut RemoteDetail) {
    if !files.is_array() {
        partial(detail, "GitHub returned an invalid changed-file response.");
    }
    detail.files = values(files)
        .iter()
        .take(100)
        .map(|row| DiffFile {
            path: clip(text(row, "filename"), 4096),
            status: clip(text(row, "status"), 64),
            additions: row["additions"].as_u64().unwrap_or(0),
            deletions: row["deletions"].as_u64().unwrap_or(0),
            patch: row["patch"].as_str().map(|patch| clip(patch, MAX_PATCH)),
        })
        .collect();
    if pull["changed_files"].as_u64().unwrap_or(0) > detail.files.len() as u64
        || values(files).len() >= 100
        || values(files).iter().any(|row| {
            row["patch"]
                .as_str()
                .is_none_or(|patch| patch.len() > MAX_PATCH)
        })
    {
        partial(
            detail,
            "Diffs are limited to 100 files and 8 KiB per patch. Binary, large or omitted patches require opening GitHub.",
        );
    }
}

fn check_context(runs: &Value, detail: &mut RemoteDetail) -> bool {
    if !runs["check_runs"].is_array() {
        partial(detail, "GitHub returned an invalid check-run response.");
    }
    for run in values(&runs["check_runs"]).iter().take(100) {
        let status = if text(run, "status") == "completed" {
            text(run, "conclusion")
        } else {
            text(run, "status")
        };
        detail.checks.push(Check {
            name: clip(text(run, "name"), 256),
            status: clip(status, 64),
            url: safe_url(text(run, "html_url")),
        });
    }
    if runs["total_count"].as_u64().unwrap_or(0) > 100 {
        partial(detail, "Only the first 100 check runs are shown.");
    }
    runs["check_runs"].is_array()
        && runs["total_count"]
            .as_u64()
            .is_some_and(|count| count <= values(&runs["check_runs"]).len().min(100) as u64)
}

fn status_context(status: &Value, detail: &mut RemoteDetail) -> bool {
    if !status["statuses"].is_array() {
        partial(detail, "GitHub returned an invalid commit-status response.");
    }
    for row in values(&status["statuses"]).iter().take(100) {
        detail.checks.push(Check {
            name: clip(text(row, "context"), 256),
            status: clip(text(row, "state"), 64),
            url: safe_url(text(row, "target_url")),
        });
    }
    if status["total_count"].as_u64().unwrap_or(0) > 100 {
        partial(detail, "Only the first 100 commit statuses are shown.");
    }
    status["statuses"].is_array()
        && status["total_count"]
            .as_u64()
            .is_some_and(|count| count <= values(&status["statuses"]).len().min(100) as u64)
}

async fn pull_context(
    client: &Client,
    token: &str,
    remote: &RemoteRef,
    pull: &Value,
    detail: &mut RemoteDetail,
) -> bool {
    let base = format!("repos/{}/pulls/{}", remote.scope, remote.number);
    let sha = text(&pull["head"], "sha");
    if sha.len() == 40 && sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        detail.head_sha = Some(sha.into());
    } else {
        partial(
            detail,
            "GitHub did not provide a valid head SHA; merge is unavailable.",
        );
    }
    if let Some(reviews) = section(
        client,
        token,
        &format!("{base}/reviews?per_page=50"),
        "Reviews",
        detail,
    )
    .await
    {
        review_context(&reviews, detail);
    }
    if let Some(commits) = section(
        client,
        token,
        &format!("{base}/commits?per_page=100"),
        "Commits",
        detail,
    )
    .await
    {
        commit_context(&commits, pull, detail);
    }
    if let Some(files) = section(
        client,
        token,
        &format!("{base}/files?per_page=100"),
        "Changed files",
        detail,
    )
    .await
    {
        file_context(&files, pull, detail);
    }
    let mut checks_complete = detail.head_sha.is_some();
    if detail.head_sha.is_some() {
        if let Some(runs) = section(
            client,
            token,
            &format!(
                "repos/{}/commits/{sha}/check-runs?per_page=100",
                remote.scope
            ),
            "Checks",
            detail,
        )
        .await
        {
            checks_complete &= check_context(&runs, detail);
        } else {
            checks_complete = false;
        }
        if let Some(status) = section(
            client,
            token,
            &format!("repos/{}/commits/{sha}/status?per_page=100", remote.scope),
            "Commit statuses",
            detail,
        )
        .await
        {
            checks_complete &= status_context(&status, detail);
        } else {
            checks_complete = false;
        }
    }
    checks_complete
}

fn issue_actions(
    issue: &Value,
    repository: Option<&Value>,
    account: &str,
    detail: &mut RemoteDetail,
) {
    let active =
        repository.is_some_and(|value| !flag(value, "archived") && !flag(value, "disabled"));
    let can_edit = active && repository.is_some_and(editable);
    let own = text(&issue["user"], "login").eq_ignore_ascii_case(account);
    if active && (!flag(issue, "locked") || can_edit) {
        detail.actions.push("comment".into());
    }
    if can_edit {
        detail.actions.push("edit".into());
        detail.editable_fields = vec!["assignee".into(), "labels".into()];
    }
    if active && (can_edit || own) {
        detail.actions.push(
            if text(issue, "state") == "open" {
                "close"
            } else {
                "reopen"
            }
            .into(),
        );
    }
}

fn pull_actions(
    pull: &Value,
    repository: Option<&Value>,
    checks_complete: bool,
    detail: &mut RemoteDetail,
) {
    let active =
        repository.is_some_and(|value| !flag(value, "archived") && !flag(value, "disabled"));
    if flag(pull, "merged") {
        detail.item.remote_state = Some("merged".into());
        detail
            .actions
            .retain(|action| action != "close" && action != "reopen");
    }
    if active && text(pull, "state") == "open" {
        detail.actions.push("review".into());
    }
    if active
        && repository.is_some_and(|value| flag(&value["permissions"], "push"))
        && detail
            .head_sha
            .as_ref()
            .is_some_and(|sha| merge_guard(pull, sha).is_ok())
        && checks_complete
        && detail
            .checks
            .iter()
            .all(|check| matches!(check.status.as_str(), "success" | "neutral" | "skipped"))
    {
        detail.actions.push("merge".into());
    } else if text(pull, "state") == "open" {
        detail.warnings.push("Merge is unavailable until a live refresh confirms write access, a clean mergeable head and completed checks. GitHub branch rules are never bypassed.".into());
    }
}

pub(super) async fn detail(
    client: &Client,
    connection: &Connection,
    token: &str,
    remote: &RemoteRef,
) -> Result<RemoteDetail, String> {
    let path = target(connection, remote)?;
    let issue = get(client, token, &path).await?;
    if issue["number"].as_u64() != Some(number(&remote.number)?)
        || !text(&issue, "repository_url")
            .eq_ignore_ascii_case(&format!("https://api.github.com/repos/{}", remote.scope))
    {
        return Err(
            "GitHub returned a different repository or item identity; no action was taken.".into(),
        );
    }
    let mut detail = base_detail(item(&issue, &remote.scope)?);
    if text(&issue, "body").len() > 65536
        || text(&issue, "title").len() > 4096
        || values(&issue["labels"]).len() > 100
    {
        partial(
            &mut detail,
            "Item content was truncated to its display limit; open GitHub for full content.",
        );
    }
    let repository = section(
        client,
        token,
        &format!("repos/{}", remote.scope),
        "Repository permissions",
        &mut detail,
    )
    .await;
    issue_actions(
        &issue,
        repository.as_ref(),
        &connection.account,
        &mut detail,
    );
    if let Some(comments) = section(
        client,
        token,
        &format!("{path}/comments?per_page=50"),
        "Comments",
        &mut detail,
    )
    .await
    {
        if !comments.is_array() {
            partial(&mut detail, "GitHub returned an invalid comment response.");
        }
        detail.comments = values(&comments)
            .iter()
            .take(50)
            .map(|row| comment(row, "comment"))
            .collect();
        if issue["comments"].as_u64().unwrap_or(0) > 50
            || values(&comments).len() >= 50
            || values(&comments)
                .iter()
                .any(|row| text(row, "body").len() > MAX_COMMENT)
        {
            partial(
                &mut detail,
                "Discussion is limited to 50 comments and 8 KiB per comment; open GitHub for the complete discussion.",
            );
        }
    }
    if detail.item.kind == "github-pr" {
        if let Some(pull) = section(
            client,
            token,
            &format!("repos/{}/pulls/{}", remote.scope, remote.number),
            "Pull request",
            &mut detail,
        )
        .await
        {
            let checks_complete = pull_context(client, token, remote, &pull, &mut detail).await;
            pull_actions(&pull, repository.as_ref(), checks_complete, &mut detail);
        } else {
            detail
                .actions
                .retain(|action| action != "close" && action != "reopen");
        }
    }
    Ok(detail)
}

fn item_guard(actual: &WorkItem, expected_item_id: &str) -> Result<(), String> {
    if actual.id != expected_item_id {
        return Err("This repository path or item number now identifies a different item. No action was sent; remove the old reference and explicitly follow the intended item.".into());
    }
    Ok(())
}

pub(super) async fn act(
    client: &Client,
    connection: &Connection,
    token: &str,
    remote: &RemoteRef,
    action: &RemoteAction,
    expected_item_id: &str,
) -> Result<ActionReceipt, String> {
    let path = target(connection, remote)?;
    // Eligibility is always fetched live. Cached permissions never authorize a write.
    let fresh = detail(client, connection, token, remote).await?;
    item_guard(&fresh.item, expected_item_id)?;
    if !fresh.actions.iter().any(|kind| kind == &action.kind) {
        return Err("This action is unavailable for the current item, permissions or checks. Refresh and inspect the remote state.".into());
    }
    match action.kind.as_str() {
        "comment" => {
            let body = action
                .body
                .as_deref()
                .filter(|body| !body.trim().is_empty())
                .ok_or("Enter a comment before posting.")?;
            write(
                client,
                token,
                Method::POST,
                &format!("{path}/comments"),
                json!({ "body": body }),
            )
            .await?;
        }
        "edit" => {
            if action.priority.is_some() {
                return Err("GitHub issues do not expose a native priority field.".into());
            }
            let mut payload = serde_json::Map::new();
            if let Some(assignee) = &action.assignee {
                if !assignee.is_empty()
                    && (assignee.len() > 39
                        || !assignee
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'))
                {
                    return Err(
                        "Enter one GitHub login without spaces, or clear the assignee.".into(),
                    );
                }
                payload.insert(
                    "assignees".into(),
                    if assignee.is_empty() {
                        json!([])
                    } else {
                        json!([assignee])
                    },
                );
            }
            if let Some(labels) = &action.labels {
                payload.insert("labels".into(), json!(labels));
            }
            if payload.is_empty() {
                return Err("Choose an assignee or labels to update.".into());
            }
            write(client, token, Method::PATCH, &path, Value::Object(payload)).await?;
        }
        "close" | "reopen" => {
            write(
                client,
                token,
                Method::PATCH,
                &path,
                json!({ "state": if action.kind == "close" { "closed" } else { "open" } }),
            )
            .await?;
        }
        "review" => {
            let event = action
                .review_event
                .as_deref()
                .filter(|event| matches!(*event, "COMMENT" | "APPROVE" | "REQUEST_CHANGES"))
                .ok_or("Choose Comment, Approve or Request changes for this review.")?;
            let body = action.body.as_deref().unwrap_or("");
            if event != "APPROVE" && body.trim().is_empty() {
                return Err("Enter a review message before posting this review.".into());
            }
            let pull = get(
                client,
                token,
                &format!("repos/{}/pulls/{}", remote.scope, remote.number),
            )
            .await?;
            if text(&pull, "state") != "open" {
                return Err("The pull request is no longer open. Refresh before reviewing.".into());
            }
            if event != "COMMENT"
                && text(&pull["user"], "login").eq_ignore_ascii_case(&connection.account)
            {
                return Err("GitHub does not allow approving or requesting changes on your own pull request.".into());
            }
            let sha = action
                .expected_head_sha
                .as_deref()
                .ok_or("The head SHA you inspected is required before submitting a review.")?;
            head_guard(&pull, sha)?;
            write(
                client,
                token,
                Method::POST,
                &format!("repos/{}/pulls/{}/reviews", remote.scope, remote.number),
                json!({ "event": event, "body": body, "commit_id": sha }),
            )
            .await?;
        }
        "merge" => {
            let sha = action
                .expected_head_sha
                .as_deref()
                .ok_or("An explicitly confirmed head SHA is required to merge.")?;
            let method = action.merge_method.as_deref().unwrap_or("merge");
            if !matches!(method, "merge" | "squash" | "rebase") {
                return Err("Choose a supported merge method.".into());
            }
            let pull = get(
                client,
                token,
                &format!("repos/{}/pulls/{}", remote.scope, remote.number),
            )
            .await?;
            merge_guard(&pull, sha)?;
            if fresh.head_sha.as_deref() != Some(sha) {
                return Err("The checked head no longer matches. Refresh before merging.".into());
            }
            let result = write(
                client,
                token,
                Method::PUT,
                &format!("repos/{}/pulls/{}/merge", remote.scope, remote.number),
                json!({ "sha": sha, "merge_method": method }),
            )
            .await?;
            if result["merged"].as_bool() != Some(true) {
                return Err("GitHub did not confirm a merge. Refresh the pull request on GitHub before taking another action; Adamant did not retry.".into());
            }
        }
        _ => return Err("This action is unsupported for GitHub.".into()),
    }
    Ok(ActionReceipt {
        message: format!(
            "GitHub confirmed the {} action. Refresh to see the latest remote state.",
            action.kind
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_scope_cannot_escape_the_selected_repository() {
        assert!(scope("team/repository").is_ok());
        for invalid in [
            "https://github.com/team/repository",
            "team/../other",
            "team/repo?x=1",
            "team/%2fother",
            "team/..",
        ] {
            assert!(scope(invalid).is_err());
        }
        assert!(filter("is:pr state:open label:\"ready to review\" assignee:@me").is_ok());
        for invalid in [
            "repo:other/private",
            "is:issue OR repo:other/private",
            "org:other",
            "user:someone",
            "(state:open)",
            "label:\"unclosed",
        ] {
            assert!(filter(invalid).is_err());
        }
    }

    #[test]
    fn merge_requires_the_exact_clean_open_head() {
        let sha = "a".repeat(40);
        let mut pull = json!({ "head": { "sha": sha }, "state": "open", "draft": false, "merged": false, "mergeable": true, "mergeable_state": "clean" });
        assert!(merge_guard(&pull, &sha).is_ok());
        assert!(merge_guard(&pull, &"b".repeat(40)).is_err());
        for state in ["blocked", "behind", "unstable", "dirty", "unknown"] {
            pull["mergeable_state"] = json!(state);
            assert!(merge_guard(&pull, &sha).is_err());
        }
        pull["mergeable_state"] = json!("clean");
        pull["draft"] = json!(true);
        assert!(merge_guard(&pull, &sha).is_err());
    }

    #[test]
    fn recreated_repository_paths_cannot_retarget_actions() {
        let live = item(
            &json!({ "id": 202, "number": 1, "title": "Replacement issue" }),
            "team/repository",
        )
        .unwrap();
        assert!(item_guard(&live, "github:github.com:101").is_err());
        assert!(item_guard(&live, "github:github.com:202").is_ok());
    }

    #[test]
    fn reviews_pin_the_inspected_head_without_requiring_mergeability() {
        let sha = "a".repeat(40);
        let pull = json!({ "head": { "sha": sha }, "mergeable_state": "blocked" });
        assert!(head_guard(&pull, &sha).is_ok());
        assert!(head_guard(&pull, "").is_err());
        assert!(head_guard(&pull, &"b".repeat(40)).is_err());
    }
}
