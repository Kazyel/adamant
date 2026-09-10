use std::time::Duration;

use reqwest::{Client, RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tauri::State;

const MAX_IDENTITY_BYTES: usize = 1024 * 1024;

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

fn jira_host(site: &str) -> Result<String, String> {
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
        "The identity request timed out. Check your connection and try again.".into()
    } else if error.is_connect() {
        "Could not securely connect to the service. Check your connection and system certificates."
            .into()
    } else {
        "The identity request failed. No credential was saved.".into()
    }
}

async fn request_identity<T: DeserializeOwned>(request: RequestBuilder) -> Result<T, String> {
    let mut response = request.send().await.map_err(network_error)?;
    let status = response.status();
    if !status.is_success() {
        return Err(match status {
            StatusCode::UNAUTHORIZED => {
                "Authentication failed. Check the token and account details.".into()
            }
            StatusCode::FORBIDDEN => {
                "Access denied. Check token permissions and organization or SSO policy.".into()
            }
            StatusCode::NOT_FOUND => {
                "The identity endpoint was not found. Check the Jira tenant, if applicable.".into()
            }
            StatusCode::TOO_MANY_REQUESTS => {
                "The service rate limit was reached. Wait before trying again.".into()
            }
            _ if status.is_redirection() => {
                "The service returned a redirect, which was blocked to protect your token.".into()
            }
            _ => format!(
                "The service returned HTTP {}. No credential was saved.",
                status.as_u16()
            ),
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_IDENTITY_BYTES as u64)
    {
        return Err("The identity response exceeded the size limit.".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if body.len() + chunk.len() > MAX_IDENTITY_BYTES {
            return Err("The identity response exceeded the size limit.".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| {
        "The service returned an invalid identity response. No credential was saved.".into()
    })
}

async fn store_token(service: String, account: String, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::v1::Entry::new(&service, &account).map_err(|_| {
            "Identity verified, but the OS credential store is unavailable. On Linux, unlock a Secret Service keyring on your desktop session bus, then restart Adamant.".to_string()
        })?;
        entry.set_password(token.trim()).map_err(|_| {
            "Identity verified, but the token could not be saved securely. Unlock the OS credential store and try again; Adamant has no plaintext fallback.".to_string()
        })
    })
    .await
    .map_err(|_| "The credential-store operation stopped unexpectedly.".to_string())?
}

#[tauri::command]
pub(crate) async fn check_github(
    token: String,
    state: State<'_, Client>,
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
    if identity.id == 0 || identity.login.trim().is_empty() {
        return Err("GitHub returned an incomplete identity. No credential was saved.".into());
    }
    store_token(
        "io.adamant.m0.github".into(),
        identity.id.to_string(),
        token,
    )
    .await?;
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
) -> Result<Identity, String> {
    let host = jira_host(&site)?;
    let email = email.trim();
    if email.is_empty()
        || email.len() > 320
        || !email.contains('@')
        || email.chars().any(|character| {
            character.is_whitespace() || character.is_control() || character == ':'
        })
    {
        return Err("Enter the email address associated with your Atlassian API token.".into());
    }
    validate_token(&token)?;
    let identity: JiraIdentity = request_identity(
        state
            .get(format!("https://{host}/rest/api/3/myself"))
            .header("Accept", "application/json")
            .basic_auth(email, Some(token.trim())),
    )
    .await?;
    if identity.account_id.trim().is_empty() || identity.display_name.trim().is_empty() {
        return Err("Jira returned an incomplete identity. No credential was saved.".into());
    }
    store_token(
        format!("io.adamant.m0.jira.{host}"),
        identity.account_id,
        token,
    )
    .await?;
    Ok(Identity {
        account: identity.display_name,
    })
}

pub(crate) fn client() -> Client {
    Client::builder()
        .user_agent("Adamant-M0/0.1.0")
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .tls_sslkeylogfile(false)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .expect("Could not initialize Adamant's HTTPS client")
}
