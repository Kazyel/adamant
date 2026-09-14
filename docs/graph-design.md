# File graph design

## Delivery checklist

- [x] Trace document identities, annotations, source saves, and navigation.
- [x] Compare metadata references with a separate portable graph record.
- [x] Choose JSON storage and preserve all document bytes.
- [x] Implement graph reading, editing, and the interactive 2D view.
- [x] Verify persistence, conflict handling, and rendered interactions.
- [x] Install and confirm the desktop build.

## Usage and ownership

Open **Graph** in the ribbon. Click a node to select it; Shift+click opens its file. Selecting it again clears selection without moving or zooming the canvas. Drag a node to reposition it. Select a file in the sidebar, then drag its plus handle onto another node or choose **Connect file** and select a second file. The floating details panel beside the selected node shows its total connection count and actions to open or connect the file, without listing individual connections. These actions never edit document contents or insert references into Markdown.

`ui/features/graph/` owns graph loading, serialization, layout, selection, pan/zoom, and persistence. `ui/app/` composes the section and registers its save guard with the workspace coordinator. The graph remains mounted after file navigation so pending saves and failed changes remain available. Vault switching and application closing wait for graph saves and stop on unresolved failures.

The native Vault stores authored connections and positions in `.adamant/graph.json`. It confines filesystem access, checks the Vault scope and expected revision, and protects replacement using the existing lock and atomic-exchange primitives. Source files, frontmatter, and companions remain unchanged.

## Data contract

See [the graph contract](graph-contract.md), [JSON schema](../schemas/graph.schema.json), and [agent editing procedure](edit-graph.md).

- Nodes have opaque stable graph keys, file paths, optional existing file UUIDs, and explicit coordinates.
- Connections have stable IDs and refer to graph keys. The connection is undirected.
- All supported indexed files appear, including isolated files. Missing saved files retain their positions and connections. Incomplete inventory is explicit.
- Existing file UUIDs support path changes. Files without UUIDs resolve by stored path; the JSON path must be corrected after a rename.
- Existing annotation references and ordinary Markdown body links are separate from graph connections.
- Writes are debounced and serialized. A failed save retains local changes and stops automatic retries. Reloading the saved graph requires an explicit discard confirmation.

## Alternatives and implementation choices

Writing `refs` in frontmatter or companion metadata would reuse annotation storage but would change authored documents. JSON satisfies the requested file-independent workflow and also stores node coordinates without coupling them to the editor.

Canvas draws all graph nodes and connections; the right sidebar floats above it and contains search, file-type filters and the file list. Showing or hiding the sidebar never changes the canvas dimensions or camera. Node details and connection actions appear in a floating panel on the canvas, below a compact header. Automatic initial layout uses component rings. Authored positions take precedence and remain fixed when connections change. There is no continuous physics simulation or added rendering dependency.
