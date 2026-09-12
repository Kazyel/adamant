mod github;
mod jira;
pub(crate) mod models;
mod store;

use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::{Client, RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use tauri::{Manager, State};

use models::{
    ActionReceipt, Connection, RemoteAction, RemoteDetail, RemotePage, RemoteRef, WorkSource,
};
use store::StoredConnection;

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
pub(crate) struct Identity {
    account: String,
}

#[derive(Deserialize)]
struct GithubIdentity {
    id: u64,
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JiraIdentity {
    account_id: String,
    display_name: String,
}

fn validate_token(token: &str) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty()
        || token.len() > 16_384
        || !token.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err(
            "Enter a valid API token without internal spaces or control characters.".into(),
        );
    }
    Ok(())
}

fn validate_email(email: &str) -> Result<(), String> {
    if email.is_empty()
        || email.len() > 320
        || !email.contains('@')
        || email.chars().any(|character| {
            character.is_whitespace() || character.is_control() || character == ':'
        })
    {
        return Err("Enter the email address associated with your Atlassian API token.".into());
    }
    Ok(())
}

pub(super) fn jira_host(site: &str) -> Result<String, String> {
    let site = site.trim().to_ascii_lowercase();
    let host = site.strip_prefix("https://").unwrap_or(&site);
    let host = host.strip_suffix('/').unwrap_or(host);
    let tenant = host.strip_suffix(".atlassian.net").unwrap_or(host);
    if tenant.is_empty()
        || tenant.len() > 63
        || tenant.starts_with('-')
        || tenant.ends_with('-')
        || !tenant
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || (site.starts_with("https://") && !host.ends_with(".atlassian.net"))
    {
        return Err("Enter a Jira tenant name or https://tenant.atlassian.net, without a port, path, or query.".into());
    }
    Ok(format!("{tenant}.atlassian.net"))
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "The service request timed out. Check your connection and try again.".into()
    } else if error.is_connect() {
        "Could not securely connect to the service. Check your connection and system certificates."
            .into()
    } else {
        "The service request failed. Check your connection and account permissions.".into()
    }
}

fn http_error_message(response: &reqwest::Response) -> String {
    let status = response.status();
    let rate_limited = status == StatusCode::TOO_MANY_REQUESTS
        || (status == StatusCode::FORBIDDEN
            && (response
                .headers()
                .get("x-ratelimit-remaining")
                .is_some_and(|value| value == "0")
                || response.headers().contains_key("retry-after")));
    if rate_limited {
        let delay = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());
        let reset = response
            .headers()
            .get("x-ratelimit-reset")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok());
        return match (delay, reset) {
            (Some(seconds), _) => {
                format!("The service rate limit was reached. Retry after {seconds} seconds.")
            }
            (_, Some(seconds)) => format!(
                "The service rate limit was reached. It resets at {}.",
                iso_time(seconds)
            ),
            _ => "The service rate limit was reached. Wait before trying again.".into(),
        };
    }
    match status {
        StatusCode::UNAUTHORIZED => "Authentication expired or failed. Reconnect the account in Connections.".into(),
        StatusCode::FORBIDDEN => "Access denied. Check token permissions and organization or SSO policy.".into(),
        StatusCode::NOT_FOUND => "The item or endpoint was not found, or this account cannot access it.".into(),
        StatusCode::CONFLICT => "The remote item changed or the action conflicts with its current state. Refresh before trying again.".into(),
        StatusCode::UNPROCESSABLE_ENTITY => "The service rejected this action or filter. Check required fields, permissions and current remote state.".into(),
        _ if status.is_redirection() => "The service returned a redirect, which was blocked to protect your token.".into(),
        _ => format!("The service returned HTTP {}.", status.as_u16()),
    }
}

