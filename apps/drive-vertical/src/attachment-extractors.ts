import { defaultAttachmentExtractors } from '@substrat-run/attachment-extractors';

/**
 * The kernel's attachment-text extractors, without PDF. Since attachment-extractors 0.2 the
 * defaults read PDFs, but the drive already indexes PDFs through its own path
 * (`extractAndRecord` → `drive/record-text`, which search reads), and the kernel's copy of the
 * text is never read here. Keeping both would extract every PDF twice and backfill every old one.
 */
export const driveAttachmentExtractors = () => defaultAttachmentExtractors().filter((extractor) => extractor.name !== 'pdf');
