use reqwest::{Client, Method, RequestBuilder, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::models::{
    ActionReceipt, Choice, Comment, Connection, RemoteAction, RemoteDetail, RemotePage, RemoteRef,
    WorkItem, WorkSource,
};
use super::{clip, jira_host, now_iso, request_json, request_write, safe_url};

const PAGE_SIZE: usize = 50;
const MAX_TEXT_BYTES: usize = 64 * 1024;
const ISSUE_FIELDS: &str =
    "summary,description,status,assignee,labels,priority,duedate,updated,project";

struct Jira<'a> {
    client: &'a Client,
    host: &'a str,
    email: &'a str,
    token: &'a str,
}

impl<'a> Jira<'a> {
    fn new(
        client: &'a Client,
        connection: &'a Connection,
        email: &'a str,
        token: &'a str,
    ) -> Result<Self, String> {
        if connection.provider != "jira" || jira_host(&connection.host)? != connection.host {
            return Err("The connection must use a canonical Jira Cloud host.".into());
        }
        if email.is_empty()
            || email.len() > 320
            || !email.contains('@')
            || email
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || c == ':')
        {
            return Err("Reconnect Jira with the email associated with your API token.".into());
        }
        Ok(Self {
            client,
            host: &connection.host,
            email,
            token,
        })
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<RequestBuilder, String> {
        // Every caller supplies a fixed API path and validated IDs, never a remote self/next URL.
        let mut url = Url::parse(&format!("https://{}/rest/api/3/{path}", self.host))
            .map_err(|_| "Could not construct the Jira endpoint.".to_string())?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter().copied());
        }
        Ok(self
            .client
            .request(method, url)
            .header("Accept", "application/json")
            .basic_auth(self.email, Some(self.token)))
    }

    async fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value, String> {
        request_json(self.request(Method::GET, path, query)?).await
    }

    async fn issue(&self, remote: &RemoteRef) -> Result<Value, String> {
        validate_remote(self.host, remote)?;
        let value = self
            .get(
                &format!("issue/{}", remote.number),
                &[("fields", ISSUE_FIELDS)],
            )
            .await?;
        if numeric_id(&remote.number) && text(&value["id"]) != remote.number {
            return Err("Jira returned a different issue identity; no action was taken.".into());
        }
        Ok(value)
    }
}

fn numeric_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.bytes().all(|c| c.is_ascii_digit())
        && value.bytes().any(|c| c != b'0')
}

fn project_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_uppercase()
        && value
            .bytes()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
}

fn issue_key(value: &str) -> Option<&str> {
    let (project, number) = value.rsplit_once('-')?;
    (project_key(project) && numeric_id(number)).then_some(project)
}

fn validate_remote(host: &str, remote: &RemoteRef) -> Result<(), String> {
    if remote.provider != "jira"
        || remote.host != host
        || !project_key(&remote.scope)
        || (!numeric_id(&remote.number) && issue_key(&remote.number) != Some(remote.scope.as_str()))
    {
        return Err(
            "Use a Jira issue ID or PROJECT-123 key belonging to this connection and project."
                .into(),
        );
    }
    Ok(())
}

