import { Component, type ErrorInfo, type ReactNode } from "react";
import { isStandalone, platformInfo } from "@/lib/platform";

/**
 * Top-level crash guard. Without it, any uncaught render error — or a rejected
 * `lazy()` chunk import (e.g. a stale service-worker cache after a deploy, or a
 * network blip while the viewport swaps the desktop/mobile tree on rotate) —
 * unmounts the whole React tree and leaves a blank white page. This catches it,
 * shows a recoverable fallback, and surfaces the message instead.
 */
interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the message + display mode for diagnosis. If a blank only happens in
    // standalone (home-screen) mode, that points at the offline lazy-chunk theory.
    console.error("App crashed:", error, platformInfo(), info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    const isChunkError = /loading chunk|dynamically imported module|failed to fetch/i.test(this.state.error.message);
    return (
      <div className="grid h-screen place-items-center bg-background p-6 text-center">
        <div className="flex max-w-sm flex-col items-center gap-3">
          <div className="text-[15px] font-semibold">Something went wrong</div>
          <p className="text-[13px] text-muted-foreground">
            {isChunkError
              ? "Couldn't load part of the app — this can happen after an update. Reloading should fix it."
              : "The view hit an unexpected error."}
          </p>
          <div className="mt-1 flex gap-2">
            <button
              onClick={() => window.location.reload()}
              className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:opacity-90"
            >
              Reload
            </button>
            <button
              onClick={this.reset}
              className="rounded-md border px-3 py-1.5 text-[13px] font-medium hover:bg-accent"
            >
              Try again
            </button>
          </div>
          <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground/70">
            {this.state.error.message}
            {"\n"}
            {isStandalone() ? "(home-screen / standalone)" : "(browser tab)"}
          </pre>
        </div>
      </div>
    );
  }
}
