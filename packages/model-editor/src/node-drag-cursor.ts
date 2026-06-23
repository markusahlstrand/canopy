// Pins the document cursor to `grabbing` for the duration of a node drag, so it
// doesn't flicker to the arrow/pointer when the pointer outpaces the dragged node
// (the matching CSS lives in model-editor.css). Pass these straight to a ReactFlow's
// `onNodeDragStart` / `onNodeDragStop`; their identities are stable across renders.
const CLASS = "canopy-node-dragging";

export const onNodeDragStart = (): void => {
  document.body.classList.add(CLASS);
};

export const onNodeDragStop = (): void => {
  document.body.classList.remove(CLASS);
};
