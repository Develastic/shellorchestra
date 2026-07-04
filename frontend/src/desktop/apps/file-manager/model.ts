// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type FileManagerAction =
  | 'locations'
  | 'list'
  | 'search'
  | 'create_file'
  | 'create_directory'
  | 'delete'
  | 'copy'
  | 'move'
  | 'rename'
  | 'chmod'
  | 'properties'
  | 'calculate_size'
  | 'compress'
  | 'uncompress';

export type FileManagerLocationDTO = {
  label?: string;
  path?: string;
  kind?: string;
};

export type FileManagerEntryDTO = {
  name?: string;
  path?: string;
  type?: string;
  is_dir?: boolean;
  size?: number;
  mode?: string;
  user?: string;
  group?: string;
  modified_epoch?: number;
  name_safety?: string;
  name_safety_reasons?: string[];
  virtual_origin?: string;
  archive_entry_path?: string;
  match_line?: number;
  match_column?: number;
  match_snippet?: string;
};

export type FileManagerPayloadDTO = {
  ok?: boolean;
  action?: string;
  current_path?: string;
  name?: string;
  path?: string;
  parent_path?: string;
  destination_path?: string;
  entries?: FileManagerEntryDTO[];
  safe_filename_mode?: string;
  server_sort_key?: string;
  server_sort_direction?: string;
  server_sort_directories_first?: boolean;
  listing_hash?: string;
  unchanged?: boolean;
  hidden_entries_count?: number;
  hidden_entries_reasons?: string[];
  virtual_location_kind?: string;
  readonly?: boolean;
  results_count?: number;
  files_scanned?: number;
  files_skipped_binary?: number;
  unsafe_names_skipped?: number;
  locations?: FileManagerLocationDTO[];
  error?: string;
  type?: string;
  size?: number;
  sha256?: string;
  info?: string;
  text?: boolean;
  truncated?: boolean;
  encoding?: string;
  detected_language?: string;
  content?: string;
  transport_backend_remote?: string;
  transport_browser?: string;
  transport_compression?: string;
  transport_binary_stream?: boolean;
  transport_base64_payload?: boolean;
  transport_streaming_inspection?: boolean;
  preview_kind?: string;
  mime?: string;
  safe_preview?: boolean;
  editor_mode?: string;
  editor_safe?: boolean;
  editor_sanitized?: boolean;
  editor_reason?: string;
  asset_error?: string;
  recursive_size?: number;
  mode?: string;
  mode_symbolic?: string;
  user?: string;
  group?: string;
  modified_epoch?: number;
  offset?: number;
  length?: number;
  next_offset?: number;
  version_id?: string;
  audit_event_id?: string;
  audit_hash?: string;
  profile?: Record<string, unknown>;
};

export class FileManagerPayload {
  readonly ok: boolean;
  readonly action: string;
  readonly error: string;
  readonly raw: FileManagerPayloadDTO;

  constructor(value: unknown) {
    const dto = normalizeObject(value) as FileManagerPayloadDTO;
    this.ok = dto.ok !== false;
    this.action = stringValue(dto.action);
    this.error = stringValue(dto.error);
    this.raw = dto;
  }

  requireOK(fallback: string) {
    if (!this.ok || this.error) throw new Error(this.error || fallback);
  }
}

export class FileManagerLocation {
  readonly label: string;
  readonly path: string;
  readonly kind: string;

  constructor(value: FileManagerLocationDTO) {
    this.label = stringValue(value.label) || stringValue(value.path) || 'Location';
    this.path = stringValue(value.path);
    this.kind = stringValue(value.kind) || 'location';
  }
}

export class FileManagerLocationCollection {
  readonly currentPath: string;
  readonly items: FileManagerLocation[];
  readonly profile: FileManagerScriptProfile;

  constructor(payload: unknown) {
    const normalized = new FileManagerPayload(payload);
    this.currentPath = stringValue(normalized.raw.current_path);
    this.items = Array.isArray(normalized.raw.locations) ? normalized.raw.locations.map((item) => new FileManagerLocation(item)).filter((item) => item.path) : [];
    this.profile = new FileManagerScriptProfile(normalized.raw.profile);
  }
}