// Balanced expressions cannot close the surrounding project constraint. Jira validates the
// actual JQL grammar; we only recognize a top-level ORDER BY and reject comment delimiters.
fn scoped_jql(project: &str, filter: &str) -> Result<String, String> {
    if !project_key(project) {
        return Err("Enter an uppercase Jira project key, such as TEAM.".into());
    }
    let filter = filter.trim();
    if filter.len() > 2048 || filter.chars().any(|c| c.is_control() && !c.is_whitespace()) {
        return Err(
            "The Jira filter must be at most 2048 bytes without control characters.".into(),
        );
    }
    let bytes = filter.as_bytes();
    let mut depth = 0usize;
    let mut quote = None;
    let mut escaped = false;
    let mut order = None;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if let Some(delimiter) = quote {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == delimiter {
                quote = None;
            }
            i += 1;
            continue;
        }
        match c {
            b'\'' | b'"' => quote = Some(c),
            b'(' => depth += 1,
            b')' => {
                depth = depth
                    .checked_sub(1)
                    .ok_or("The Jira filter has unbalanced parentheses.")?;
            }
            b';' | b'\\' => return Err("The Jira filter contains an unsupported delimiter.".into()),
            b'/' if bytes.get(i + 1).is_some_and(|c| *c == b'/' || *c == b'*') => {
                return Err("Comments are not allowed in the Jira filter.".into());
            }
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                return Err("Comments are not allowed in the Jira filter.".into());
            }
            _ if c.is_ascii_alphabetic() => {
                let start = i;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                    i += 1;
                }
                if depth == 0 && filter[start..i].eq_ignore_ascii_case("order") {
                    let mut by = i;
                    while by < bytes.len() && bytes[by].is_ascii_whitespace() {
                        by += 1;
                    }
                    if by > i
                        && bytes
                            .get(by..by + 2)
                            .is_some_and(|word| word.eq_ignore_ascii_case(b"by"))
                        && bytes.get(by + 2).is_some_and(|c| c.is_ascii_whitespace())
                    {
                        if order.is_some() {
                            return Err("Use only one ORDER BY clause in the Jira filter.".into());
                        }
                        order = Some((start, by + 2));
                    }
                }
                continue;
            }
            _ => {}
        }
        i += 1;
    }
    if quote.is_some() || depth != 0 {
        return Err("The Jira filter has an unfinished quote or unbalanced parentheses.".into());
    }
    let (expression, sorting) = match order {
        Some((start, end)) => {
            let sorting = filter[end..].trim();
            // Restrict sorting to field names and directions, not a second expression.
            for field in sorting.split(',') {
                let mut words = field.split_whitespace();
                let name = words.next().unwrap_or("");
                let direction = words.next();
                if name.is_empty()
                    || !name
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_.[]".contains(&c))
                    || direction.is_some_and(|word| {
                        !word.eq_ignore_ascii_case("asc") && !word.eq_ignore_ascii_case("desc")
                    })
                    || words.next().is_some()
                {
                    return Err("ORDER BY supports field names with optional ASC or DESC, separated by commas.".into());
                }
            }
            (filter[..start].trim(), sorting)
        }
        None => (filter, "updated DESC, key ASC"),
    };
    let condition = if expression.is_empty() {
        String::new()
    } else {
        format!(" AND ({expression})")
    };
    Ok(format!(
        "project = \"{project}\"{condition} ORDER BY {sorting}"
    ))
}

#[derive(Deserialize, Serialize)]
struct Cursor {
    host: String,
    jql: String,
    token: String,
}

