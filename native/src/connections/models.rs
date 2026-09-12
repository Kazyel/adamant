use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Connection {
    pub id: String,
    pub provider: String,
    pub account: String,
    pub host: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkSource {
    pub id: String,
    pub connection_id: String,
    pub provider: String,
    pub host: String,
    pub scope: String,
    pub filter: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteRef {
    pub provider: String,
    pub host: String,
    pub scope: String,
    pub number: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub description: String,
    pub remote: Option<RemoteRef>,
    pub url: Option<String>,
    pub remote_state: Option<String>,
    pub assignee: String,
    pub labels: Vec<String>,
    pub priority: String,
    pub due_date: String,
    pub checklist: Vec<serde_json::Value>,
    pub links: Vec<serde_json::Value>,
    pub updated_at: String,
    pub fetched_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteAction {
    pub kind: String,
    pub body: Option<String>,
    pub assignee: Option<String>,
    pub labels: Option<Vec<String>>,
    pub priority: Option<String>,
    pub transition_id: Option<String>,
    pub review_event: Option<String>,
    pub expected_head_sha: Option<String>,
    pub merge_method: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Comment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Commit {
    pub sha: String,
    pub message: String,
    pub author: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Check {
    pub name: String,
    pub status: String,
    pub url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct DiffFile {
    pub path: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub patch: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Choice {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteDetail {
    pub item: WorkItem,
    pub comments: Vec<Comment>,
    pub commits: Vec<Commit>,
    pub checks: Vec<Check>,
    pub files: Vec<DiffFile>,
    pub transitions: Vec<Choice>,
    pub priorities: Vec<Choice>,
    pub actions: Vec<String>,
    pub editable_fields: Vec<String>,
    pub head_sha: Option<String>,
    pub partial: bool,
    pub stale: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemotePage {
    pub items: Vec<WorkItem>,
    pub next_cursor: Option<String>,
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct ActionReceipt {
    pub message: String,
}
