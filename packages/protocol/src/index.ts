import * as Schema from "effect/Schema";

export { Schema };

export const VaultId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/)).pipe(
  Schema.brand("VaultId"),
);
export type VaultId = Schema.Schema.Type<typeof VaultId>;

export const DeviceId = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("DeviceId"));
export type DeviceId = Schema.Schema.Type<typeof DeviceId>;

export const OpId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)).pipe(
  Schema.brand("OpId"),
);
export type OpId = Schema.Schema.Type<typeof OpId>;

export const FilePath = Schema.String.pipe(
  Schema.refine(
    (path: unknown): path is string =>
      typeof path === "string" &&
      path.length > 0 &&
      !path.startsWith("/") &&
      !path.includes("..") &&
      !Array.from(path).some((char) => char.charCodeAt(0) < 32),
  ),
  Schema.brand("FilePath"),
);
export type FilePath = Schema.Schema.Type<typeof FilePath>;

export const ChunkHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand("ChunkHash"),
);
export type ChunkHash = Schema.Schema.Type<typeof ChunkHash>;

export const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const Mtime = NonNegativeInteger.pipe(Schema.brand("Mtime"));
export type Mtime = Schema.Schema.Type<typeof Mtime>;

export const ByteSize = NonNegativeInteger.pipe(Schema.brand("ByteSize"));
export type ByteSize = Schema.Schema.Type<typeof ByteSize>;

export const FileVersion = NonNegativeInteger.pipe(Schema.brand("FileVersion"));
export type FileVersion = Schema.Schema.Type<typeof FileVersion>;

export const GlobalVersion = NonNegativeInteger.pipe(Schema.brand("GlobalVersion"));
export type GlobalVersion = Schema.Schema.Type<typeof GlobalVersion>;

export const SyncAction = Schema.Literals(["put", "delete"]);
export type SyncAction = Schema.Schema.Type<typeof SyncAction>;

export const SyncRequestHeaders = Schema.Struct({
  "x-vault-id": VaultId,
});
export type SyncRequestHeaders = Schema.Schema.Type<typeof SyncRequestHeaders>;

export const DeviceAuthHeaders = Schema.Struct({
  "x-vault-id": VaultId,
  "x-device-id": DeviceId,
});
export type DeviceAuthHeaders = Schema.Schema.Type<typeof DeviceAuthHeaders>;