pub(super) async fn list(
    client: &Client,
    connection: &Connection,
    email: &str,
    token: &str,
    source: &WorkSource,
    cursor: Option<&str>,
) -> Result<RemotePage, String> {
    let jira = Jira::new(client, connection, email, token)?;
    if source.provider != "jira"
        || source.host != jira.host
        || source.connection_id != connection.id
    {
        return Err("The Jira source does not belong to the selected connection.".into());
    }
    let jql = scoped_jql(&source.scope, &source.filter)?;
    let mut body = json!({ "jql": jql, "maxResults": PAGE_SIZE, "fields": ISSUE_FIELDS.split(',').collect::<Vec<_>>() });
    if let Some(cursor) = cursor {
        if cursor.len() > 8192 {
            return Err("The Jira page cursor is too large.".into());
        }
        let cursor: Cursor = serde_json::from_str(cursor)
            .map_err(|_| "Invalid Jira page cursor. Refresh this source.".to_string())?;
        if cursor.host != jira.host || cursor.jql != jql || !valid_page_token(&cursor.token) {
            return Err("The Jira page cursor belongs to a different source or filter. Refresh this source.".into());
        }
        body["nextPageToken"] = Value::String(cursor.token);
    }
    // Enhanced search is read-only even though POST is used; legacy /search is being removed.
    let response = request_json(json_body(
        jira.request(Method::POST, "search/jql", &[])?,
        &body,
    )?)
    .await?;
    let issues = response["issues"]
        .as_array()
        .ok_or("Jira returned an invalid issue page.")?;
    if issues.len() > PAGE_SIZE {
        return Err("Jira exceeded the requested issue page size.".into());
    }
    let mut warnings = Vec::new();
    let mut items = Vec::with_capacity(issues.len());
    let fetched_at = now_iso();
    for issue in issues {
        let item = item_from_issue(jira.host, issue, &fetched_at, &mut warnings)?;
        if item
            .remote
            .as_ref()
            .is_none_or(|remote| remote.scope != source.scope)
        {
            return Err(
                "Jira returned an issue outside the selected project; the page was rejected."
                    .into(),
            );
        }
        items.push(item);
    }
    let next_token = response
        .get("nextPageToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let next_cursor = if response["isLast"].as_bool() == Some(true) {
        None
    } else if let Some(next_token) = next_token {
        if !valid_page_token(next_token) || body["nextPageToken"].as_str() == Some(next_token) {
            return Err(
                "Jira returned an invalid or repeated page cursor. Refresh this source.".into(),
            );
        }
        let cursor = serde_json::to_string(&Cursor {
            host: jira.host.into(),
            jql,
            token: next_token.into(),
        })
        .map_err(|_| "Could not encode the Jira page cursor.".to_string())?;
        if cursor.len() > 8192 {
            return Err("Jira supplied a page cursor exceeding the safety limit. Narrow this source filter.".into());
        }
        Some(cursor)
    } else {
        if response["isLast"].as_bool() != Some(true) {
            warn(
                &mut warnings,
                "Jira did not confirm the end of the result set or supply another page token.",
            );
        }
        None
    };
    if let Some(messages) = response["warningMessages"].as_array() {
        for message in messages.iter().take(10).filter_map(Value::as_str) {
            warn(&mut warnings, &clip(message, 500));
        }
    }
    Ok(RemotePage {
        items,
        next_cursor,
        warning: (!warnings.is_empty()).then(|| warnings.join(" ")),
    })
}

fn valid_page_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 4096 && !token.chars().any(char::is_control)
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn warn(warnings: &mut Vec<String>, message: &str) {
    if !warnings.iter().any(|warning| warning == message) {
        warnings.push(message.into());
    }
}

fn item_from_issue(
    host: &str,
    issue: &Value,
    fetched_at: &str,
    warnings: &mut Vec<String>,
) -> Result<WorkItem, String> {
    let id = text(&issue["id"]);
    let key = text(&issue["key"]);
    let fields = &issue["fields"];
    let project = text(&fields["project"]["key"]);
    if !numeric_id(id)
        || issue_key(key) != Some(project)
        || !fields.is_object()
        || !fields["summary"].is_string()
    {
        return Err("Jira returned incomplete issue identity, project, or summary data.".into());
    }
    if let Some(fields) = fields.as_object()
        && [
            "description",
            "status",
            "assignee",
            "labels",
            "priority",
            "duedate",
            "updated",
        ]
        .iter()
        .any(|name| !fields.contains_key(*name))
    {
        warn(
            warnings,
            "Some requested Jira fields were not returned and may be unavailable to this account.",
        );
    }
    let (description, partial) = adf_text(&fields["description"]);
    if partial {
        warn(
            warnings,
            "Some Jira rich text was shortened or contains content available only in Jira.",
        );
    }
    let priority_name = text(&fields["priority"]["name"]);
    let priority = match priority_name.to_ascii_lowercase().as_str() {
        "highest" | "blocker" | "critical" | "urgent" => "urgent",
        "high" | "major" => "high",
        "medium" | "normal" => "medium",
        "low" | "lowest" | "minor" | "trivial" => "low",
        _ => "none",
    };
    if priority == "none" && !priority_name.is_empty() {
        warn(
            warnings,
            "A custom Jira priority has no local priority equivalent; its available values are shown in issue details.",
        );
    }
    let labels = fields["labels"]
        .as_array()
        .map(|labels| {
            if labels.len() > 100
                || labels
                    .iter()
                    .any(|label| label.as_str().is_none_or(|label| label.len() > 255))
            {
                warn(warnings, "Some Jira labels were shortened or omitted.");
            }
            labels
                .iter()
                .take(100)
                .filter_map(Value::as_str)
                .map(|label| clip(label, 255))
                .collect()
        })
        .unwrap_or_default();
    Ok(WorkItem {
        id: format!("jira:{host}:{id}"),
        kind: "jira".into(),
        title: clip(text(&fields["summary"]), 4096),
        description,
        // Numeric issue IDs survive issue-key changes and project moves.
        remote: Some(RemoteRef {
            provider: "jira".into(),
            host: host.into(),
            scope: project.into(),
            number: id.into(),
        }),
        url: Some(format!("https://{host}/browse/{key}")),
        remote_state: fields["status"]["name"]
            .as_str()
            .map(|name| clip(name, 256)),
        assignee: clip(text(&fields["assignee"]["accountId"]), 256),
        labels,
        priority: priority.into(),
        due_date: clip(text(&fields["duedate"]), 32),
        checklist: Vec::new(),
        links: Vec::new(),
        updated_at: clip(text(&fields["updated"]), 64),
        fetched_at: Some(fetched_at.into()),
    })
}

