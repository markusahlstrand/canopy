import { useEffect, useState } from "react";
import { fetchFileText, saveFileVersion } from "@/lib/api";
import { Icon } from "@/lib/icons";
import { ModelEditorView } from "./model-editor-view";

/**
 * Bridges a stored .prisma file to the Model Editor: loads its text, then renders
 * the editor in file-bound mode. Saving serialises the canvas back to Prisma.
 */
export function ModelEditorFileViewer({
  fileId,
  fileName,
  onSaved,
}: {
  fileId: string;
  fileName: string;
  onSaved?: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setContent(null);
    setError(null);
    fetchFileText(fileId)
      .then((t) => alive && setContent(t))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "Failed to load"));
    return () => {
      alive = false;
    };
  }, [fileId]);

  if (error) {
    return (
      <div className="grid h-full min-h-[200px] place-items-center text-sm text-muted-foreground">
        Couldn't load this file: {error}
      </div>
    );
  }
  if (content === null) {
    return (
      <div className="grid h-full min-h-[200px] place-items-center text-muted-foreground">
        <Icon name="refresh" size={20} className="animate-spin" />
      </div>
    );
  }

  return (
    <ModelEditorView
      file={{
        name: fileName,
        content,
        onSave: async (prisma) => {
          await saveFileVersion(fileId, prisma, "text/x-prisma");
          onSaved?.();
        },
      }}
    />
  );
}
