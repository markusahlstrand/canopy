import "@typespec/http";
import "@typespec/openapi";
import "./models.tsp";

using TypeSpec.Http;
using TypeSpec.OpenAPI;

/**
 * Canopy — an extensible, plugin-driven portal. This contract covers the
 * fundamentals of the drive HTTP API: spaces, files (with versions), the
 * content-addressed upload flow, and full-text search. It is intentionally
 * partial — connectors, sharing, comments, plugins, MCP and AI endpoints are
 * out of scope here.
 *
 * All endpoints are bearer-authenticated unless noted; the personal space is
 * implied when no `space` query is given.
 */
@service(#{ title: "Canopy Drive" })
@server("/", "The Canopy API, mounted under /api by the worker.")
@useAuth(BearerAuth)
namespace Canopy;

@route("/api/spaces")
interface Spaces {
  /** List the spaces the caller can read (personal, group, and connected). */
  @get
  @operationId("listSpaces")
  list(): Space[] | Error;

  /** Create a shared (group) space. */
  @post
  @operationId("createSpace")
  create(@body space: CreateSpace): {
    @statusCode statusCode: 201;
    @body created: Space;
  } | Error;

  /** Rename a space. Owner only. */
  @patch
  @operationId("renameSpace")
  rename(@path id: string, @body body: { name?: string }): Space | Error;

  /** Delete a space. Owner only. */
  @delete
  @operationId("deleteSpace")
  delete(@path id: string): void | Error;
}

@route("/api/files")
interface Files {
  /**
   * List one folder of a space. Defaults to the personal space root; pass
   * `space` and/or `path` to target a folder, or `trash`/`shared` to switch view.
   */
  @get
  @operationId("listFiles")
  list(
    @query space?: string,
    @query path?: string,
    @query trash?: boolean,
    @query shared?: boolean,
  ): Listing | Error;

  /**
   * Create a file record plus its first version. The blob must already be
   * prepared and uploaded (see `prepareUpload` / `commitUpload`).
   */
  @post
  @operationId("createFile")
  create(@query space?: string, @body file: CreateFile): {
    @statusCode statusCode: 201;
    @body created: File;
  } | Error;

  /** Fetch a single file (joined with its current version) for display. */
  @get
  @operationId("getFile")
  get(@path id: string): File | Error;

  /** Download the current version's bytes. */
  @get
  @route("/{id}/content")
  @operationId("getFileContent")
  content(@path id: string): {
    @header contentType: string;
    @body bytes: bytes;
  } | Error;

  /** Patch a file's freeform metadata (e.g. move it by changing `path`). */
  @patch
  @route("/{id}/metadata")
  @operationId("updateFileMetadata")
  updateMetadata(@path id: string, @body metadata: Record<unknown>): File | Error;

  /** List a file's version history. */
  @get
  @route("/{id}/versions")
  @operationId("listVersions")
  versions(@path id: string): FileVersion[] | Error;

  /** Move a file to the trash (soft delete). */
  @delete
  @operationId("deleteFile")
  delete(@path id: string): void | Error;

  /** Restore a trashed file. */
  @post
  @route("/{id}/restore")
  @operationId("restoreFile")
  restore(@path id: string): File | Error;
}

@route("/api/uploads")
interface Uploads {
  /**
   * Reserve an upload for content-addressed bytes. If a blob with this hash
   * already exists, the response says so and the PUT can be skipped.
   */
  @post
  @route("/prepare")
  @operationId("prepareUpload")
  prepare(@query space?: string, @body body: PrepareUpload): UploadTicket | Error;

  /**
   * Stream the bytes for a prepared upload. `token` is the claimed SHA-256,
   * re-verified server-side.
   */
  @put
  @route("/{token}")
  @operationId("commitUpload")
  commit(@path token: string, @body bytes: bytes): {
    @statusCode statusCode: 201;
    @body committed: CommittedBlob;
  } | Error;
}

@route("/api")
interface Drive {
  /** Full-text search across the files the caller can read. Empty `q` → no hits. */
  @get
  @route("/search")
  @operationId("search")
  search(@query q: string, @query limit?: int32, @query cursor?: string): SearchResults | Error;

  /** Lightweight stats (file count + bytes used) for a space. */
  @get
  @route("/overview")
  @operationId("getOverview")
  overview(@query space?: string): Overview | Error;
}