pub(super) async fn detail(
    client: &Client,
    connection: &Connection,
    email: &str,
    token: &str,
    remote: &RemoteRef,
) -> Result<RemoteDetail, String> {
    let jira = Jira::new(client, connection, email, token)?;
    let issue = jira.issue(remote).await?;
    let mut warnings = Vec::new();
    let item = item_from_issue(jira.host, &issue, &now_iso(), &mut warnings)?;
    let id = text(&issue["id"]);
    let mut result = RemoteDetail {
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
    };
    match jira
        .get(
            &format!("issue/{id}/comment"),
            &[("maxResults", "50"), ("orderBy", "-created")],
        )
        .await
    {
        Ok(page) => populate_comments(&page, &mut result, &mut warnings),
        Err(error) => warn(&mut warnings, &format!("Discussion unavailable: {error}")),
    }
    match jira.get(&format!("issue/{id}/editmeta"), &[]).await {
        Ok(metadata) => {
            if let Err(error) = populate_edit_options(&metadata, &mut result, &mut warnings) {
                warn(&mut warnings, &error);
            }
        }
        Err(error) => warn(
            &mut warnings,
            &format!("Edit permissions unavailable: {error}"),
        ),
    }
    match jira
        .get(
            &format!("issue/{id}/transitions"),
            &[("expand", "transitions.fields")],
        )
        .await
    {
        Ok(response) => populate_transitions(&response, &mut result, &mut warnings),
        Err(error) => warn(&mut warnings, &format!("Transitions unavailable: {error}")),
    }
    match comment_permission(&jira, id).await {
        Ok(true) => result.actions.push("comment".into()),
        Ok(false) => {}
        Err(error) => warn(
            &mut warnings,
            &format!("Comment permission unavailable: {error}"),
        ),
    }
    result.partial = !warnings.is_empty();
    result.warnings = warnings;
    Ok(result)
}

fn populate_comments(page: &Value, result: &mut RemoteDetail, warnings: &mut Vec<String>) {
    let Some(comments) = page["comments"].as_array() else {
        warn(warnings, "Jira returned an invalid discussion response.");
        return;
    };
    if page["total"]
        .as_u64()
        .is_none_or(|total| total > comments.len() as u64)
        || comments.len() > PAGE_SIZE
    {
        warn(
            warnings,
            "Only the latest 50 visible comments are loaded; open Jira for the complete discussion.",
        );
    }
    for comment in comments.iter().take(PAGE_SIZE).rev() {
        let (body, partial) = adf_text(&comment["body"]);
        if partial {
            warn(
                warnings,
                "Some Jira rich text was shortened or contains content available only in Jira.",
            );
        }
        if !numeric_id(text(&comment["id"])) {
            warn(warnings, "A malformed Jira comment could not be displayed.");
            continue;
        }
        result.comments.push(Comment {
            id: text(&comment["id"]).into(),
            author: clip(
                comment["author"]["displayName"]
                    .as_str()
                    .unwrap_or("Unknown user"),
                256,
            ),
            body,
            updated_at: clip(text(&comment["updated"]), 64),
        });
    }
}