export class RemoteFileEntry {
  readonly name: string;
  readonly displayName: string;
  readonly extension: string;
  readonly path: string;
  readonly type: string;
  readonly isDirectory: boolean;
  readonly size: number;
  readonly mode: string;
  readonly user: string;
  readonly group: string;
  readonly modifiedEpoch: number;
  readonly nameSafety: string;
  readonly nameSafetyReasons: string[];
  readonly virtualOrigin: string;
  readonly archiveEntryPath: string;
  readonly matchLine: number;
  readonly matchColumn: number;
  readonly matchSnippet: string;

  constructor(value: FileManagerEntryDTO) {
    this.name = stringValue(value.name) || stringValue(value.path) || '—';
    const parts = splitEntryName(this.name, Boolean(value.is_dir) || stringValue(value.type) === 'directory' || stringValue(value.type) === 'parent');
    this.displayName = parts.displayName;
    this.extension = parts.extension;
    this.path = stringValue(value.path);
    this.type = stringValue(value.type) || (value.is_dir ? 'directory' : 'file');
    this.isDirectory = Boolean(value.is_dir) || this.type === 'directory';
    this.size = numberValue(value.size);
    this.mode = stringValue(value.mode);
    this.user = stringValue(value.user);
    this.group = stringValue(value.group);
    this.modifiedEpoch = numberValue(value.modified_epoch);
    this.nameSafety = stringValue(value.name_safety) || 'safe';
    this.nameSafetyReasons = Array.isArray(value.name_safety_reasons) ? value.name_safety_reasons.map((item) => stringValue(item)).filter(Boolean) : [];
    this.virtualOrigin = stringValue(value.virtual_origin);
    this.archiveEntryPath = stringValue(value.archive_entry_path);
    this.matchLine = numberValue(value.match_line);
    this.matchColumn = numberValue(value.match_column);
    this.matchSnippet = stringValue(value.match_snippet);
  }

  matches(query: string): boolean {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return true;
    return `${this.name} ${this.displayName} ${this.extension} ${this.path} ${this.type} ${this.user} ${this.group} ${this.mode}`.toLowerCase().includes(normalized);
  }
}

export type FileManagerSortKey = 'name' | 'extension' | 'size' | 'modified' | 'owner' | 'mode';
export type SortDirection = 'asc' | 'desc';

const fileManagerNameCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export class RemoteFileEntryCollection {
  readonly path: string;
  readonly parentPath: string;
  readonly items: RemoteFileEntry[];
  private readonly entryByPath: Map<string, RemoteFileEntry>;
  private readonly indexByPath: Map<string, number>;
  readonly profile: FileManagerScriptProfile;
  readonly safeFilenameMode: string;
  readonly serverSortKey: string;
  readonly serverSortDirection: string;
  readonly serverSortDirectoriesFirst: boolean;
  readonly listingHash: string;
  readonly unchanged: boolean;
  readonly hiddenEntriesCount: number;
  readonly hiddenEntriesReasons: string[];
  readonly virtualLocationKind: string;
  readonly readOnly: boolean;
  readonly resultsCount: number;
  readonly filesScanned: number;
  readonly filesSkippedBinary: number;
  readonly unsafeNamesSkipped: number;

  constructor(payload: unknown) {
    const normalized = new FileManagerPayload(payload);
    this.path = stringValue(normalized.raw.path);
    this.parentPath = stringValue(normalized.raw.parent_path) || this.path;
    this.items = Array.isArray(normalized.raw.entries) ? normalized.raw.entries.map((item) => new RemoteFileEntry(item)) : [];
    this.entryByPath = new Map();
    this.indexByPath = new Map();
    this.items.forEach((entry, index) => {
      this.entryByPath.set(entry.path, entry);
      this.indexByPath.set(entry.path, index);
    });
    this.profile = new FileManagerScriptProfile(normalized.raw.profile);
    this.safeFilenameMode = stringValue(normalized.raw.safe_filename_mode) || 'hide_dangerous';
    this.serverSortKey = stringValue(normalized.raw.server_sort_key);
    this.serverSortDirection = stringValue(normalized.raw.server_sort_direction);
    this.serverSortDirectoriesFirst = Boolean(normalized.raw.server_sort_directories_first);
    this.listingHash = stringValue(normalized.raw.listing_hash);
    this.unchanged = Boolean(normalized.raw.unchanged);
    this.hiddenEntriesCount = numberValue(normalized.raw.hidden_entries_count);
    this.hiddenEntriesReasons = Array.isArray(normalized.raw.hidden_entries_reasons) ? normalized.raw.hidden_entries_reasons.map((item) => stringValue(item)).filter(Boolean) : [];
    this.virtualLocationKind = stringValue(normalized.raw.virtual_location_kind);
    this.readOnly = Boolean(normalized.raw.readonly);
    this.resultsCount = numberValue(normalized.raw.results_count);
    this.filesScanned = numberValue(normalized.raw.files_scanned);
    this.filesSkippedBinary = numberValue(normalized.raw.files_skipped_binary);
    this.unsafeNamesSkipped = numberValue(normalized.raw.unsafe_names_skipped);
  }

  entry(path: string): RemoteFileEntry | null {
    return this.entryByPath.get(path) ?? null;
  }

  indexOf(path: string): number {
    return this.indexByPath.get(path) ?? -1;
  }

  view(query: string, sortKey: FileManagerSortKey, direction: SortDirection): RemoteFileEntry[] {
    const canTrustServerOrder = this.items.length >= 500
      && this.serverSortKey === sortKey
      && this.serverSortDirection === direction
      && this.serverSortDirectoriesFirst;
    if (canTrustServerOrder) {
      const normalizedQuery = query.trim();
      return normalizedQuery ? this.items.filter((entry) => entry.matches(normalizedQuery)) : this.items;
    }
    const multiplier = direction === 'asc' ? 1 : -1;
    return this.items
      .filter((entry) => entry.matches(query))
      .sort((left, right) => {
        if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
        const comparison = compareEntry(left, right, sortKey);
        return comparison * multiplier;
      });
  }
}

export class FileManagerScriptProfile {
  readonly action: string;
  readonly platform: string;
  readonly homeSource: string;
  readonly requestedPath: string;
  readonly resolvedPath: string;
  readonly entriesCount: number;
  readonly driveCount: number;
  readonly resolveMs: number;
  readonly enumerateMs: number;
  readonly sortMs: number;
  readonly projectMs: number;
  readonly locationsMs: number;
  readonly totalMs: number;
  readonly encodingRequested: string;

  constructor(value: unknown) {
    const dto = normalizeObject(value);
    this.action = stringValue(dto.action);
    this.platform = stringValue(dto.platform);
    this.homeSource = stringValue(dto.home_source);
    this.requestedPath = stringValue(dto.requested_path);
    this.resolvedPath = stringValue(dto.resolved_path);
    this.entriesCount = numberValue(dto.entries_count);
    this.driveCount = numberValue(dto.drive_count);
    this.resolveMs = numberValue(dto.resolve_ms);
    this.enumerateMs = numberValue(dto.enumerate_ms);
    this.sortMs = numberValue(dto.sort_ms);
    this.projectMs = numberValue(dto.project_ms);
    this.locationsMs = numberValue(dto.locations_ms);
    this.totalMs = numberValue(dto.total_ms);
    this.encodingRequested = stringValue(dto.output_encoding_requested);
  }

  hasTiming(): boolean {
    return this.totalMs > 0 || this.resolveMs > 0 || this.enumerateMs > 0 || this.locationsMs > 0;
  }

  compactTiming(): string {
    if (!this.hasTiming()) return '—';
    return formatProfileDuration(this.totalMs || this.resolveMs + this.enumerateMs + this.sortMs + this.projectMs + this.locationsMs);
  }

