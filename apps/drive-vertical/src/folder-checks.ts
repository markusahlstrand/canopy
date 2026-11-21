import type { ConnectorDefinition } from '@substrat-run/vertical-host/connectors';
import type { ScopedConnectionContext } from '@substrat-run/kernel';

/**
 * The folder-check capability, as a connector offers it: read each path's own children from the
 * source again and land what was added, changed or removed, all in one call. Paths are the space's
 * (`''` is the bound folder). A check answers per folder; a throw means the call itself failed (a
 * login a3doc refused, MFA wanted), and is every folder's answer.
 */
export type FolderChecks = (ctx: ScopedConnectionContext, paths: string[]) => Promise<{ path: string; changes: number; error?: string }[]>;

/** The drive operations the capability is wired through; see `@canopy/scope-drive` `folder-refresh.ts`. */
export const FOLDER_REQUESTS_OPERATION = 'drive/source-folder-requests';
export const FOLDER_CHECKED_OPERATION = 'drive/source-folder-checked';
/** Folders one call checks: each costs a listing or a few, and the call has 100 outbound uses. */
export const FOLDERS_PER_CALL = 3;

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500) || 'The source gave no reason.';

/**
 * A connector whose sweep first answers the folders people opened. The drive records each
 * request; the sweep takes a few, checks them with `check`, and tells the drive how each went (so
 * the folder shows "Checked just now", or the source's reason). With nothing asked, or a drive too
 * old to ask, it is the connector's ordinary sweep. After a check the sweep says there is `more`,
 * so the ordinary pass carries on in the next call, exactly where it was.
 */
export function withFolderChecks(definition: ConnectorDefinition, check: FolderChecks): ConnectorDefinition {
  const sweep = definition.sweep;
  if (!sweep) return definition;
  const wrapped: ConnectorDefinition = {
    ...definition,
    sweep: async (ctx) => {
      const asked = await ctx.invoke<{ folders: { folderId: string; path: string }[] }>(FOLDER_REQUESTS_OPERATION, { limit: FOLDERS_PER_CALL })
        .then((r) => r.folders, () => []);
      if (!asked.length) return sweep(ctx);
      const tell = (folderId: string, changes: number, error: string | null) =>
        ctx.invoke(FOLDER_CHECKED_OPERATION, { folderId, changes, error }).catch(() => undefined);
      let checks: Awaited<ReturnType<FolderChecks>>;
      try {
        checks = await check(ctx, asked.map((f) => f.path));
      } catch (error) {
        for (const f of asked) await tell(f.folderId, 0, reason(error));
        throw error;
      }
      let landed = 0;
      for (const f of asked) {
        const found = checks.find((r) => r.path === f.path);
        landed += found?.changes ?? 0;
        await tell(f.folderId, found?.changes ?? 0, found?.error ? reason(found.error) : null);
      }
      // Every folder failed the same way: the call failed, and the platform should record it so.
      const errors = checks.filter((r) => r.error);
      if (errors.length && errors.length === checks.length && landed === 0) throw new Error(errors[0]!.error);
      return { landed, more: true };
    },
  };
  checking.add(wrapped);
  return wrapped;
}

/** The definitions `withFolderChecks` made: their sweeps answer folder requests themselves. */
const checking = new WeakSet<ConnectorDefinition>();

/**
 * Whether a connector answers folder requests itself. The worker needs this after a poll: for such
 * a connector, a request no sweep took is still waiting (a sweep takes only {@link FOLDERS_PER_CALL}),
 * and must never be recorded as checked just because the poll succeeded.
 */
export const hasFolderChecks = (definition: ConnectorDefinition | undefined) => !!definition && checking.has(definition);