fn populate_edit_options(
    metadata: &Value,
    result: &mut RemoteDetail,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let fields = edit_fields(metadata)?;
    for name in ["assignee", "labels", "priority"] {
        if can_set(fields, name) {
            result.editable_fields.push(name.into());
        }
    }
    if result
        .editable_fields
        .iter()
        .any(|field| field == "priority")
    {
        match fields["priority"]["allowedValues"].as_array() {
            Some(values) => result.priorities = choices(values, warnings),
            None => {
                result.editable_fields.retain(|field| field != "priority");
                warn(
                    warnings,
                    "Jira did not supply the allowed priority values; priority changes are unavailable.",
                );
            }
        }
    }
    if !result.editable_fields.is_empty() {
        result.actions.push("edit".into());
    }
    Ok(())
}

fn populate_transitions(response: &Value, result: &mut RemoteDetail, warnings: &mut Vec<String>) {
    match response["transitions"].as_array() {
        Some(transitions) => {
            result.transitions = choices(transitions, warnings);
            if !result.transitions.is_empty() {
                result.actions.push("transition".into());
            }
        }
        None => warn(warnings, "Jira returned invalid transition metadata."),
    }
}

fn choices(values: &[Value], warnings: &mut Vec<String>) -> Vec<Choice> {
    if values.len() > 100 {
        warn(warnings, "Only the first 100 metadata choices are shown.");
    }
    values
        .iter()
        .take(100)
        .filter_map(|value| {
            if !numeric_id(text(&value["id"])) || text(&value["name"]).is_empty() {
                warn(warnings, "An invalid Jira metadata choice was omitted.");
                None
            } else {
                Some(Choice {
                    id: text(&value["id"]).into(),
                    name: clip(text(&value["name"]), 256),
                })
            }
        })
        .collect()
}

fn edit_fields(metadata: &Value) -> Result<&Map<String, Value>, String> {
    metadata["fields"]
        .as_object()
        .ok_or_else(|| "Jira returned invalid edit metadata.".into())
}

fn can_set(fields: &Map<String, Value>, name: &str) -> bool {
    fields
        .get(name)
        .and_then(|field| field["operations"].as_array())
        .is_some_and(|operations| {
            operations
                .iter()
                .any(|operation| operation.as_str() == Some("set"))
        })
}

async fn comment_permission(jira: &Jira<'_>, id: &str) -> Result<bool, String> {
    let response = jira
        .get(
            "mypermissions",
            &[("issueId", id), ("permissions", "ADD_COMMENTS")],
        )
        .await?;
    response["permissions"]["ADD_COMMENTS"]["havePermission"]
        .as_bool()
        .ok_or_else(|| "Jira did not return an issue-specific comment permission.".into())
}

fn json_body(request: RequestBuilder, body: &Value) -> Result<RequestBuilder, String> {
    Ok(request.header("Content-Type", "application/json").body(
        serde_json::to_vec(body).map_err(|_| "Could not encode the Jira request.".to_string())?,
    ))
}