export const ChangesQuery = Schema.Struct({
  since: Schema.NumberFromString.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ChangesQuery = Schema.Schema.Type<typeof ChangesQuery>;

export const ChunkParams = Schema.Struct({
  hash: ChunkHash,
});
export type ChunkParams = Schema.Schema.Type<typeof ChunkParams>;

export const EmptyChunkList = Schema.Array(ChunkHash).check(Schema.isLengthBetween(0, 0));

export const PutFileRequest = Schema.Struct({
  opId: OpId,
  action: Schema.Literal("put"),
  file: FilePath,
  chunks: Schema.Array(ChunkHash),
  mtime: Mtime,
  size: ByteSize,
  baseFileVersion: FileVersion,
  deviceId: DeviceId,
});

export const DeleteFileRequest = Schema.Struct({
  opId: OpId,
  action: Schema.Literal("delete"),
  file: FilePath,
  chunks: EmptyChunkList,
  mtime: Mtime,
  size: Schema.Literal(0),
  baseFileVersion: FileVersion,
  deviceId: DeviceId,
});

export const PrepareRequest = Schema.Union([PutFileRequest, DeleteFileRequest]);
export type PrepareRequest = Schema.Schema.Type<typeof PrepareRequest>;

export const CommitRequest = PrepareRequest;
export type CommitRequest = PrepareRequest;

export const AlreadyCommittedResponse = Schema.Struct({
  success: Schema.Literal(true),
  alreadyCommitted: Schema.Literal(true),
  globalVersion: GlobalVersion,
  fileVersion: FileVersion,
});
export type AlreadyCommittedResponse = Schema.Schema.Type<typeof AlreadyCommittedResponse>;

export const PrepareOkResponse = Schema.Struct({
  success: Schema.Literal(true),
  missing: Schema.Array(ChunkHash),
  currentVersion: FileVersion,
});
export type PrepareOkResponse = Schema.Schema.Type<typeof PrepareOkResponse>;

export const ConflictResponse = Schema.Struct({
  success: Schema.Literal(false),
  conflict: Schema.Literal(true),
  currentVersion: FileVersion,
  currentChunks: Schema.optionalKey(Schema.Array(ChunkHash)),
});
export type ConflictResponse = Schema.Schema.Type<typeof ConflictResponse>;

export const PrepareResponse = Schema.Union([
  PrepareOkResponse,
  AlreadyCommittedResponse,
  ConflictResponse,
]);
export type PrepareResponse = Schema.Schema.Type<typeof PrepareResponse>;

export const CommitOkResponse = Schema.Struct({
  success: Schema.Literal(true),
  fileVersion: FileVersion,
  globalVersion: GlobalVersion,
});
export type CommitOkResponse = Schema.Schema.Type<typeof CommitOkResponse>;

export const ProtocolErrorResponse = Schema.Struct({
  success: Schema.Literal(false),
  error: Schema.String,
  code: Schema.String,
});
export type ProtocolErrorResponse = Schema.Schema.Type<typeof ProtocolErrorResponse>;

export const CommitResponse = Schema.Union([
  CommitOkResponse,
  AlreadyCommittedResponse,
  ConflictResponse,
  ProtocolErrorResponse,
]);
export type CommitResponse = Schema.Schema.Type<typeof CommitResponse>;

export const ChangeRecord = Schema.Struct({
  globalVersion: GlobalVersion,
  opId: OpId,
  path: FilePath,
  oldPath: Schema.NullOr(FilePath),
  action: SyncAction,
  fileVersion: FileVersion,
  deviceId: DeviceId,
  chunks: Schema.Array(ChunkHash),
  mtime: Mtime,
  size: ByteSize,
  timestamp: Mtime,
});
export type ChangeRecord = Schema.Schema.Type<typeof ChangeRecord>;

export const ChangesResponse = Schema.Struct({
  changes: Schema.Array(ChangeRecord),
  globalVersion: GlobalVersion,
});
export type ChangesResponse = Schema.Schema.Type<typeof ChangesResponse>;

export const FileIndexEntry = Schema.Struct({
  path: FilePath,
  chunks: Schema.Array(ChunkHash),
  mtime: Mtime,
  size: ByteSize,
  fileVersion: FileVersion,
  globalVersion: GlobalVersion,
});
export type FileIndexEntry = Schema.Schema.Type<typeof FileIndexEntry>;

export const FullIndexResponse = Schema.Struct({
  files: Schema.Array(FileIndexEntry),
  globalVersion: GlobalVersion,
});
export type FullIndexResponse = Schema.Schema.Type<typeof FullIndexResponse>;

export const ChunkUploadResponse = Schema.Struct({
  success: Schema.Literal(true),
  hash: ChunkHash,
});
export type ChunkUploadResponse = Schema.Schema.Type<typeof ChunkUploadResponse>;

export const DeviceEnrollmentRequest = Schema.Struct({
  deviceId: DeviceId,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  platform: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type DeviceEnrollmentRequest = Schema.Schema.Type<typeof DeviceEnrollmentRequest>;

export const DeviceEnrollmentResponse = Schema.Struct({
  success: Schema.Literal(true),
  deviceId: DeviceId,
  deviceToken: Schema.String.check(Schema.isMinLength(32)),
});
export type DeviceEnrollmentResponse = Schema.Schema.Type<typeof DeviceEnrollmentResponse>;

export const RevokeDeviceRequest = Schema.Struct({
  deviceId: DeviceId,
});
export type RevokeDeviceRequest = Schema.Schema.Type<typeof RevokeDeviceRequest>;

export const RevokeDeviceResponse = Schema.Struct({
  success: Schema.Literal(true),
  deviceId: DeviceId,
});
export type RevokeDeviceResponse = Schema.Schema.Type<typeof RevokeDeviceResponse>;

export const decodeUnknownSync = Schema.decodeUnknownSync;
