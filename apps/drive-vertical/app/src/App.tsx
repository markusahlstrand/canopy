/**
 * The drive's own front end — one scope, one space, one folder at a time.
 *
 * Scope-shaped on purpose: this app never names a space, because the hostname
 * already did. The platform router resolved it to a scope before the worker saw
 * the request, so there is no space picker here and no space id in any URL. That
 * is the difference between this and the portal, which is the multi-space host.
 *
 * It renders with `@canopy/ui` — the same shadcn/radix primitives and the same
 * Canopy tokens the portal and the trusted plugins use — so the vertical looks
 * like Canopy without depending on the portal.
 *
 * What it deliberately does NOT do: upload bytes. A write is three hops
 * (ensure-file → put the bytes → record-version) and the middle one is still
 * landing, so the button that would pretend otherwise is not here.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Icon, cn } from '@canopy/ui';
import {
  ApiError,
  LOGIN_URL,
  LOGOUT_URL,
  ROOT_FOLDER_ID,
  claimOwner,
  createFolder,
  ensureFile,
  fileVersions,
  listFolder,
  whoami,
  type DriveFile,
  type FileVersion,
} from './api';

/** Nobody is signed in yet, somebody is, or we have not asked. */
type Session = { state: 'loading' } | { state: 'out' } | { state: 'in'; principal: string };

export default function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Boot: redeem an owner-claim link if this page was opened as one, then ask who we are.
   *
   * Order matters. Until the seat is bound, `whoami` is exactly the 401 the claim exists
   * to fix, so asking first renders the signed-out shell and its Sign in button — which
   * is the loop this closes: sign in, resolve to nobody, get offered the button again.
   *
   * A claim needs a session (it binds whoever is signed in), so a 401 from it means "not
   * signed in yet" rather than "bad token" — send them through login still carrying the
   * token and they land back on this effect with a session. The token stays in the URL
   * for exactly that hop and is stripped on every other path: it is live until consumed,
   * and an address bar is the easiest place to leak one from.
   */
  useEffect(() => {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('claim');

    const strip = () => {
      url.searchParams.delete('claim');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    };

    const boot = async () => {
      if (token) {
        try {
          await claimOwner(token);
          strip();
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) {
            window.location.assign(`${LOGIN_URL}?returnTo=${encodeURIComponent(`/?claim=${token}`)}`);
            return null;
          }
          // A dead link is worth SAYING — the person followed one the dashboard told them
          // to open. Strip it anyway, because retrying the same dead token on every
          // reload only makes the app look broken, and fall through to `whoami`: the seat
          // may have been claimed from another tab, and that is the call which knows.
          strip();
          setError(e instanceof ApiError ? e.message : String(e));
        }
      }
      return whoami();
    };

    boot()
      .then((me) => {
        if (me) setSession({ state: 'in', principal: me.principal });
      })
      // A 401 is the logged-out state, not a failure — anything else is.
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) return setSession({ state: 'out' });
        setSession({ state: 'out' });
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  const refresh = useCallback(() => {
    listFolder(ROOT_FOLDER_ID)
      .then(setFiles)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (session.state === 'in') refresh();
  }, [session.state, refresh]);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
          <Icon name="my-drive" className="size-5 text-primary" />
          <h1 className="text-base font-semibold">Canopy Drive</h1>
          <div className="ml-auto flex items-center gap-2">
            {session.state === 'in' ? (
              <>
                <span className="hidden text-sm text-muted-foreground sm:inline">{session.principal}</span>
                <Button variant="outline" size="sm" asChild>
                  <a href={LOGOUT_URL}>Sign out</a>
                </Button>
              </>
            ) : session.state === 'out' ? (
              <Button size="sm" asChild>
                <a href={LOGIN_URL}>Sign in</a>
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8">
        {error ? (
          <p className="mb-6 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {session.state === 'loading' ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : session.state === 'out' ? (
          <SignedOut />
        ) : (
          <Browser files={files} onChanged={refresh} onError={setError} />
        )}
      </main>
    </div>
  );
}

