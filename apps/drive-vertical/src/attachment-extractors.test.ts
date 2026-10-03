import { describe, expect, it } from 'vitest';
import { defaultAttachmentExtractors } from '@substrat-run/attachment-extractors';
import { assertAttachmentExtractors, chooseAttachmentExtractor, runAttachmentExtractor } from '@substrat-run/kernel';

// Exercise the published parsers through Canopy's pinned kernel, not the parser's
// transitive kernel version. This is the host seam used by attachment jobs.
describe('published attachment extractors with the drive kernel', () => {
  const extractors = defaultAttachmentExtractors();
  it('accepts the declarations at host construction', () => {
    expect(() => assertAttachmentExtractors(extractors)).not.toThrow();
    for (const extension of ['docx', 'xlsx', 'pptx']) {
      expect(chooseAttachmentExtractor(extractors, 'application/octet-stream', `report.${extension}`)?.name).toBe(extension);
    }
    expect(chooseAttachmentExtractor(extractors, 'application/pdf', 'report.pdf')).toBeUndefined();
  });
  it.each([
    ['text/plain', 'notes.txt', ' hello   world ', 'hello world', 'text'],
    ['text/html', 'notes.html', '<p>hello world</p><script>secret()</script>', 'hello world', 'html'],
  ])('indexes %s through the current kernel runner', async (contentType, filename, body, text, name) => {
    const extractor = chooseAttachmentExtractor(extractors, contentType, filename)!;
    expect(await runAttachmentExtractor(extractor, { body: new TextEncoder().encode(body), contentType, filename }))
      .toEqual({ status: 'indexed', extractor: name, text, truncated: false });
  });
  it('honours the kernel output budget', async () => {
    const extractor = chooseAttachmentExtractor(extractors, 'text/plain', 'notes.txt')!;
    const result = await runAttachmentExtractor(extractor, {
      body: new TextEncoder().encode('hello world'), contentType: 'text/plain', filename: 'notes.txt',
    }, { maxInputBytes: 100, maxTextBytes: 5, timeoutMs: 1000 });
    expect(result).toEqual({ status: 'indexed', extractor: 'text', text: 'hello', truncated: true });
  });
});
