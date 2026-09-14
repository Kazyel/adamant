# Document graph contract

The interactive document graph stores its authored connections and node positions in `.adamant/graph.json`, inside the Vault container. The [JSON schema](../schemas/graph.schema.json) describes the record. [Edit the graph with an external agent](edit-graph.md) describes the write procedure.

The graph never modifies Markdown bodies, frontmatter, PDF or DOCX originals, or companion metadata. Opening the graph does not create `graph.json`. Existing annotation `refs` remain independent and are not imported into this graph.

## Record

```json
{
  "vaultId": "7f27ae62-a642-44ce-9da4-8b34a380f91c",
  "revision": 1,
  "graph": {
    "version": 1,
    "nodes": [
      { "key": "path:notes/idea.md", "path": "notes/idea.md", "id": null, "x": 100, "y": 200 },
      { "key": "path:paper.pdf", "path": "paper.pdf", "id": null, "x": 400, "y": 200 }
    ],
    "edges": [{ "id": "reading-link", "source": "path:notes/idea.md", "target": "path:paper.pdf" }]
  }
}
```

`vaultId` equals the UUID in `vault.json`. An absent graph has revision `0`; the first application save writes revision `1`. Every subsequent save increments the revision. Application output uses indented JSON with a trailing newline.

| Field                              | Meaning                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `graph.version`                    | Record format version, currently `1`.                                                                           |
| `nodes[].key`                      | Unique, stable graph-local key referenced by edges. The key is opaque after creation.                           |
| `nodes[].path`                     | File path relative to the Vault content root, with `/` separators.                                              |
| `nodes[].id`                       | Existing file UUID, or `null` when the file has no authored UUID.                                               |
| `nodes[].x`, `nodes[].y`           | Saved graph coordinates. Both are numbers, or both are null or absent.                                          |
| `edges[].id`                       | Unique connection ID.                                                                                           |
| `edges[].source`, `edges[].target` | Two distinct node keys. Connections are undirected; reversing the endpoints does not create another connection. |

The application writes `id`, `x`, and `y` explicitly, including null values. Readers also accept their absence. Unknown fields are rejected at every object level. Missing files remain valid node records, so deleting a file does not delete its connections.

## Resolution

Graph reads combine the saved record with the current Markdown, PDF, and DOCX inventory. Unsaved inventory nodes receive a `uuid:<UUID>` key when the UUID is unique, or a `path:<path>` key otherwise. Existing keys remain unchanged when files resolve at a new path.

A unique existing UUID resolves file moves without rewriting the source. Duplicate UUIDs leave a saved identity-based node unresolved. Separate path-keyed nodes can still identify each duplicate at its explicit path. Missing targets and incomplete inventory remain visible.

Files without UUIDs resolve by their stored path. Moving or renaming such a file, including through Adamant, does not currently rewrite its graph path. The saved node remains unresolved until its path is explicitly corrected. A different file later placed at that path becomes the path-bound node's target. The graph does not infer content identity from filenames or file bytes.

## Limits and writes

| Resource          |                                        Limit |
| ----------------- | -------------------------------------------: |
| Serialized record |                                       32 MiB |
| Saved nodes       |                                       50,000 |
| Connections       |                                      100,000 |
| Node key          |                            8,192 UTF-8 bytes |
| Path              |                            4,096 UTF-8 bytes |
| Connection ID     |                              256 UTF-8 bytes |
| Each coordinate   | Finite number from −10,000,000 to 10,000,000 |
| Revision          |      Integer from 0 to 9,007,199,254,740,991 |

The schema expresses character limits. Native validation also enforces byte limits, valid paths, unique keys and connection IDs, distinct endpoints, and unique unordered endpoint pairs. Every endpoint must name a saved node. Paths accept only `.md`, `.pdf`, and `.docx`, case-insensitively.

Application writes bind the canonical Vault root and UUID, check the expected revision, and lock the owned `.adamant/marker`. Creation uses exclusive installation; replacement uses the existing atomic-exchange primitive. Symlinked storage is rejected. Detected write races retain staging bytes for inspection. Unsupported exchange operations fail without an unsafe overwrite fallback.

External writers must advance `revision` and coordinate with application writes. Revision checks alone do not protect against an external editor that replaces a record without advancing its revision. An atomic rename alone does not prevent lost updates. `.adamant-write-graph-*.json` files retained after an error are recovery material, not disposable previews.