fn http_error_details(value: &Value) -> Vec<String> {
    let mut details = Vec::new();
    if let Some(messages) = value["errorMessages"].as_array() {
        details.extend(
            messages
                .iter()
                .take(8)
                .filter_map(Value::as_str)
                .map(|value| clip(value, 512)),
        );
    }
    if let Some(errors) = value["errors"].as_object() {
        details.extend(errors.iter().take(8).filter_map(|(field, error)| {
            error
                .as_str()
                .map(|error| format!("{}: {}", clip(field, 80), clip(error, 512)))
        }));
    }
    if details.is_empty()
        && let Some(value) = value["message"].as_str()
    {
        details.push(clip(value, 1024));
    }
    details
}

async fn http_error(mut response: reqwest::Response) -> String {
    let mut message = http_error_message(&response);
    if matches!(
        response.status(),
        StatusCode::BAD_REQUEST
            | StatusCode::UNPROCESSABLE_ENTITY
            | StatusCode::CONFLICT
            | StatusCode::METHOD_NOT_ALLOWED
    ) {
        let mut bytes = Vec::new();
        while let Ok(Some(chunk)) = response.chunk().await {
            if bytes.len() + chunk.len() > 16 * 1024 {
                break;
            }
            bytes.extend_from_slice(&chunk);
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            let details = http_error_details(&value);
            if !details.is_empty() {
                message.push_str(&format!(" {}", clip(&details.join("; "), 4096)));
            }
        }
    }
    message
}

pub(super) async fn request_json(request: RequestBuilder) -> Result<Value, String> {
    let mut response = request.send().await.map_err(network_error)?;
    let status = response.status();
    if !status.is_success() {
        return Err(http_error(response).await);
    }
    if status == StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("The service response exceeded the 8 MiB safety limit.".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("The service response exceeded the 8 MiB safety limit.".into());
        }
        body.extend_from_slice(&chunk);
    }
    if body.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&body)
        .map_err(|_| "The service returned an invalid JSON response.".into())
}

pub(super) async fn request_write(request: RequestBuilder) -> Result<Value, String> {
    request_json(request).await.map_err(|error| format!("{error} The write may have reached the service. Refresh there before retrying; Adamant did not retry."))
}

async fn request_identity<T: DeserializeOwned>(request: RequestBuilder) -> Result<T, String> {
    serde_json::from_value(request_json(request).await?).map_err(|_| {
        "The service returned an invalid identity response. No credential was saved.".into()
    })
}

pub(super) fn clip(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.into();
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

pub(super) fn safe_url(value: &str) -> Option<String> {
    if value.len() > 8192 {
        return None;
    }
    let url = reqwest::Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none())
    .then(|| url.into())
}

pub(super) fn now_iso() -> String {
    iso_time(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs()),
    )
}

fn iso_time(seconds: u64) -> String {
    // Gregorian civil date from Unix days; timestamps are UTC and need no locale dependency.
    let days = (seconds / 86400).min(2_932_896) as i64 + 719468;
    let era = days / 146097;
    let day_of_era = days - era * 146097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds / 3600 % 24,
        seconds / 60 % 60,
        seconds % 60
    )
}

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|_| "App-local connection storage is unavailable.".into())
}

fn service(record: &StoredConnection) -> String {
    if record.connection.provider == "github" {
        "io.adamant.m0.github".into()
    } else {
        format!("io.adamant.m0.jira.{}", record.connection.host)
    }
}

async fn store_token(record: StoredConnection, token: String, data: PathBuf) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::v1::Entry::new(&service(&record), &record.account_id).map_err(|_| {
            "Identity verified, but the OS credential store is unavailable. On Linux, unlock a Secret Service keyring on your desktop session bus, then restart Adamant.".to_string()
        })?;
        entry.set_password(token.trim()).map_err(|_| {
            "Identity verified, but the token could not be saved securely. Unlock the OS credential store and try again; Adamant has no plaintext fallback.".to_string()
        })?;
        store::save_connection(&data, record).map_err(|error| format!("The token is securely stored, but connection discovery could not be saved: {error}"))
    }).await.map_err(|_| "The credential-store operation stopped unexpectedly.".to_string())?
}

