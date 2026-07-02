import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import {
  ChangesQuery,
  ChangesResponse,
  ChunkParams,
  ChunkUploadResponse,
  CommitRequest,
  CommitResponse,
  DeviceAuthHeaders,
  DeviceEnrollmentRequest,
  DeviceEnrollmentResponse,
  FullIndexResponse,
  PrepareRequest,
  PrepareResponse,
  RevokeDeviceRequest,
  RevokeDeviceResponse,
  SyncRequestHeaders,
} from "./index";

export const SyncApi = HttpApi.make("ObsidianCfSyncApi").add(
  HttpApiGroup.make("sync", { topLevel: true }).add(
    HttpApiEndpoint.post("prepare", "/sync/prepare", {
      headers: DeviceAuthHeaders,
      payload: PrepareRequest,
      success: PrepareResponse,
    }),
    HttpApiEndpoint.post("commit", "/sync/commit", {
      headers: DeviceAuthHeaders,
      payload: CommitRequest,
      success: CommitResponse,
    }),
    HttpApiEndpoint.get("changes", "/sync/changes", {
      headers: DeviceAuthHeaders,
      query: ChangesQuery,
      success: ChangesResponse,
    }),
    HttpApiEndpoint.get("index", "/sync/index", {
      headers: DeviceAuthHeaders,
      success: FullIndexResponse,
    }),
    HttpApiEndpoint.put("uploadChunk", "/sync/chunk/:hash", {
      headers: DeviceAuthHeaders,
      params: ChunkParams,
      success: ChunkUploadResponse,
    }),
    HttpApiEndpoint.post("enrollDevice", "/devices/enroll", {
      headers: SyncRequestHeaders,
      payload: DeviceEnrollmentRequest,
      success: DeviceEnrollmentResponse,
    }),
    HttpApiEndpoint.post("revokeDevice", "/devices/revoke", {
      headers: SyncRequestHeaders,
      payload: RevokeDeviceRequest,
      success: RevokeDeviceResponse,
    }),
  ),
);
