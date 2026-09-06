export interface SourceChange {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  text: string;
}

interface RawDelta {
  start: number;
  removed: string;
  inserted: string;
}

interface HistoryEntry {
  before: number;
  after: number;
  deltas: RawDelta[];
}

function offsetAt(source: string, line: number, column: number): number {
  let currentLine = 1;
  // Monaco removes the leading BOM from its model, but it remains authored source.
  let offset = source.startsWith('\uFEFF') ? 1 : 0;
  while (currentLine < line && offset < source.length) {
    const character = source[offset++];
    if (character === '\r') {
      if (source[offset] === '\n') offset++;
      currentLine++;
    } else if (character === '\n') {
      currentLine++;
    }
  }
  return Math.min(source.length, offset + column - 1);
}

function rawDeltas(source: string, changes: readonly SourceChange[]): RawDelta[] {
  // Event ranges share the pre-edit coordinate space. Apply the last range first.
  return changes.slice().sort((left, right) =>
    right.range.startLineNumber - left.range.startLineNumber ||
    right.range.startColumn - left.range.startColumn,
  ).map(({ range, text }) => {
    const start = offsetAt(source, range.startLineNumber, range.startColumn);
    const end = offsetAt(source, range.endLineNumber, range.endColumn);
    return { start, removed: source.slice(start, end), inserted: text };
  });
}

function applyDeltas(source: string, deltas: readonly RawDelta[], inverse: boolean): string {
  // Undo low ranges first: their inverse restores the offsets of the higher ranges.
  for (let index = inverse ? deltas.length - 1 : 0;
    inverse ? index >= 0 : index < deltas.length;
    index += inverse ? -1 : 1) {
    const delta = deltas[index];
    const removed = inverse ? delta.inserted : delta.removed;
    const inserted = inverse ? delta.removed : delta.inserted;
    source = source.slice(0, delta.start) + inserted + source.slice(delta.start + removed.length);
  }
  return source;
}

export class MarkdownSourceHistory {
  source: string;
  private version: number;
  private entries: HistoryEntry[] = [];
  private cursor = 0;

  constructor(source: string, alternativeVersionId: number) {
    this.source = source;
    this.version = alternativeVersionId;
  }

  apply(changes: readonly SourceChange[], alternativeVersionId: number, direction: 'edit' | 'undo' | 'redo'): string | null {
    if (direction === 'edit') {
      const deltas = rawDeltas(this.source, changes);
      this.source = applyDeltas(this.source, deltas, false);
      this.entries.splice(this.cursor, this.entries.length - this.cursor, {
        before: this.version,
        after: alternativeVersionId,
        deltas,
      });
      this.cursor++;
    } else {
      if (alternativeVersionId === this.version) return this.source;
      let target = this.cursor;
      if (direction === 'undo') {
        while (target > 0 && this.entries[target - 1].before !== alternativeVersionId) target--;
        if (target === 0) return null;
        target--;
      } else {
        while (target < this.entries.length && this.entries[target].after !== alternativeVersionId) target++;
        if (target === this.entries.length) return null;
        target++;
      }
      while (this.cursor > target) {
        this.source = applyDeltas(this.source, this.entries[--this.cursor].deltas, true);
      }
      while (this.cursor < target) {
        this.source = applyDeltas(this.source, this.entries[this.cursor++].deltas, false);
      }
    }
    this.version = alternativeVersionId;
    return this.source;
  }
}