/**
 * The logged-out shell. It says what this install is rather than only offering a
 * button, because a fresh vertical with no issuer configured lands here and the
 * reason it cannot sign anyone in is worth stating.
 */
function SignedOut() {
  return (
    <div className="rounded-lg border border-border p-8 text-center">
      <Icon name="key-round" className="mx-auto mb-3 size-6 text-muted-foreground" />
      <h2 className="mb-1 text-lg font-medium">Sign in to this space</h2>
      <p className="mx-auto mb-5 max-w-sm text-sm text-muted-foreground">
        This drive is one space, and the hostname already chose it. Signing in maps you to a
        principal inside it.
      </p>
      <Button asChild>
        <a href={LOGIN_URL}>Sign in</a>
      </Button>
    </div>
  );
}

function Browser({
  files,
  onChanged,
  onError,
}: {
  files: DriveFile[] | null;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [creating, setCreating] = useState<null | 'folder' | 'file'>(null);
  const [versionsOf, setVersionsOf] = useState<DriveFile | null>(null);

  return (
    <>
      <div className="mb-4 flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">Root folder</h2>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setCreating('folder')}>
            <Icon name="folder" className="size-4" /> New folder
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCreating('file')}>
            <Icon name="plus" className="size-4" /> New file
          </Button>
        </div>
      </div>

      {files === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : files.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <p className="text-sm text-muted-foreground">This folder is empty.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-4 py-3">
              <Icon name="file-text" className="size-4 shrink-0 text-muted-foreground" />
              <span className={cn('truncate text-sm', f.deleted_at && 'line-through opacity-60')}>{f.name}</span>
              <time className="ml-auto shrink-0 text-xs text-muted-foreground" dateTime={f.updated_at}>
                {new Date(f.updated_at).toLocaleDateString()}
              </time>
              <Button variant="ghost" size="sm" onClick={() => setVersionsOf(f)}>
                Versions
              </Button>
            </li>
          ))}
        </ul>
      )}

      <NameDialog
        kind={creating}
        onClose={() => setCreating(null)}
        onSubmit={async (name) => {
          try {
            if (creating === 'folder') await createFolder(ROOT_FOLDER_ID, name);
            else await ensureFile(ROOT_FOLDER_ID, name);
            setCreating(null);
            onChanged();
          } catch (e) {
            onError(e instanceof Error ? e.message : String(e));
          }
        }}
      />
      <VersionsDialog file={versionsOf} onClose={() => setVersionsOf(null)} onError={onError} />
    </>
  );
}

/**
 * One dialog for both creates. The two operations differ only in which endpoint
 * takes the name, and a second near-identical component would be the kind of
 * duplication that drifts.
 */
function NameDialog({
  kind,
  onClose,
  onSubmit,
}: {
  kind: null | 'folder' | 'file';
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState('');
  useEffect(() => {
    if (kind) setName('');
  }, [kind]);

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{kind === 'folder' ? 'New folder' : 'New file'}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onSubmit(name.trim());
          }}
          className="flex gap-2"
        >
          {/* One path segment, never a path — the same rule `segment` enforces
              server-side, which is what actually refuses a name containing `/`. */}
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
          <Button type="submit" disabled={!name.trim()}>
            Create
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function VersionsDialog({
  file,
  onClose,
  onError,
}: {
  file: DriveFile | null;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [versions, setVersions] = useState<FileVersion[] | null>(null);

  useEffect(() => {
    if (!file) return setVersions(null);
    setVersions(null);
    fileVersions(file.id)
      .then(setVersions)
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  }, [file, onError]);

  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{file?.name}</DialogTitle>
        </DialogHeader>
        {versions === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No versions yet — the file row exists, but nothing has been written to it.
          </p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between py-2">
                <span className="font-mono text-xs">{v.id}</span>
                <time className="text-xs text-muted-foreground" dateTime={v.created_at}>
                  {new Date(v.created_at).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