pub(super) async fn act(
    client: &Client,
    connection: &Connection,
    email: &str,
    token: &str,
    remote: &RemoteRef,
    action: &RemoteAction,
    expected_item_id: &str,
) -> Result<ActionReceipt, String> {
    let jira = Jira::new(client, connection, email, token)?;
    if !matches!(action.kind.as_str(), "comment" | "edit" | "transition")
        || action.review_event.is_some()
        || action.expected_head_sha.is_some()
        || action.merge_method.is_some()
    {
        return Err("Jira supports comments, organization-field edits, and available workflow transitions only.".into());
    }
    let issue = jira.issue(remote).await?;
    let id = text(&issue["id"]);
    if !numeric_id(id) {
        return Err("Jira did not return a stable issue ID; no write was sent.".into());
    }
    if format!("jira:{}:{id}", jira.host) != expected_item_id {
        return Err("The Jira issue identity changed. Refresh the item and confirm the exact target again; no write was sent.".into());
    }
    let (method, path, body, message) = match action.kind.as_str() {
        "comment" => {
            if action.assignee.is_some()
                || action.labels.is_some()
                || action.priority.is_some()
                || action.transition_id.is_some()
            {
                return Err("A comment cannot also change Jira issue fields.".into());
            }
            let body = action
                .body
                .as_deref()
                .ok_or("Enter a comment before sending.")?;
            if body.trim().is_empty() || body.len() > 32_000 || body.contains('\0') {
                return Err("A Jira comment must contain text and be at most 32,000 bytes.".into());
            }
            if !comment_permission(&jira, id).await? {
                return Err("This account cannot add comments to this Jira issue.".into());
            }
            (
                Method::POST,
                format!("issue/{id}/comment"),
                json!({ "body": plain_adf(body) }),
                "Comment added to Jira.",
            )
        }
        "edit" => {
            if action.body.is_some() || action.transition_id.is_some() {
                return Err("Jira edits support assignee, labels, and priority only.".into());
            }
            let metadata = jira.get(&format!("issue/{id}/editmeta"), &[]).await?;
            let fields = organization_fields(edit_fields(&metadata)?, action)?;
            (
                Method::PUT,
                format!("issue/{id}"),
                json!({ "fields": fields }),
                "Jira issue fields updated.",
            )
        }
        "transition" => {
            if action.body.is_some()
                || action.assignee.is_some()
                || action.labels.is_some()
                || action.priority.is_some()
            {
                return Err("A workflow transition cannot also change Jira issue fields.".into());
            }
            let transition_id = action
                .transition_id
                .as_deref()
                .filter(|id| numeric_id(id))
                .ok_or("Choose an available Jira transition.")?;
            let response = jira
                .get(
                    &format!("issue/{id}/transitions"),
                    &[("expand", "transitions.fields")],
                )
                .await?;
            let transitions = response["transitions"]
                .as_array()
                .ok_or("Jira returned invalid transition metadata.")?;
            if !transitions
                .iter()
                .any(|transition| text(&transition["id"]) == transition_id)
            {
                return Err(
                    "This transition is no longer available. Refresh the issue and choose again."
                        .into(),
                );
            }
            (
                Method::POST,
                format!("issue/{id}/transitions"),
                json!({ "transition": { "id": transition_id } }),
                "Jira workflow transition completed.",
            )
        }
        _ => return Err("This Jira action is unsupported.".into()),
    };
    // Jira remains authoritative about field values, workflow validators, and race-time permissions.
    request_write(json_body(jira.request(method, &path, &[])?, &body)?).await?;
    Ok(ActionReceipt {
        message: message.into(),
    })
}

fn organization_fields(
    metadata: &Map<String, Value>,
    action: &RemoteAction,
) -> Result<Map<String, Value>, String> {
    let mut fields = Map::new();
    for (name, supplied) in [
        ("assignee", action.assignee.is_some()),
        ("labels", action.labels.is_some()),
        ("priority", action.priority.is_some()),
    ] {
        if supplied && !can_set(metadata, name) {
            return Err(format!(
                "Jira does not allow this account to set {name} on this issue."
            ));
        }
    }
    if let Some(assignee) = &action.assignee {
        if assignee.len() > 256
            || assignee
                .chars()
                .any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(
                "Use an Atlassian account ID for the assignee, or leave it empty to unassign."
                    .into(),
            );
        }
        if assignee.is_empty() && metadata["assignee"]["required"].as_bool() == Some(true) {
            return Err("This Jira issue requires an assignee.".into());
        }
        fields.insert(
            "assignee".into(),
            if assignee.is_empty() {
                Value::Null
            } else {
                json!({ "accountId": assignee })
            },
        );
    }
    if let Some(labels) = &action.labels {
        if labels.len() > 100
            || labels.iter().any(|label| {
                label.is_empty()
                    || label.len() > 255
                    || label.chars().any(|c| c.is_whitespace() || c.is_control())
            })
        {
            return Err("Use at most 100 non-empty Jira labels, each at most 255 bytes and without whitespace.".into());
        }
        fields.insert("labels".into(), json!(labels));
    }
    if let Some(priority) = &action.priority {
        if !numeric_id(priority) {
            return Err("Choose a Jira priority ID from the available values.".into());
        }
        let allowed = metadata["priority"]["allowedValues"]
            .as_array()
            .ok_or("Jira did not supply the allowed priorities; no write was sent.")?;
        if !allowed.iter().any(|value| text(&value["id"]) == priority) {
            return Err("That priority is not currently available for this Jira issue.".into());
        }
        fields.insert("priority".into(), json!({ "id": priority }));
    }
    if fields.is_empty() {
        return Err("Choose at least one Jira field to change.".into());
    }
    Ok(fields)
}

