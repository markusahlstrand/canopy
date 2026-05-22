import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/icons";
import { acceptInvite, fetchMe, getInvite, loginUrl, logout, type InviteInfo, type Me } from "@/lib/api";

function readInviteToken(): string | null {
  return new URLSearchParams(window.location.search).get("invite");
}

const INVALID_COPY: Record<string, string> = {
  used: "This invite link has already been used. Ask whoever shared it for a fresh one.",
  expired: "This invite link has expired. Ask whoever shared it for a new one.",
  not_found: "This invite link is invalid. Double-check the URL, or ask for a new one.",
};

/**
 * When the URL carries `?invite=<token>`, prompt the visitor to accept it. Lives
 * above the mobile/desktop split so it works in either shell. Accepting does a
 * full navigation into the space, so the shell reloads cleanly into it.
 */
export function InviteGate() {
  const [token] = useState<string | null>(readInviteToken);
  const [me, setMe] = useState<Me | null>(null);
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    void fetchMe().then(setMe);
    void getInvite(token)
      .then(setInfo)
      .catch(() => setInfo({ status: "not_found" }));
  }, [token]);

  if (!token || dismissed) return null;

  function close() {
    const p = new URLSearchParams(window.location.search);
    p.delete("invite");
    const qs = p.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    setDismissed(true);
  }

  function signIn() {
    // returnTo keeps the ?invite= param, so we land back here signed in.
    window.location.href = loginUrl(window.location.pathname + window.location.search);
  }

  async function switchAccount() {
    await logout();
    signIn();
  }

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const { spaceId } = await acceptInvite(token!);
      // Full navigation so either shell loads fresh into the joined space.
      window.location.assign(`/?space=${encodeURIComponent(spaceId)}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const loading = !me || !info;
  const signedIn = !!me?.user;
  // With auth unconfigured (dev/demo) there's no sign-in step — accept as the demo user.
  const canAccept = signedIn || (me ? !me.authConfigured : false);

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-[420px]">
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading invite…</div>
        ) : info!.status !== "valid" ? (
          <>
            <DialogHeader>
              <DialogTitle>Invite unavailable</DialogTitle>
              <DialogDescription>{INVALID_COPY[info!.status] ?? INVALID_COPY.not_found}</DialogDescription>
            </DialogHeader>
            <div className="flex justify-end">
              <Button onClick={close}>Continue to Canopy</Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <div className="mb-1 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Icon name="users" size={22} />
              </div>
              <DialogTitle className="truncate">Join “{info!.spaceName}”</DialogTitle>
              <DialogDescription>
                You've been invited to this shared space as <span className="font-medium capitalize">{info!.role}</span>.
              </DialogDescription>
            </DialogHeader>

            {error && <p className="text-[12.5px] text-destructive">{error}</p>}

            {canAccept ? (
              <div className="flex flex-col gap-2">
                {signedIn && (
                  <p className="text-[12.5px] text-muted-foreground">
                    Joining as <span className="font-medium">{me!.user!.email ?? me!.user!.name ?? me!.user!.sub}</span>.
                  </p>
                )}
                <div className="flex items-center justify-end gap-2">
                  {signedIn && (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void switchAccount()}>
                      Use a different account
                    </Button>
                  )}
                  <Button disabled={busy} onClick={() => void accept()}>
                    {busy ? "Joining…" : "Accept invite"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-[12.5px] text-muted-foreground">
                  Sign in to accept — you choose which account to join with.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={close}>
                    Not now
                  </Button>
                  <Button onClick={signIn}>Sign in to accept</Button>
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