  summary(): string {
    const details: string[] = [];
    if (this.enumerateMs > 0) details.push(`enumerate ${formatProfileDuration(this.enumerateMs)}`);
    if (this.sortMs > 0) details.push(`sort ${formatProfileDuration(this.sortMs)}`);
    if (this.projectMs > 0) details.push(`shape ${formatProfileDuration(this.projectMs)}`);
    if (this.locationsMs > 0) details.push(`locations ${formatProfileDuration(this.locationsMs)}`);
    if (this.homeSource) details.push(`home: ${this.homeSource}`);
    return details.join(', ');
  }
}

export class FileManagerPreview {
  readonly ok: boolean;
  readonly error: string;
  readonly path: string;
  readonly type: string;
  readonly size: number;
  readonly sha256: string;
  readonly info: string;
  readonly isText: boolean;
  readonly previewKind: 'text' | 'image' | 'pdf' | 'document' | 'spreadsheet' | 'directory' | 'binary' | 'other';
  readonly mime: string;
  readonly safePreview: boolean;
  readonly editorMode: 'editable' | 'read_only' | 'blocked' | 'unknown';
  readonly editorSafe: boolean;
  readonly editorSanitized: boolean;
  readonly editorReason: string;
  readonly truncated: boolean;
  readonly encoding: string;
  readonly detectedLanguage: string;
  readonly content: string;
  readonly transportBackendRemote: string;
  readonly transportBrowser: string;
  readonly transportCompression: string;
  readonly transportBinaryStream: boolean;
  readonly transportBase64Payload: boolean;
  readonly transportStreamingInspection: boolean;
  readonly assetContentBase64: string;
  readonly assetError: string;

  constructor(payload: unknown) {
    const normalized = new FileManagerPayload(payload);
    this.ok = normalized.ok;
    this.error = normalized.error;
    this.path = stringValue(normalized.raw.path);
    this.type = stringValue(normalized.raw.type);
    this.size = numberValue(normalized.raw.size);
    this.sha256 = stringValue(normalized.raw.sha256);
    this.info = stringValue(normalized.raw.info);
    this.isText = Boolean(normalized.raw.text);
    this.previewKind = previewKindValue(normalized.raw.preview_kind, this.isText, this.type);
    this.mime = stringValue(normalized.raw.mime);
    this.safePreview = Boolean(normalized.raw.safe_preview);
    this.editorMode = editorModeValue(normalized.raw.editor_mode);
    this.editorSafe = normalized.raw.editor_safe === undefined ? this.isText : Boolean(normalized.raw.editor_safe);
    this.editorSanitized = Boolean(normalized.raw.editor_sanitized);
    this.editorReason = stringValue(normalized.raw.editor_reason);
    this.truncated = Boolean(normalized.raw.truncated);
    this.encoding = stringValue(normalized.raw.encoding) || 'utf-8';
    this.detectedLanguage = stringValue(normalized.raw.detected_language) || 'plaintext';
    this.content = this.isText ? stringValue(normalized.raw.content) : '';
    this.transportBackendRemote = stringValue(normalized.raw.transport_backend_remote);
    this.transportBrowser = stringValue(normalized.raw.transport_browser);
    this.transportCompression = stringValue(normalized.raw.transport_compression);
    this.transportBinaryStream = Boolean(normalized.raw.transport_binary_stream);
    this.transportBase64Payload = Boolean(normalized.raw.transport_base64_payload);
    this.transportStreamingInspection = Boolean(normalized.raw.transport_streaming_inspection);
    this.assetContentBase64 = '';
    this.assetError = stringValue(normalized.raw.asset_error);
  }
}

export class RemoteFileProperties {
  readonly ok: boolean;
  readonly error: string;
  readonly path: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly recursiveSize: number;
  readonly mode: string;
  readonly modeSymbolic: string;
  readonly user: string;
  readonly group: string;
  readonly modifiedEpoch: number;
  readonly sha256: string;

  constructor(payload: unknown) {
    const normalized = new FileManagerPayload(payload);
    this.ok = normalized.ok;
    this.error = normalized.error;
    this.path = stringValue(normalized.raw.path);
    this.name = stringValue(normalized.raw.name) || basenameFromPath(this.path);
    this.type = stringValue(normalized.raw.type);
    this.size = numberValue(normalized.raw.size);
    this.recursiveSize = numberValue(normalized.raw.recursive_size);
    this.mode = stringValue(normalized.raw.mode);
    this.modeSymbolic = stringValue(normalized.raw.mode_symbolic) || symbolicMode(this.mode);
    this.user = stringValue(normalized.raw.user);
    this.group = stringValue(normalized.raw.group);
    this.modifiedEpoch = numberValue(normalized.raw.modified_epoch);
    this.sha256 = stringValue(normalized.raw.sha256);
  }
}