async fn token(record: &StoredConnection) -> Result<String, String> {
    let record = record.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::v1::Entry::new(&service(&record), &record.account_id)
            .map_err(|_| "The OS credential store is unavailable. Unlock it and reconnect the account.".to_string())?;
        let token = entry.get_password().map_err(|_| "The saved credential is unavailable. Unlock the OS keyring or reconnect this account in Connections.".to_string())?;
        validate_token(&token)?;
        Ok(token)
    }).await.map_err(|_| "The credential-store operation stopped unexpectedly.".to_string())?
}

async fn connection(app: &tauri::AppHandle, id: String) -> Result<StoredConnection, String> {
    if id.len() > 128 {
        return Err("Invalid connection identity.".into());
    }
    let data = app_data(app)?;
    tauri::async_runtime::spawn_blocking(move || {
        store::connections(&data)?
            .into_iter()
            .find(|record| record.connection.id == id)
            .ok_or_else(|| {
                "This connection is unavailable. Reconnect the account in Connections.".into()
            })
    })
    .await
    .map_err(|_| "Connection discovery stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub(crate) async fn check_github(
    token: String,
    state: State<'_, Client>,
    app: tauri::AppHandle,
) -> Result<Identity, String> {
    validate_token(&token)?;
    let identity: GithubIdentity = request_identity(
        state
            .get("https://api.github.com/user")
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .bearer_auth(token.trim()),
    )
    .await?;
    if identity.id == 0 || identity.login.trim().is_empty() || identity.login.len() > 1024 {
        return Err("GitHub returned an incomplete identity. No credential was saved.".into());
    }
    let record = StoredConnection {
        connection: Connection {
            id: store::connection_id("github", "github.com", &identity.id.to_string()),
            provider: "github".into(),
            account: identity.login.clone(),
            host: "github.com".into(),
        },
        account_id: identity.id.to_string(),
        email: None,
    };
    store_token(record, token, app_data(&app)?).await?;
    Ok(Identity {
        account: identity.login,
    })
}

#[tauri::command]
pub(crate) async fn check_jira(
    site: String,
    email: String,
    token: String,
    state: State<'_, Client>,
    app: tauri::AppHandle,
) -> Result<Identity, String> {
    let host = jira_host(&site)?;
    let email = email.trim();
    validate_email(email)?;
    validate_token(&token)?;
    let identity: JiraIdentity = request_identity(
        state
            .get(format!("https://{host}/rest/api/3/myself"))
            .header("Accept", "application/json")
            .basic_auth(email, Some(token.trim())),
    )
    .await?;
    if identity.account_id.trim().is_empty()
        || identity.account_id.len() > 512
        || identity.display_name.trim().is_empty()
        || identity.display_name.len() > 1024
    {
        return Err("Jira returned an incomplete identity. No credential was saved.".into());
    }
    let record = StoredConnection {
        connection: Connection {
            id: store::connection_id("jira", &host, &identity.account_id),
            provider: "jira".into(),
            account: identity.display_name.clone(),
            host,
        },
        account_id: identity.account_id,
        email: Some(email.into()),
    };
    store_token(record, token, app_data(&app)?).await?;
    Ok(Identity {
        account: identity.display_name,
    })
}

#[tauri::command]
pub(crate) async fn work_connections(app: tauri::AppHandle) -> Result<Vec<Connection>, String> {
    let data = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(store::connections(&data)?
            .into_iter()
            .map(|record| record.connection)
            .collect())
    })
    .await
    .map_err(|_| "Connection discovery stopped unexpectedly.".to_string())?
}

