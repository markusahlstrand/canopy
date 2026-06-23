import { Suspense, lazy } from "react";
import type { FileViewProps } from "@canopy/plugin-sdk";
import { Icon } from "@canopy/ui";
import { isArazzo, isAsyncApi, isTsp } from "./spec/discover";

// Both canvases are heavy (React Flow + parsers), so keep each in its own lazy chunk
// and only pull in the one the opened file needs.
const PrismaFileViewer = lazy(() => import("./file-viewer").then((m) => ({ default: m.ModelEditorFileViewer })));
const SpecFileViewer = lazy(() => import("./spec/spec-file-viewer").then((m) => ({ default: m.SpecFileViewer })));

const Spinner = () => (
  <div className="grid h-full min-h-[200px] place-items-center text-muted-foreground">
    <Icon name="refresh" size={20} className="animate-spin" />
  </div>
);

/**
 * Dispatches a file the Model Editor plugin claims to the right canvas by extension:
 * `.tsp`/`.arazzo`/`.asyncapi` open the spec editor (TypeSpec + Arazzo + AsyncAPI with
 * cross-layer links), everything else (`.prisma`) opens the Prisma model editor.
 */
export function ModelEditorFileRouter(props: FileViewProps) {
  const spec = isTsp(props.fileName) || isArazzo(props.fileName) || isAsyncApi(props.fileName);
  return (
    <Suspense fallback={<Spinner />}>{spec ? <SpecFileViewer {...props} /> : <PrismaFileViewer {...props} />}</Suspense>
  );
}