fn plain_adf(body: &str) -> Value {
    let content: Vec<_> = body
        .split('\n')
        .map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if line.is_empty() {
                json!({ "type": "paragraph", "content": [] })
            } else {
                json!({ "type": "paragraph", "content": [{ "type": "text", "text": line }] })
            }
        })
        .collect();
    json!({ "type": "doc", "version": 1, "content": content })
}

fn adf_text(value: &Value) -> (String, bool) {
    let mut result = String::new();
    let mut partial = false;
    let mut remaining_nodes = 10_000;
    append_adf(value, &mut result, &mut partial, &mut remaining_nodes, 0);
    (result.trim().to_string(), partial)
}

fn append_text(result: &mut String, text: &str, partial: &mut bool) {
    let available = MAX_TEXT_BYTES.saturating_sub(result.len());
    let mut end = text.len().min(available);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    result.push_str(&text[..end]);
    *partial |= end < text.len();
}

fn append_adf(
    value: &Value,
    result: &mut String,
    partial: &mut bool,
    remaining_nodes: &mut usize,
    depth: usize,
) {
    if value.is_null() {
        return;
    }
    if *remaining_nodes == 0 || depth > 32 || result.len() >= MAX_TEXT_BYTES {
        *partial = true;
        return;
    }
    *remaining_nodes -= 1;
    if let Some(text) = value.as_str() {
        append_text(result, text, partial);
        return;
    }
    let kind = text(&value["type"]);
    append_adf_node_text(value, kind, result, partial);
    if let Some(content) = value["content"].as_array() {
        for child in content {
            if *remaining_nodes == 0 || result.len() >= MAX_TEXT_BYTES {
                *partial = true;
                break;
            }
            append_adf(child, result, partial, remaining_nodes, depth + 1);
        }
    }
    if matches!(kind, "paragraph" | "heading")
        || (matches!(
            kind,
            "listItem" | "codeBlock" | "blockquote" | "tableRow" | "panel" | "blockCard"
        ) && !result.ends_with('\n'))
    {
        append_text(result, "\n", partial);
    }
    if matches!(kind, "tableCell" | "tableHeader") {
        append_text(result, "\t", partial);
    }
}

fn append_adf_node_text(value: &Value, kind: &str, result: &mut String, partial: &mut bool) {
    match kind {
        "text" => append_adf_text(value, result, partial),
        "hardBreak" => append_text(result, "\n", partial),
        "rule" => append_text(result, "\n---\n", partial),
        "mention" => append_text(
            result,
            value["attrs"]["text"].as_str().unwrap_or("@user"),
            partial,
        ),
        "emoji" => append_text(
            result,
            value["attrs"]["text"]
                .as_str()
                .or_else(|| value["attrs"]["shortName"].as_str())
                .unwrap_or(":emoji:"),
            partial,
        ),
        "status" => append_text(result, text(&value["attrs"]["text"]), partial),
        "date" => {
            if let Ok(timestamp) = text(&value["attrs"]["timestamp"]).parse::<u64>()
                && timestamp <= 253_402_300_799_999
            {
                append_text(
                    result,
                    &clip(&super::iso_time(timestamp / 1000), 10),
                    partial,
                );
            } else {
                append_text(result, "[date — open in Jira]", partial);
                *partial = true;
            }
        }
        "inlineCard" | "blockCard" | "embedCard" => {
            if let Some(url) = safe_url(text(&value["attrs"]["url"])) {
                append_text(result, &url, partial);
            } else {
                append_text(result, "[linked content]", partial);
                *partial = true;
            }
        }
        "media" | "mediaInline" => {
            append_text(result, "[attachment — open in Jira]", partial);
            *partial = true;
        }
        "listItem" => append_text(result, "- ", partial),
        "doc" | "paragraph" | "heading" | "bulletList" | "orderedList" | "blockquote"
        | "codeBlock" | "panel" | "table" | "tableRow" | "tableCell" | "tableHeader"
        | "mediaGroup" | "mediaSingle" | "expand" | "nestedExpand" => {}
        _ => {
            *partial = true;
            if value["content"].as_array().is_none() {
                append_text(result, "[content — open in Jira]", partial);
            }
        }
    }
}