export class RemoteTextDocument {
  readonly path: string;
  readonly encoding: string;
  readonly detectedLanguage: string;
  readonly size: number;
  readonly sha256: string;
  readonly content: string;

  constructor(payload: unknown) {
    const normalized = new FileManagerPayload(payload);
    normalized.requireOK('ShellOrchestra could not open this file.');
    this.path = stringValue(normalized.raw.path);
    this.encoding = stringValue(normalized.raw.encoding) || 'utf-8';
    this.detectedLanguage = stringValue(normalized.raw.detected_language) || 'plaintext';
    this.size = numberValue(normalized.raw.size);
    this.sha256 = stringValue(normalized.raw.sha256);
    this.content = stringValue(normalized.raw.content);
  }
}

export type FileVersionSummaryDTO = {
  id?: string;
  server_id?: string;
  path?: string;
  role?: string;
  content_sha256?: string;
  remote_sha256?: string;
  size_bytes?: number;
  actor_device_id?: string;
  actor_label?: string;
  audit_event_id?: string;
  created_at?: string;
};

export class FileVersionSummary {
  readonly id: string;
  readonly serverID: string;
  readonly path: string;
  readonly role: string;
  readonly contentSHA256: string;
  readonly remoteSHA256: string;
  readonly sizeBytes: number;
  readonly actorDeviceID: string;
  readonly actorLabel: string;
  readonly auditEventID: string;
  readonly createdAt: string;

  constructor(value: FileVersionSummaryDTO) {
    this.id = stringValue(value.id);
    this.serverID = stringValue(value.server_id);
    this.path = stringValue(value.path);
    this.role = stringValue(value.role);
    this.contentSHA256 = stringValue(value.content_sha256);
    this.remoteSHA256 = stringValue(value.remote_sha256);
    this.sizeBytes = numberValue(value.size_bytes);
    this.actorDeviceID = stringValue(value.actor_device_id);
    this.actorLabel = stringValue(value.actor_label);
    this.auditEventID = stringValue(value.audit_event_id);
    this.createdAt = stringValue(value.created_at);
  }

  createdLabel(): string {
    const timestamp = Date.parse(this.createdAt);
    if (!Number.isFinite(timestamp)) return this.createdAt || 'unknown time';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(timestamp));
  }
}

export class FileVersionCollection {
  readonly items: FileVersionSummary[];

  constructor(value: unknown) {
    const dto = normalizeObject(value) as { versions?: FileVersionSummaryDTO[] };
    this.items = Array.isArray(dto.versions) ? dto.versions.map((item) => new FileVersionSummary(item)).filter((item) => item.id) : [];
  }
}

export class FileVersionContent extends FileVersionSummary {
  readonly content: string;
  readonly encoding: string;

  constructor(value: unknown) {
    const dto = normalizeObject(value) as FileVersionSummaryDTO & { content?: string; encoding?: string };
    super(dto);
    this.content = stringValue(dto.content);
    this.encoding = stringValue(dto.encoding) || 'utf-8';
  }
}

export class RemoteTextChunk {
  readonly path: string;
  readonly encoding: string;
  readonly detectedLanguage: string;
  readonly size: number;
  readonly sha256: string;
  readonly offset: number;
  readonly length: number;
  readonly nextOffset: number;
  readonly truncated: boolean;
  readonly content: string;

