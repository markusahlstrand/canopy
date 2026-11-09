import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, act, screen } from '@testing-library/react';
import { clampPreviewWidth, PreviewResizeHandle, PREVIEW_DEFAULT_WIDTH, PREVIEW_MIN_WIDTH, PREVIEW_WIDTH_VAR, usePreviewWidth } from './preview-resize';

beforeEach(() => { localStorage.clear(); vi.stubGlobal('innerWidth', 1400); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const pointer = (target: EventTarget, type: string, clientX: number, button = 0) =>
  act(() => { target.dispatchEvent(new MouseEvent(type, { clientX, button, bubbles: true })); });

function setup(width = 500) {
  const onChange = vi.fn();
  const { container } = render(<div data-testid="pane"><PreviewResizeHandle width={width} onChange={onChange} /></div>);
  return { onChange, container, handle: screen.getByRole('separator', { name: 'Resize preview' }), pane: screen.getByTestId('pane') };
}
const applied = (pane: HTMLElement) => pane.style.getPropertyValue(PREVIEW_WIDTH_VAR);

it('widens when the border is dragged left, and reports once, on release', () => {
  const { handle, pane, onChange } = setup();
  pointer(handle, 'pointerdown', 900);
  pointer(window, 'pointermove', 800);
  expect(applied(pane)).toBe('600px');
  pointer(window, 'pointermove', 850);
  expect(applied(pane)).toBe('550px');
  expect(onChange).not.toHaveBeenCalled();
  pointer(window, 'pointerup', 850);
  expect(onChange.mock.calls).toEqual([[550]]);
  pointer(window, 'pointermove', 100);
  expect(applied(pane)).toBe('550px');
});

it('stops at the minimum and leaves room for the list', () => {
  const { handle, pane } = setup();
  pointer(handle, 'pointerdown', 900);
  pointer(window, 'pointermove', 1390);
  expect(applied(pane)).toBe(`${PREVIEW_MIN_WIDTH}px`);
  pointer(window, 'pointermove', 0);
  expect(applied(pane)).toBe('840px');
});

it('covers iframes during a drag, ignores other buttons, and restores the width on cancel', () => {
  const { handle, pane, onChange, container } = setup();
  pointer(handle, 'pointerdown', 900, 2);
  expect(container.querySelector('.fixed.inset-0')).toBeNull();
  pointer(handle, 'pointerdown', 900);
  expect(container.querySelector('.fixed.inset-0')).not.toBeNull();
  pointer(window, 'pointermove', 800);
  pointer(window, 'pointercancel', 800);
  expect(applied(pane)).toBe('500px');
  expect(onChange).not.toHaveBeenCalled();
  expect(container.querySelector('.fixed.inset-0')).toBeNull();
});

it('resizes from the keyboard and resets on double-click', () => {
  const { handle, onChange } = setup();
  fireEvent.keyDown(handle, { key: 'ArrowLeft' });
  fireEvent.keyDown(handle, { key: 'ArrowRight' });
  fireEvent.keyDown(handle, { key: 'Home' });
  fireEvent.doubleClick(handle);
  expect(onChange.mock.calls.flat()).toEqual([532, 468, PREVIEW_DEFAULT_WIDTH, PREVIEW_DEFAULT_WIDTH]);
});

it('clamps a remembered width to a smaller window', () => {
  expect(clampPreviewWidth(5000, 1000)).toBe(440);
  expect(clampPreviewWidth(5000, 700)).toBe(PREVIEW_MIN_WIDTH);
});

it('remembers the width, and ignores a stored value it cannot read', () => {
  const first = renderHook(() => usePreviewWidth());
  expect(first.result.current[0]).toBe(PREVIEW_DEFAULT_WIDTH);
  act(() => first.result.current[1](600));
  expect(renderHook(() => usePreviewWidth()).result.current[0]).toBe(600);
  localStorage.setItem('canopy.previewWidth', 'wide');
  expect(renderHook(() => usePreviewWidth()).result.current[0]).toBe(PREVIEW_DEFAULT_WIDTH);
});
