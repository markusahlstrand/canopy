import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Icon } from "@/lib/icons";
import { acceptPendingInvites, listPendingInvites, type Me, type PendingInvite } from "@/lib/api";

/**
 * Thin banner shown to a signed-in user who has unclaimed email invites — i.e. a
 * space was shared with their address after their last login (login resolves
 * invites automatically; this surfaces the in-session gap). Accepting joins them
 * to every pending space; `onAccepted` lets the shell refresh its space list.
 */
export function InviteBanner({ auth, onAccepted }: { auth: Me; onAccepted: () => void }) {
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!auth.user) return; // signed out → nothing to fetch (render returns null below)
    let cancelled = false;
    listPendingInvites()
      .then((p) => !cancelled && setInvites(p))
      .catch(() => !cancelled && setInvites([]));
    return () => {
      cancelled = true;
    };
  }, [auth.user]);

  if (!auth.user || dismissed || invites.length === 0) return null;

  const first = invites[0]!;
  const extra = invites.length - 1;
  const label =
    extra > 0
      ? `You've been invited to “${first.spaceName}” and ${extra} other space${extra === 1 ? "" : "s"}.`
      : `You've been invited to “${first.spaceName}” as ${first.role}.`;

  async function accept() {
    setBusy(true);
    try {
      const { accepted } = await acceptPendingInvites();
      if (accepted === 0) {
        // Verified-email gate didn't pass (e.g. a session predating the fix).
        toast("Couldn't confirm your invite", { description: "Try signing out and back in." });
        setBusy(false);
        return;
      }
      setInvites([]);
      onAccepted();
      toast(`Joined ${accepted} space${accepted === 1 ? "" : "s"}`, {
        description: extra > 0 ? "They're now in your drive." : `“${first.spaceName}” is now in your drive.`,
      });
    } catch (e) {
      toast("Couldn't accept invite", { description: (e as Error).message });
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 items-center justify-center gap-2 border-b bg-primary/10 px-4 py-1.5 text-center text-[13px] text-foreground">
      <Icon name="users" size={14} className="text-primary" />
      <span>{label}</span>
      <button
        onClick={() => void accept()}
        disabled={busy}
        className="font-medium text-primary underline-offset-2 hover:underline disabled:opacity-60"
      >
        {busy ? "Joining…" : invites.length > 1 ? "Accept all" : "Accept"}
      </button>
      <button
        onClick={() => setDismissed(true)}
        className="text-muted-foreground underline-offset-2 hover:underline"
      >
        Dismiss
      </button>
    </div>
  );
}