fn validate_remote(connection: &Connection, remote: &RemoteRef) -> Result<(), String> {
    if remote.provider != connection.provider
        || remote.host != connection.host
        || remote.scope.is_empty()
        || remote.scope.len() > 256
        || remote.number.is_empty()
        || remote.number.len() > 128
    {
        return Err(
            "The remote item does not match this connection or has an invalid identity.".into(),
        );
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn work_remote_list(
    connection_id: String,
    source: WorkSource,
    cursor: Option<String>,
    state: State<'_, Client>,
    app: tauri::AppHandle,
) -> Result<RemotePage, String> {
    let record = connection(&app, connection_id).await?;
    let metadata = &record.connection;
    if source.connection_id != metadata.id
        || source.provider != metadata.provider
        || source.host != metadata.host
        || source.scope.is_empty()
        || source.scope.len() > 256
        || source.filter.len() > 4096
        || cursor.as_ref().is_some_and(|value| value.len() > 8192)
    {
        return Err(
            "The source does not match this connection or exceeds its safety limits.".into(),
        );
    }
    let token = token(&record).await?;
    match metadata.provider.as_str() {
        "github" => github::list(&state, metadata, &token, &source, cursor.as_deref()).await,
        "jira" => {
            jira::list(
                &state,
                metadata,
                record
                    .email
                    .as_deref()
                    .ok_or("Reconnect this Jira account to restore its email.")?,
                &token,
                &source,
                cursor.as_deref(),
            )
            .await
        }
        _ => Err("This connection provider is unsupported.".into()),
    }
}

#[tauri::command]
pub(crate) async fn work_remote_detail(
    connection_id: String,
    remote: RemoteRef,
    state: State<'_, Client>,
    app: tauri::AppHandle,
) -> Result<RemoteDetail, String> {
    let record = connection(&app, connection_id).await?;
    validate_remote(&record.connection, &remote)?;
    let result = async {
        let token = token(&record).await?;
        match record.connection.provider.as_str() {
            "github" => github::detail(&state, &record.connection, &token, &remote).await,
            "jira" => {
                jira::detail(
                    &state,
                    &record.connection,
                    record
                        .email
                        .as_deref()
                        .ok_or("Reconnect this Jira account to restore its email.")?,
                    &token,
                    &remote,
                )
                .await
            }
            _ => Err("This connection provider is unsupported.".into()),
        }
    }
    .await;
    let data = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || match result {
        Ok(mut detail) => {
            if let Err(error) = store::save_detail(&data, &record.connection.id, &remote, &detail) {
                detail.warnings.push(error);
            }
            Ok(detail)
        },
        Err(error) => match store::cached(&data, &record.connection.id, &remote) {
            Ok(Some(mut cached)) => {
                cached.stale = true;
                cached.actions.clear();
                cached.editable_fields.clear();
                cached.warnings.push(format!("Showing stale offline detail. {error} No remote action is available until a live refresh succeeds."));
                Ok(cached)
            },
            Ok(None) => Err(error),
            Err(cache_error) => Err(format!("{error} Offline cache is unavailable: {cache_error}")),
        },
    }).await.map_err(|_| "Remote detail storage stopped unexpectedly.".to_string())?
}

fn validate_action(action: &RemoteAction) -> Result<(), String> {
    if !matches!(
        action.kind.as_str(),
        "comment" | "edit" | "close" | "reopen" | "transition" | "review" | "merge"
    ) || action
        .body
        .as_ref()
        .is_some_and(|value| value.len() > 65536 || value.contains('\0'))
        || action
            .assignee
            .as_ref()
            .is_some_and(|value| value.len() > 512 || value.chars().any(char::is_control))
        || action.labels.as_ref().is_some_and(|values| {
            values.len() > 100
                || values.iter().any(|value| {
                    value.is_empty() || value.len() > 255 || value.chars().any(char::is_control)
                })
        })
        || [
            &action.priority,
            &action.transition_id,
            &action.review_event,
            &action.expected_head_sha,
            &action.merge_method,
        ]
        .iter()
        .any(|value| {
            value
                .as_ref()
                .is_some_and(|value| value.len() > 512 || value.chars().any(char::is_control))
        })
    {
        return Err("This remote action is invalid or exceeds its safety limits.".into());
    }
    let fields = action.assignee.is_some() || action.labels.is_some() || action.priority.is_some();
    if (fields && action.kind != "edit")
        || (action.body.is_some() && !matches!(action.kind.as_str(), "comment" | "review"))
        || (action.transition_id.is_some() && action.kind != "transition")
        || (action.review_event.is_some() && action.kind != "review")
        || (action.expected_head_sha.is_some()
            && !matches!(action.kind.as_str(), "review" | "merge"))
        || (action.merge_method.is_some() && action.kind != "merge")
    {
        return Err("A remote action cannot also perform a different action or silently ignore submitted fields.".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn work_remote_act(
    connection_id: String,
    remote: RemoteRef,
    action: RemoteAction,
    expected_item_id: String,
    state: State<'_, Client>,
    app: tauri::AppHandle,
) -> Result<ActionReceipt, String> {
    validate_action(&action)?;
    if expected_item_id.is_empty()
        || expected_item_id.len() > 512
        || expected_item_id.chars().any(char::is_control)
    {
        return Err(
            "The displayed item's immutable identity is required before any remote action.".into(),
        );
    }
    let record = connection(&app, connection_id).await?;
    validate_remote(&record.connection, &remote)?;
    let token = token(&record).await?;
    let result = match record.connection.provider.as_str() {
        "github" => {
            github::act(
                &state,
                &record.connection,
                &token,
                &remote,
                &action,
                &expected_item_id,
            )
            .await
        }
        "jira" => {
            jira::act(
                &state,
                &record.connection,
                record
                    .email
                    .as_deref()
                    .ok_or("Reconnect this Jira account to restore its email.")?,
                &token,
                &remote,
                &action,
                &expected_item_id,
            )
            .await
        }
        _ => Err("This connection provider is unsupported.".into()),
    };
    // Even an ambiguous write must not leave an apparently fresh, actionable detail in cache.
    let data = app_data(&app)?;
    let invalidated = tauri::async_runtime::spawn_blocking(move || {
        store::invalidate(&data, &record.connection.id, &remote)
    })
    .await
    .map_err(|_| "Remote cache invalidation stopped unexpectedly.".to_string())?;
    match (result, invalidated) {
        (Ok(mut receipt), Err(error)) => {
            receipt
                .message
                .push_str(&format!(" Offline cache could not be invalidated: {error}"));
            Ok(receipt)
        }
        (result, _) => result,
    }
}

pub(crate) fn client() -> Client {
    Client::builder()
        .user_agent("Adamant/0.1.0")
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .tls_sslkeylogfile(false)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .expect("Could not initialize Adamant's HTTPS client")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jira_hosts_cannot_change_authenticated_origin() {
        assert_eq!(jira_host("Example").unwrap(), "example.atlassian.net");
        assert_eq!(
            jira_host("https://example.atlassian.net/").unwrap(),
            "example.atlassian.net"
        );
        for host in [
            "https://example.com",
            "example.atlassian.net.evil.com",
            "https://user@example.atlassian.net",
            "example.atlassian.net:8443",
            "example.atlassian.net/path",
            "http://example.atlassian.net",
        ] {
            assert!(jira_host(host).is_err());
        }
    }

    #[test]
    fn actions_never_silently_combine_a_comment_and_an_edit() {
        let action: RemoteAction = serde_json::from_value(serde_json::json!({ "kind": "comment", "body": "Discuss", "labels": ["secret-change"] })).unwrap();
        assert!(validate_action(&action).is_err());
    }

    #[test]
    fn timestamps_are_utc_across_leap_day_boundaries() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_time(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(iso_time(1_709_251_200), "2024-03-01T00:00:00Z");
    }
}
