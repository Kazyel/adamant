export const noteTemplates = [
  { id: 'blank', name: 'Blank note', description: 'Start with an empty note.', sections: [] },
  {
    id: 'decision',
    name: 'Technical decision',
    description: 'Record context, alternatives, the decision and its consequences.',
    sections: ['Context', 'Alternatives', 'Decision', 'Consequences'],
  },
  {
    id: 'meeting',
    name: 'Meeting',
    description: 'Prepare an agenda and keep decisions and next steps together.',
    sections: ['Participants', 'Agenda', 'Notes', 'Decisions', 'Action items'],
  },
  {
    id: 'study',
    name: 'Study',
    description: 'Keep questions, findings, sources and your next step in one note.',
    sections: ['Questions', 'Notes', 'Sources', 'Next step'],
  },
] as const;
export type NoteTemplate = (typeof noteTemplates)[number]['id'];
export function templateText(template: NoteTemplate, filename: string): string {
  const selected = noteTemplates.find((item) => item.id === template)!;
  if (!selected.sections.length) {
    return '';
  }
  const title = filename
    .split(/[/\\]/)
    .at(-1)!
    .replace(/\.md$/i, '')
    .replace(/[\r\n]/g, ' ')
    .replace(/[\\`*_{}[\]()#+.!<>|~-]/g, '\\$&');
  return `# ${title}\n\n${selected.sections.map((section) => `## ${section}\n\n${section === 'Action items' ? '- [ ] \n\n' : ''}`).join('')}`;
}
