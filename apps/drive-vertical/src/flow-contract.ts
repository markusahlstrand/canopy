/**
 * What the flow routes take and answer, shared with the app (which must not bundle the routes).
 *
 * Flows belong to the install. Each is shown to whoever owns every space it touches, and the
 * routes answer with those spaces named, so the app can tag and filter by them.
 */
import type { FlowDelivery, FlowGraph, StoredFlow } from '@canopy/scope-drive/spec/model';

/** A space a flow touches: it watches it (the trigger), writes to it (a copy), or both. */
export interface FlowSpace { slug: string; name: string; watch: boolean; write: boolean }

/** A flow as the app shows it. */
export interface FlowView extends StoredFlow { spaces: FlowSpace[] }

/** `GET /api/flows`. */
export interface FlowList {
  flows: FlowView[];
  /**
   * The spaces the caller owns: those a flow they edit may watch or copy into. `a3doc`: what
   * arrives there goes on to a3doc, which can't delete it, so a copy there deserves a wait first.
   */
  spaces: { slug: string; name: string; a3doc: boolean }[];
}

/** `PUT /api/flows`. */
export interface FlowSave { id?: string; name: string; enabled: boolean; graph: FlowGraph }

/** One document a flow would act on now. */
export interface PreviewMatch {
  space: string;
  fileId: string; name: string; folderPath: string;
  category: string | null;
  /** It reaches an action only on some answer to a model question, asked when the flow runs. */
  needsAnswer: boolean;
  /** A saved flow already acted on it (or it is waiting for approval): running again skips it. */
  handled: boolean;
}

/** `POST /api/flows/preview`, with `{ id?, graph }`. Never calls a model. */
export interface FlowPreview {
  /** The first matches, space by space in file order. */
  matches: PreviewMatch[];
  /** All the documents that reach an action, `uncertain` of them only on a model's answer. */
  matched: number;
  uncertain: number;
  /** By node id: how many documents surely reach it, and how many maybe (on a model's answer). */
  reach: Record<string, number>;
  maybe: Record<string, number>;
  /** Documents looked at, and whether the watched spaces hold more than a preview reads. */
  scanned: number;
  truncated: boolean;
}

/** A delivery as the app lists it: in which space the document is, and which flow it was. */
export interface DeliveryView extends FlowDelivery { space: string; flowName: string }

/** `POST /api/flow-deliveries/decide`. */
export interface DeliveryDecision { space: string; flowId: string; fileId: string; versionId: string; decision: 'approve' | 'dismiss' | 'retry' }

/**
 * What a delivery's `detail` holds once a graph flow wrote it: the path the document took, the
 * model's answers, and what each action did (by node id). `at` is the wait it is paused at.
 */
export interface DeliveryDetail {
  path?: string[];
  answers?: Record<string, boolean>;
  done?: Record<string, Record<string, unknown>>;
  at?: string;
  approved?: boolean;
  error?: string;
  reason?: string;
}