fn append_adf_text(value: &Value, result: &mut String, partial: &mut bool) {
    let label = text(&value["text"]);
    append_text(result, label, partial);
    if let Some(marks) = value["marks"].as_array() {
        for mark in marks.iter().filter(|mark| text(&mark["type"]) == "link") {
            if let Some(url) = safe_url(text(&mark["attrs"]["href"]))
                && url != label
            {
                append_text(result, &format!(" ({url})"), partial);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_filters_cannot_escape_the_project_constraint() {
        assert_eq!(
            scoped_jql(
                "TEAM",
                "status = Open OR assignee = currentUser() ORDER BY updated DESC"
            )
            .unwrap(),
            "project = \"TEAM\" AND (status = Open OR assignee = currentUser()) ORDER BY updated DESC"
        );
        assert_eq!(
            scoped_jql("TEAM", "summary ~ \"ORDER BY (draft)\"").unwrap(),
            "project = \"TEAM\" AND (summary ~ \"ORDER BY (draft)\") ORDER BY updated DESC, key ASC"
        );
        for filter in [
            "status = Open) OR project = OTHER",
            "status = Open /* ) */ OR project = OTHER",
            "status = Open ORDER BY updated OR project = OTHER",
            "status = \"Open",
        ] {
            assert!(scoped_jql("TEAM", filter).is_err(), "{filter}");
        }
        assert!(scoped_jql("TEAM\" OR project = OTHER", "").is_err());
    }

    #[test]
    fn rich_text_preserves_paragraphs_and_reports_bounded_content() {
        let (rendered, partial) = adf_text(&plain_adf("First\n\nSecond"));
        assert_eq!(rendered, "First\n\nSecond");
        assert!(!partial);
        let large = json!({ "type": "doc", "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "界".repeat(MAX_TEXT_BYTES) }] }
        ] });
        let (rendered, partial) = adf_text(&large);
        assert!(partial);
        assert!(rendered.len() <= MAX_TEXT_BYTES);
        assert!(rendered.chars().all(|character| character == '界'));
        assert!(adf_text(&json!({ "type": "media", "attrs": { "id": "123" } })).1);
    }

    #[test]
    fn issue_identity_survives_project_moves() {
        let mut issue = json!({
            "id": "10001", "key": "OLD-1",
            "fields": { "project": { "key": "OLD" }, "summary": "Moved task" }
        });
        let before = item_from_issue(
            "example.atlassian.net",
            &issue,
            "2026-09-12T00:00:00Z",
            &mut Vec::new(),
        )
        .unwrap();
        issue["key"] = json!("NEW-9");
        issue["fields"]["project"]["key"] = json!("NEW");
        let after = item_from_issue(
            "example.atlassian.net",
            &issue,
            "2026-09-12T00:00:01Z",
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(before.id, after.id);
        assert_eq!(after.remote.as_ref().unwrap().number, "10001");
        assert_eq!(after.remote.as_ref().unwrap().scope, "NEW");
        assert_eq!(
            after.url.as_deref(),
            Some("https://example.atlassian.net/browse/NEW-9")
        );
        assert!(validate_remote("other.atlassian.net", after.remote.as_ref().unwrap()).is_err());
    }

    #[test]
    fn field_edits_require_current_metadata_and_allowed_priority() {
        let action: RemoteAction =
            serde_json::from_value(json!({ "kind": "edit", "priority": "2" })).unwrap();
        let denied =
            json!({ "priority": { "operations": ["add"], "allowedValues": [{ "id": "2" }] } });
        assert!(organization_fields(denied.as_object().unwrap(), &action).is_err());
        let stale =
            json!({ "priority": { "operations": ["set"], "allowedValues": [{ "id": "1" }] } });
        assert!(organization_fields(stale.as_object().unwrap(), &action).is_err());
        let allowed =
            json!({ "priority": { "operations": ["set"], "allowedValues": [{ "id": "2" }] } });
        assert_eq!(
            organization_fields(allowed.as_object().unwrap(), &action).unwrap()["priority"],
            json!({ "id": "2" })
        );
    }
}