  constructor(payload: unknown) {
    const normalized = new FileManagerPayload(payload);
    normalized.requireOK('ShellOrchestra could not read this file range.');
    this.path = stringValue(normalized.raw.path);
    this.encoding = stringValue(normalized.raw.encoding) || 'utf-8';
    this.detectedLanguage = stringValue(normalized.raw.detected_language) || 'plaintext';
    this.size = numberValue(normalized.raw.size);
    this.sha256 = stringValue(normalized.raw.sha256);
    this.offset = numberValue(normalized.raw.offset);
    this.length = numberValue(normalized.raw.length);
    this.nextOffset = numberValue(normalized.raw.next_offset);
    this.truncated = Boolean(normalized.raw.truncated);
    this.content = stringValue(normalized.raw.content);
  }
}

export class FileManagerClipboard {
  readonly mode: 'copy' | 'move';
  readonly entry: RemoteFileEntry;

  constructor(mode: 'copy' | 'move', entry: RemoteFileEntry) {
    this.mode = mode;
    this.entry = entry;
  }

  get label(): string {
    return `${this.mode === 'copy' ? 'Copy' : 'Move'} ${this.entry.name}`;
  }
}

export function symbolicMode(mode: string): string {
  const digits = mode.trim().match(/[0-7]{3,4}$/)?.[0];
  if (!digits) return '';
  const triads = digits.slice(-3).split('');
  return triads.map((digit, index) => {
    const value = Number.parseInt(digit, 8);
    let out = '';
    out += value & 4 ? 'r' : '-';
    out += value & 2 ? 'w' : '-';
    out += value & 1 ? 'x' : '-';
    if (digits.length === 4) {
      const special = Number.parseInt(digits[0], 8);
      if (index === 0 && (special & 4)) out = `${out.slice(0, 2)}${out[2] === 'x' ? 's' : 'S'}`;
      if (index === 1 && (special & 2)) out = `${out.slice(0, 2)}${out[2] === 'x' ? 's' : 'S'}`;
      if (index === 2 && (special & 1)) out = `${out.slice(0, 2)}${out[2] === 'x' ? 't' : 'T'}`;
    }
    return out;
  }).join('');
}


function basenameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatProfileDuration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 ms';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
}

function previewKindValue(value: unknown, isText: boolean, type: string): FileManagerPreview['previewKind'] {
  const text = stringValue(value);
  if (text === 'text' || text === 'image' || text === 'pdf' || text === 'document' || text === 'spreadsheet' || text === 'directory' || text === 'binary' || text === 'other') return text;
  if (isText) return 'text';
  if (type === 'directory') return 'directory';
  if (type === 'file') return 'binary';
  return 'other';
}

function editorModeValue(value: unknown): FileManagerPreview['editorMode'] {
  const normalized = stringValue(value);
  if (normalized === 'editable' || normalized === 'read_only' || normalized === 'blocked') return normalized;
  return 'unknown';
}

function compareEntry(left: RemoteFileEntry, right: RemoteFileEntry, sortKey: FileManagerSortKey): number {
  switch (sortKey) {
    case 'extension': return textCompare(left.extension, right.extension) || textCompare(left.displayName, right.displayName) || textCompare(left.name, right.name);
    case 'size': return left.size - right.size || textCompare(left.name, right.name);
    case 'modified': return left.modifiedEpoch - right.modifiedEpoch || textCompare(left.name, right.name);
    case 'owner': return textCompare(`${left.user}:${left.group}`, `${right.user}:${right.group}`) || textCompare(left.name, right.name);
    case 'mode': return textCompare(left.mode, right.mode) || textCompare(left.name, right.name);
    case 'name':
    default: return textCompare(left.name, right.name);
  }
}

function splitEntryName(name: string, keepWholeName: boolean): { displayName: string; extension: string } {
  const normalized = name.trim();
  if (!normalized || keepWholeName || normalized === '..') return { displayName: normalized || '—', extension: '' };
  const slashIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  const basename = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
  if (!basename || basename.startsWith('.') && basename.indexOf('.', 1) < 0) return { displayName: normalized, extension: '' };
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === basename.length - 1) return { displayName: normalized, extension: '' };
  const prefix = normalized.slice(0, normalized.length - basename.length);
  return { displayName: `${prefix}${basename.slice(0, dotIndex)}`, extension: basename.slice(dotIndex + 1) };
}

function textCompare(left: string, right: string): number {
  return fileManagerNameCollator.compare(left, right);
}
