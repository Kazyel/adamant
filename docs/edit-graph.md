# Edit the graph with an external agent

Use this procedure to change connections or node positions without editing the documents. The [document graph contract](graph-contract.md) defines the fields and limits.

1. Close Adamant after saving pending work, or coordinate with its graph writer through the existing `.adamant/marker` lock. Do not invent or replace the ownership marker. If the graph storage does not exist yet, create one connection or move one node in Adamant first.
2. Read `vault.json` and `.adamant/graph.json`. Check that their Vault UUIDs match. Preserve the graph's original bytes and revision for comparison.
3. Change the JSON record. Preserve unrelated nodes, connections, and positions. Keep existing node keys stable. Resolve file paths relative to `contentRoot` when the manifest declares it, or relative to the Vault container otherwise.
4. Validate the result against [graph.schema.json](../schemas/graph.schema.json). Check that node keys and connection IDs are unique, endpoints exist, and connections have no self-links or reversed duplicates. Check the UTF-8 byte limits in the contract.
5. Re-read the original graph before replacement. If its bytes or revision changed, stop and reconcile both versions. Do not retry the old write automatically.
6. Increase `revision` by one, write the complete replacement to a sibling temporary file, and install it while other writers remain excluded. Retain the previous bytes until verification succeeds.
7. Reopen or refresh the graph in Adamant. Verify the connections and positions before deleting your backup.

To repair a moved file without an existing UUID, update its node's `path` and preserve its `key`. Do not insert an `id` into the source or create companion metadata for the graph. Existing UUIDs may be copied into a node's `id` when they identify the intended file unambiguously.
