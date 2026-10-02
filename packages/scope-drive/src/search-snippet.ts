/** Plain text context; callers gate the file and current extraction before using it. */
export function searchSnippet(text: string, term: string): string {
  const at = text.toLowerCase().indexOf(term.trim().toLowerCase());
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, start + 240);
  return `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}
