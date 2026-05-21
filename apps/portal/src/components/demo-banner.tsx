import type { Me } from "@/lib/api";

/**
 * Thin banner shown when auth is configured but no one is signed in — i.e. the
 * public demo. Hidden once logged in (and when auth isn't configured at all).
 */
export function DemoBanner({ auth, onSignIn }: { auth: Me; onSignIn: () => void }) {
  if (!auth.authConfigured || auth.user) return null;
  return (
    <div className="flex shrink-0 items-center justify-center gap-1.5 border-b bg-primary/10 px-4 py-1.5 text-center text-[13px] text-foreground">
      <span>You're viewing a demo.</span>
      <button onClick={onSignIn} className="font-medium text-primary underline-offset-2 hover:underline">
        Log in
      </button>
      <span className="text-muted-foreground">to use your own files.</span>
    </div>
  );
}
