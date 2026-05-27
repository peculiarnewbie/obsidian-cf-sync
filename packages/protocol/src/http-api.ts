import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  ChangesQuery,
  ChangesResponse,
  ChunkParams,
  ChunkUploadResponse,
  CommitRequest,
  CommitResponse,
  FullIndexResponse,
  PrepareRequest,
  PrepareResponse,
  SyncRequestHeaders,
} from "./index";

export const SyncApi = HttpApi.make("ObsidianCfSyncApi").add(
  HttpApiGroup.make("sync", { topLevel: true }).add(
    HttpApiEndpoint.post("prepare", "/sync/prepare", {
      headers: SyncRequestHeaders,
      payload: PrepareRequest,
      success: PrepareResponse,
    }),
    HttpApiEndpoint.post("commit", "/sync/commit", {
      headers: SyncRequestHeaders,
      payload: CommitRequest,
      success: CommitResponse,
    }),
    HttpApiEndpoint.get("changes", "/sync/changes", {
      headers: SyncRequestHeaders,
      query: ChangesQuery,
      success: ChangesResponse,
    }),
    HttpApiEndpoint.get("index", "/sync/index", {
      headers: SyncRequestHeaders,
      success: FullIndexResponse,
    }),
    HttpApiEndpoint.put("uploadChunk", "/sync/chunk/:hash", {
      headers: SyncRequestHeaders,
      params: ChunkParams,
      success: ChunkUploadResponse,
    }),
  ),
);
