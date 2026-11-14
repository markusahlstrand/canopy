/** What the flow routes answer, shared with the app (which must not bundle the routes). */

/** One document a flow would act on now. */
export interface PreviewMatch {
  fileId: string; name: string; folderPath: string;
  category: string | null;
  /** It passes every plain condition; a model question decides the rest when the flow runs. */
  needsAnswer: boolean;
  /** A saved flow already acted on it (or it is waiting for approval): running again skips it. */
  handled: boolean;
}

export interface FlowPreview {
  /** The first matches, in file order. */
  matches: PreviewMatch[];
  /** All the documents that pass the plain conditions, `uncertain` of them hinging on a model question. */
  matched: number;
  uncertain: number;
  /** Documents looked at, and whether the space has more than a preview reads. */
  scanned: number;
  truncated: boolean;
}
