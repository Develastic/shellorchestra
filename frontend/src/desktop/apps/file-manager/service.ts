// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { DesktopAppCapability, DesktopAppSandbox } from '../app-framework/sandbox';
import { FileManagerLocationCollection, FileManagerPayload, FileManagerPreview, FileVersionCollection, FileVersionContent, RemoteFileEntryCollection, RemoteFileProperties, RemoteTextChunk, RemoteTextDocument, type FileManagerAction } from './model';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';
import { readBinaryResponseToBlob, saveBinaryResponseToBrowser } from '../../../streaming/BrowserBinaryStreamClient';

const FILE_MANAGER_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

export type EditorPreflightOptions = {
  editorMode?: 'edit' | 'safe_view';
  editorMaxBytes?: number;
  editorMaxLineBytes?: number;
};

export type FileTransferProgress = {
  fileName: string;
  fileIndex: number;
  fileCount: number;
  bytesDone: number;
  bytesTotal: number;
  overallBytesDone: number;
  overallBytesTotal: number;
};

export type FileDownloadResult = {
  name: string;
  mime: string;
  blob?: Blob;
  bytesDone?: number;
};

export type FileManagerArchiveFormat = 'auto' | 'tar.zst' | 'tar.gz' | 'zip';
export type FileManagerSearchOptions = {
  rootPath: string;
  namePattern: string;
  nameMode: 'glob' | 'regex' | 'literal';
  content: string;
  contentMode: 'literal' | 'regex';
  caseSensitive: boolean;
  skipBinary: boolean;
  stayFilesystem: boolean;
  includeHidden: boolean;
  maxResults: number;
  maxFileBytes: number;
};

export type FileManagerSendToJob = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | string;
  transferMode: string;
  sourceServerID: string;
  sourcePaths: string[];
  sourceTypes: string[];
  destinationServerID: string;
  destinationPath: string;
  resolvedTargetPath: string;
  overwrite: boolean;
  compression: string;
  bytesTransferred: number;
  message: string;
  error: string;
};

export class FileManagerService {
  readonly serverID: string;
  private readonly sandbox: DesktopAppSandbox;
  private readonly fileCapability: DesktopAppCapability;

  constructor(serverID: string, sandbox: DesktopAppSandbox, fileCapability: DesktopAppCapability = 'files') {
    this.serverID = serverID;
    this.sandbox = sandbox;
    this.fileCapability = fileCapability;
    this.sandbox.assertServerID(serverID);
  }

  async locations(): Promise<FileManagerLocationCollection> {
    return new FileManagerLocationCollection(await this.run('locations'));
  }

  async list(path: string, knownListingHash = '', previous?: RemoteFileEntryCollection): Promise<RemoteFileEntryCollection> {
    const next = new RemoteFileEntryCollection(await this.listStream(path, knownListingHash));
    if (next.unchanged && previous && previous.listingHash && previous.listingHash === next.listingHash) {
      return previous;
    }
    return next;
  }

  async preview(path: string, maxBytes = 262144, editorOptions: EditorPreflightOptions = {}, hint?: { type?: string; size?: number }): Promise<FileManagerPreview> {
    const typeHint = stringValue(hint?.type);
    if (typeHint === 'directory' || typeHint === 'parent') {
      return new FileManagerPreview({
        ok: true,
        action: 'preview',
        path,
        type: typeHint || 'directory',
        size: 0,
        text: false,
        preview_kind: 'directory',
        safe_preview: false,
        content: '',
        transport_backend_remote: 'not requested for directories',
        transport_browser: 'local metadata object',
        transport_compression: 'none',
        transport_binary_stream: false,
        transport_base64_payload: false,
        transport_streaming_inspection: false,
      });
    }
    return new FileManagerPreview(await this.previewStream(path, maxBytes, hint, editorOptions));
  }

  async archivePreview(path: string, maxEntries = 200): Promise<FileManagerPreview> {
    const params = new URLSearchParams({
      server_id: this.serverID,
      path,
      max_entries: String(Math.max(1, Math.min(5000, Math.floor(maxEntries)))),
    });
    const response = await this.sandbox.fetch(`/api/file-manager/archive-list?${params.toString()}`, {
      method: 'GET',
      requiredCapability: 'safe-preview',
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not list this archive.'));
    const payload = await response.json() as Record<string, unknown>;
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    const lines = entries.slice(0, maxEntries).map((entry) => archiveEntryPreviewLine(entry));
    const archiveType = stringValue(payload.archive_type) || 'archive';
    const skipped = numberValue(payload.skipped_entries);
    const truncated = Boolean(payload.truncated);
    const suffixes: string[] = [];
    if (skipped > 0) suffixes.push(`${skipped} unsafe entr${skipped === 1 ? 'y was' : 'ies were'} skipped`);
    if (truncated) suffixes.push('listing was truncated');
    const content = [
      `Archive type: ${archiveType}`,
      `Read-only entries shown: ${entries.length}`,
      ...suffixes.map((item) => `Warning: ${item}.`),
      '',
      ...lines,
    ].join('\n');
    return new FileManagerPreview({
      ok: payload.ok !== false,
      action: 'preview',
      path,
      type: 'file',
      size: 0,
      text: true,
      preview_kind: 'text',
      safe_preview: true,
      editor_mode: 'blocked',
      editor_safe: false,
      editor_reason: 'Archive listings are read-only in File Manager quick preview.',
      detected_language: 'plaintext',
      encoding: 'utf-8',
      mime: 'text/plain;charset=utf-8',
      content,
      error: stringValue(payload.error),
      transport_backend_remote: 'SSH worker file_manager_archive_list script',
      transport_browser: 'JSON metadata response, no file bytes in browser upload',
      transport_compression: 'script-selected',
      transport_binary_stream: false,
      transport_base64_payload: false,
      transport_streaming_inspection: false,
    });
  }

  async archiveList(path: string, innerPath = '', maxEntries = 2000): Promise<RemoteFileEntryCollection> {
    const normalizedInner = normalizeArchiveInnerPath(innerPath);
    const params = new URLSearchParams({
      server_id: this.serverID,
      path,
      inner_path: normalizedInner,
      max_entries: String(Math.max(1, Math.min(5000, Math.floor(maxEntries)))),
    });
    const response = await this.sandbox.fetch(`/api/file-manager/archive-list?${params.toString()}`, {
      method: 'GET',
      requiredCapability: 'safe-preview',
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not list this archive.'));
    const payload = await response.json() as Record<string, unknown>;
    const rows = Array.isArray(payload.entries) ? payload.entries : [];
    const archivePath = stringValue(payload.archive_path) || path;
    const collectionPayload = {
      ok: payload.ok !== false,
      action: 'archive_list',
      path: archiveVirtualPath(archivePath, normalizedInner),
      parent_path: normalizedInner ? archiveVirtualPath(archivePath, parentArchiveInnerPath(normalizedInner)) : parentPathFromPath(archivePath),
      entries: rows.map((row) => ({ ...(row && typeof row === 'object' ? row as Record<string, unknown> : {}), virtual_origin: 'archive' })),
      safe_filename_mode: 'hide_dangerous',
      virtual_location_kind: 'archive',
      readonly: true,
      hidden_entries_count: numberValue(payload.skipped_entries),
      hidden_entries_reasons: numberValue(payload.skipped_entries) > 0 ? ['unsafe archive entries skipped'] : [],
      results_count: numberValue(payload.entry_count),
      profile: {
        action: 'archive_list',
        platform: stringValue(payload.platform),
        requested_path: archivePath,
        resolved_path: archiveVirtualPath(archivePath, normalizedInner),
        entries_count: rows.length,
      },
      error: stringValue(payload.error),
    };
    return new RemoteFileEntryCollection(collectionPayload);
  }

  async properties(path: string): Promise<RemoteFileProperties> {
    return new RemoteFileProperties(await this.run('properties', { file_manager_path: path }));
  }

  async calculateSize(path: string): Promise<RemoteFileProperties> {
    return new RemoteFileProperties(await this.run('calculate_size', { file_manager_path: path }));
  }

  async read(path: string, maxBytes = 2097152, editorOptions: EditorPreflightOptions = {}): Promise<RemoteTextDocument> {
    return new RemoteTextDocument(await this.editorStream(path, {
      maxBytes,
      offset: 0,
      mode: editorOptions.editorMode ?? 'edit',
      editorMaxBytes: editorOptions.editorMaxBytes,
      editorMaxLineBytes: editorOptions.editorMaxLineBytes,
    }));
  }

  async download(path: string, onProgress?: (progress: { bytesDone: number; bytesTotal: number }) => void, signal?: AbortSignal): Promise<FileDownloadResult> {
    const response = await this.openDownloadResponse(path, signal);
    const name = safeDownloadName(downloadNameFromResponse(response) || basenameFromPath(path));
    const mime = response.headers.get('Content-Type') || 'application/octet-stream';
    const size = Number(response.headers.get('Content-Length') || '0');
    const result = await readBinaryResponseToBlob(response, {
      name,
      mime,
      bytesTotal: size,
      signal,
      onProgress,
    });
    const blob = result.blob ?? new Blob([], { type: mime });
    return { name, mime, blob, bytesDone: blob.size };
  }

  async downloadToBrowser(path: string, suggestedName = '', onProgress?: (progress: { bytesDone: number; bytesTotal: number }) => void, signal?: AbortSignal): Promise<FileDownloadResult> {
    const response = await this.openDownloadResponse(path, signal);
    const name = safeDownloadName(downloadNameFromResponse(response) || suggestedName || basenameFromPath(path));
    const mime = response.headers.get('Content-Type') || 'application/octet-stream';
    const size = Number(response.headers.get('Content-Length') || '0');
    const result = await saveBinaryResponseToBrowser(response, {
      name,
      mime,
      bytesTotal: size,
      signal,
      onProgress,
    });
    return { name, mime, blob: result.blob, bytesDone: result.bytesDone };
  }

  private async openDownloadResponse(path: string, signal?: AbortSignal): Promise<Response> {
    const url = `/api/file-manager/download?server_id=${encodeURIComponent(this.serverID)}&path=${encodeURIComponent(path)}`;
    const response = await this.sandbox.fetch(url, { method: 'GET', signal, requiredCapability: 'stream-download' });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not download this file.'));
    return response;
  }

  async readRange(path: string, offset: number, length: number, editorOptions: EditorPreflightOptions = {}): Promise<RemoteTextChunk> {
    return new RemoteTextChunk(await this.editorStream(path, {
      maxBytes: Math.max(1, Math.floor(length)),
      offset: Math.max(0, Math.floor(offset)),
      mode: editorOptions.editorMode ?? 'safe_view',
      editorMaxBytes: editorOptions.editorMaxBytes,
      editorMaxLineBytes: editorOptions.editorMaxLineBytes,
    }));
  }

  async write(path: string, content: string): Promise<FileManagerPayload> {
    const blob = new Blob([new TextEncoder().encode(content)], { type: 'text/plain;charset=utf-8' });
    return this.uploadBlob(path, blob, true, 'editor_save', basenameFromPath(path) || 'editor-save.txt');
  }

  async uploadFile(path: string, file: File, overwrite: boolean, onProgress?: (progress: FileTransferProgress) => void, signal?: AbortSignal, aggregate?: { index: number; count: number; doneBefore: number; total: number }): Promise<FileManagerPayload> {
    return this.uploadBlob(path, file, overwrite, 'upload', file.name, onProgress, signal, aggregate);
  }

  private async uploadBlob(path: string, blob: Blob, overwrite: boolean, mode: 'upload' | 'editor_save', fileName: string, onProgress?: (progress: FileTransferProgress) => void, signal?: AbortSignal, aggregate?: { index: number; count: number; doneBefore: number; total: number }): Promise<FileManagerPayload> {
    const start = await postJSON(this.sandbox, '/api/file-manager/uploads', {
      server_id: this.serverID,
      path,
      mode,
      overwrite,
      confirmed: true,
      size: blob.size,
    }, 'stream-upload', signal);
    const uploadID = stringValue(start.upload_id);
    if (!uploadID) throw new Error('ShellOrchestra did not create an upload session.');
    let offset = 0;
    try {
      while (offset < blob.size) {
        const chunk = blob.slice(offset, Math.min(blob.size, offset + FILE_MANAGER_UPLOAD_CHUNK_BYTES));
        const response = await this.sandbox.fetch(`/api/file-manager/uploads/${encodeURIComponent(uploadID)}/chunk?offset=${offset}`, {
          method: 'PUT',
          body: chunk,
          headers: { 'Content-Type': 'application/octet-stream' },
          signal,
          requiredCapability: 'stream-upload',
        });
        if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not upload this file chunk.'));
        offset += chunk.size;
        onProgress?.({
          fileName,
          fileIndex: aggregate?.index ?? 0,
          fileCount: aggregate?.count ?? 1,
          bytesDone: offset,
          bytesTotal: blob.size,
          overallBytesDone: (aggregate?.doneBefore ?? 0) + offset,
          overallBytesTotal: aggregate?.total ?? blob.size,
        });
      }
      const finished = await postJSON(this.sandbox, `/api/file-manager/uploads/${encodeURIComponent(uploadID)}/finish`, {}, 'stream-upload', signal);
      const payload = new FileManagerPayload(finished);
      payload.requireOK(mode === 'editor_save' ? 'ShellOrchestra could not save this file.' : 'ShellOrchestra could not finish the upload.');
      return payload;
    } catch (error) {
      await this.sandbox.fetch(`/api/file-manager/uploads/${encodeURIComponent(uploadID)}`, { method: 'DELETE', requiredCapability: 'stream-upload' }).catch(() => undefined);
      throw error;
    }
  }

  async uploadFiles(directory: string, files: File[], overwrite: boolean, onProgress?: (progress: FileTransferProgress) => void, signal?: AbortSignal): Promise<FileManagerPayload[]> {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    let doneBefore = 0;
    const results: FileManagerPayload[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const result = await this.uploadFile(joinPath(directory, file.name), file, overwrite, onProgress, signal, {
        index,
        count: files.length,
        doneBefore,
        total,
      });
      doneBefore += file.size;
      results.push(result);
    }
    return results;
  }


  async startSendTo(options: { sources: { path: string; type: string }[]; destinationServerID: string; destinationPath: string; overwrite: boolean }, signal?: AbortSignal): Promise<FileManagerSendToJob> {
    const payload = await postJSON(this.sandbox, '/api/file-manager/send-to', {
      source_server_id: this.serverID,
      source_paths: options.sources.map((source) => source.path),
      source_types: options.sources.map((source) => source.type),
      destination_server_id: options.destinationServerID,
      destination_path: options.destinationPath,
      overwrite: options.overwrite,
      confirmed: true,
    }, 'stream-upload', signal);
    return normalizeSendToJob(payload);
  }

  async getSendToJob(jobID: string, signal?: AbortSignal): Promise<FileManagerSendToJob> {
    const response = await this.sandbox.fetch(`/api/file-manager/send-to/${encodeURIComponent(jobID)}`, { method: 'GET', signal, requiredCapability: 'stream-upload' });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not load Send To progress.'));
    return normalizeSendToJob(await response.json());
  }

  async cancelSendToJob(jobID: string, signal?: AbortSignal): Promise<FileManagerSendToJob> {
    const response = await this.sandbox.fetch(`/api/file-manager/send-to/${encodeURIComponent(jobID)}/cancel`, { method: 'POST', signal, requiredCapability: 'stream-upload' });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not cancel Send To.'));
    return normalizeSendToJob(await response.json());
  }

  async waitSendToJob(jobID: string, onProgress?: (job: FileManagerSendToJob) => void, signal?: AbortSignal): Promise<FileManagerSendToJob> {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Send To was cancelled.', 'AbortError');
      const job = await this.getSendToJob(jobID, signal);
      onProgress?.(job);
      if (job.status === 'completed') return job;
      if (job.status === 'failed' || job.status === 'cancelled') throw new Error(job.error || job.message || `Send To ${job.status}.`);
      await delay(650, signal);
    }
  }

  async versions(path: string): Promise<FileVersionCollection> {
    const response = await this.sandbox.fetch(`/api/file-versions?server_id=${encodeURIComponent(this.serverID)}&path=${encodeURIComponent(path)}`, { method: 'GET', requiredCapability: this.fileCapability });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not load file history.'));
    return new FileVersionCollection(await response.json());
  }

  async versionContent(versionID: string): Promise<FileVersionContent> {
    const response = await this.sandbox.fetch(`/api/file-versions/${encodeURIComponent(versionID)}`, { method: 'GET', requiredCapability: this.fileCapability });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not load this file version.'));
    return new FileVersionContent(await response.json());
  }

  async createFile(path: string): Promise<FileManagerPayload> {
    return this.payload('create_file', { file_manager_path: path });
  }

  async createDirectory(path: string): Promise<FileManagerPayload> {
    return this.payload('create_directory', { file_manager_path: path });
  }

  async delete(path: string): Promise<FileManagerPayload> {
    return this.payload('delete', { file_manager_path: path });
  }

  async copy(path: string, destinationPath: string): Promise<FileManagerPayload> {
    return this.payload('copy', { file_manager_path: path, file_manager_destination_path: destinationPath });
  }

  async move(path: string, destinationPath: string): Promise<FileManagerPayload> {
    return this.payload('move', { file_manager_path: path, file_manager_destination_path: destinationPath });
  }

  async rename(path: string, newName: string): Promise<FileManagerPayload> {
    return this.payload('rename', { file_manager_path: path, file_manager_new_name: newName });
  }

  async chmod(path: string, mode: string): Promise<FileManagerPayload> {
    return this.payload('chmod', { file_manager_path: path, file_manager_mode: mode });
  }

  async compress(parentPath: string, sourceNames: string[], archivePath: string, archiveFormat: FileManagerArchiveFormat, overwrite: boolean): Promise<FileManagerPayload> {
    return this.payload('compress', {
      file_manager_path: parentPath,
      file_manager_destination_path: archivePath,
      file_manager_source_names_b64: encodeStringListBase64(sourceNames),
      file_manager_archive_format: archiveFormat,
      file_manager_overwrite: overwrite ? 'true' : 'false',
    });
  }

  async uncompress(path: string, destinationPath: string, overwrite: boolean): Promise<FileManagerPayload> {
    return this.payload('uncompress', {
      file_manager_path: path,
      file_manager_destination_path: destinationPath,
      file_manager_overwrite: overwrite ? 'true' : 'false',
    });
  }

  private async payload(action: FileManagerAction, args: Record<string, string> = {}): Promise<FileManagerPayload> {
    const payload = new FileManagerPayload(await this.run(action, args, true));
    payload.requireOK(`ShellOrchestra could not complete ${action.replaceAll('_', ' ')}.`);
    return payload;
  }

  private async run(action: FileManagerAction, args: Record<string, string> = {}, confirmed = false): Promise<unknown> {
    const data = await this.sandbox.runFileManagerData({ file_manager_action: action, ...args }, this.fileCapability, confirmed);
    return data.result;
  }

  private async listStream(path: string, knownListingHash = ''): Promise<Record<string, unknown>> {
    const args: Record<string, string> = { file_manager_action: 'list', file_manager_path: path, file_manager_stream_format: 'row_events' };
    if (knownListingHash) args.file_manager_known_listing_hash = knownListingHash;
    const response = await this.sandbox.fetch('/api/desktop-apps/file_manager/data-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: this.serverID, args, confirmed: false }),
      requiredCapability: this.fileCapability,
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream this directory listing.'));
    return readFileManagerListNDJSON(response, path);
  }

  async search(options: FileManagerSearchOptions): Promise<RemoteFileEntryCollection> {
    const args: Record<string, string> = {
      file_manager_action: 'search',
      file_manager_path: options.rootPath,
      file_manager_stream_format: 'row_events',
      file_manager_search_name_pattern: options.namePattern || '*',
      file_manager_search_name_mode: options.nameMode,
      file_manager_search_content: options.content,
      file_manager_search_content_mode: options.contentMode,
      file_manager_search_case_sensitive: options.caseSensitive ? 'true' : 'false',
      file_manager_search_skip_binary: options.skipBinary ? 'true' : 'false',
      file_manager_search_stay_filesystem: options.stayFilesystem ? 'true' : 'false',
      file_manager_search_include_hidden: options.includeHidden ? 'true' : 'false',
      file_manager_search_max_results: String(Math.max(1, Math.min(10000, Math.floor(options.maxResults || 1000)))),
      file_manager_search_max_file_bytes: String(Math.max(1024, Math.min(64 * 1024 * 1024, Math.floor(options.maxFileBytes || 1024 * 1024)))),
    };
    const response = await this.sandbox.fetch('/api/desktop-apps/file_manager/data-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: this.serverID, args, confirmed: false }),
      requiredCapability: this.fileCapability,
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream this search.'));
    const payload = await readFileManagerListNDJSON(response, options.rootPath);
    payload.virtual_location_kind = 'search';
    payload.readonly = true;
    return new RemoteFileEntryCollection(payload);
  }

  private async previewStream(path: string, maxBytes: number, hint?: { type?: string; size?: number }, editorOptions: EditorPreflightOptions = {}): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({
      server_id: this.serverID,
      path,
      max_bytes: String(Math.max(1, Math.floor(maxBytes))),
    });
    const typeHint = stringValue(hint?.type);
    if (typeHint) params.set('type', typeHint);
    if (Number.isFinite(hint?.size) && Number(hint?.size) >= 0) params.set('size', String(Math.floor(Number(hint?.size))));
    if (editorOptions.editorMode) params.set('editor_mode', editorOptions.editorMode);
    if (Number.isFinite(editorOptions.editorMaxBytes) && Number(editorOptions.editorMaxBytes) > 0) params.set('editor_max_bytes', String(Math.floor(Number(editorOptions.editorMaxBytes))));
    if (Number.isFinite(editorOptions.editorMaxLineBytes) && Number(editorOptions.editorMaxLineBytes) > 0) params.set('editor_max_line_bytes', String(Math.floor(Number(editorOptions.editorMaxLineBytes))));
    const response = await this.sandbox.fetch(`/api/file-manager/preview-stream?${params.toString()}`, {
      method: 'GET',
      requiredCapability: 'safe-preview',
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream this preview.'));
    return readPreviewNDJSON(response, path, typeHint, Number(hint?.size ?? 0));
  }

  private async editorStream(path: string, options: { maxBytes: number; offset: number; mode: 'edit' | 'safe_view'; editorMaxBytes?: number; editorMaxLineBytes?: number }): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({
      server_id: this.serverID,
      path,
      max_bytes: String(Math.max(1, Math.floor(options.maxBytes))),
      offset: String(Math.max(0, Math.floor(options.offset))),
      mode: options.mode,
    });
    if (Number.isFinite(options.editorMaxBytes) && Number(options.editorMaxBytes) > 0) params.set('editor_max_bytes', String(Math.floor(Number(options.editorMaxBytes))));
    if (Number.isFinite(options.editorMaxLineBytes) && Number(options.editorMaxLineBytes) > 0) params.set('editor_max_line_bytes', String(Math.floor(Number(options.editorMaxLineBytes))));
    const response = await this.sandbox.fetch(`/api/file-manager/editor-stream?${params.toString()}`, {
      method: 'GET',
      requiredCapability: this.fileCapability,
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream this file into the editor.'));
    return readEditorNDJSON(response, path, options.offset);
  }
}

type PreviewStreamEvent = Record<string, unknown> & {
  event?: 'meta' | 'chunk' | 'done' | 'error' | string;
  content?: unknown;
  error?: unknown;
  transport?: unknown;
};

type FileManagerListStreamEvent = Record<string, unknown> & {
  event?: 'meta' | 'row' | 'done' | 'result' | 'error' | string;
  data?: unknown;
  error?: unknown;
  transport?: unknown;
};

async function readFileManagerListNDJSON(response: Response, requestedPath: string): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    ok: true,
    action: 'list',
    path: requestedPath,
    entries: [],
    safe_filename_mode: 'hide_dangerous',
  };
  const rows: unknown[] = [];
  let resultPayload: Record<string, unknown> | null = null;

  const applyEvent = (event: RemoteStreamEvent) => {
    const kind = stringValue(event.event);
    if (kind === 'result' && event.data && typeof event.data === 'object') {
      const data = event.data as Record<string, unknown>;
      const result = data.result;
      if (result && typeof result === 'object') {
        resultPayload = result as Record<string, unknown>;
      }
      return;
    }
    if (kind === 'meta' || kind === 'done') {
      Object.assign(payload, flattenListStreamEvent(event as FileManagerListStreamEvent));
      return;
    }
    if (kind === 'row') {
      const data = event.data;
      if (data && typeof data === 'object') rows.push(data);
    }
  };

  const client = new RemoteStreamClient(response, { onEvent: applyEvent });
  await client.readNDJSON();
  if (resultPayload) return resultPayload;
  payload.entries = rows;
  return payload;
}

async function readPreviewNDJSON(response: Response, path: string, typeHint: string, sizeHint: number): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    ok: true,
    action: 'preview',
    path,
    type: typeHint || 'file',
    size: sizeHint,
    text: false,
    preview_kind: 'binary',
    content: '',
  };
  let content = '';
  const applyEvent = (event: RemoteStreamEvent) => {
    const kind = stringValue(event.event);
    if (kind === 'meta' || kind === 'done') {
      Object.assign(payload, flattenPreviewStreamEvent(event as PreviewStreamEvent));
      return;
    }
    if (kind === 'chunk') {
      content += stringValue(event.content);
      return;
    }
  };
  const client = new RemoteStreamClient(response, { onEvent: applyEvent });
  await client.readNDJSON();
  payload.content = content;
  if (content) {
    payload.text = true;
    if (!stringValue(payload.preview_kind) || stringValue(payload.preview_kind) === 'binary') payload.preview_kind = 'text';
  }
  return payload;
}

async function readEditorNDJSON(response: Response, path: string, offset: number): Promise<Record<string, unknown>> {
  const payload = await readPreviewNDJSON(response, path, 'file', 0);
  const content = stringValue(payload.content);
  const bytes = new TextEncoder().encode(content).byteLength;
  const nextOffset = numberValue(payload.next_offset);
  return {
    ...payload,
    ok: true,
    action: offset > 0 ? 'read_range' : 'read',
    path,
    text: true,
    content,
    offset,
    length: bytes,
    next_offset: nextOffset > 0 ? nextOffset : offset + bytes,
    truncated: Boolean(payload.truncated),
  };
}

function flattenPreviewStreamEvent(event: PreviewStreamEvent): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === 'event' || key === 'transport') continue;
    result[key] = value;
  }
  const transport = event.transport && typeof event.transport === 'object' ? event.transport as Record<string, unknown> : {};
  result.transport_backend_remote = stringValue(transport.backend_remote_transport);
  result.transport_browser = stringValue(transport.browser_transport);
  result.transport_compression = stringValue(transport.compression);
  result.transport_binary_stream = Boolean(transport.binary_stream);
  result.transport_base64_payload = Boolean(transport.base64_payload);
  result.transport_streaming_inspection = Boolean(transport.streaming_inspection);
  return result;
}

function flattenListStreamEvent(event: FileManagerListStreamEvent): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'event' || key === 'transport' || key === 'entries') continue;
    result[key] = value;
  }
  const transport = (event.transport && typeof event.transport === 'object'
    ? event.transport
    : data.transport && typeof data.transport === 'object'
      ? data.transport
      : {}) as Record<string, unknown>;
  if (Object.keys(transport).length > 0) {
    result.transport_backend_remote = stringValue(transport.backend_remote_transport);
    result.transport_browser = stringValue(transport.browser_transport);
    result.transport_compression = stringValue(transport.compression);
    result.transport_binary_stream = Boolean(transport.binary_stream);
    result.transport_base64_payload = Boolean(transport.base64_payload);
    result.transport_streaming_inspection = Boolean(transport.streaming_inspection);
  }
  return result;
}

async function postJSON(sandbox: DesktopAppSandbox, path: string, body: unknown, requiredCapability: DesktopAppCapability, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await sandbox.fetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    signal,
    requiredCapability,
  });
  if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra request failed.'));
  const payload = await response.json().catch(() => ({}));
  return payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = await response.clone().json().catch(() => ({})) as { error?: string };
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  const text = await response.clone().text().catch(() => '');
  return text.trim() || fallback;
}



function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeSendToJob(value: unknown): FileManagerSendToJob {
  const dto = normalizeObject(value) as Record<string, unknown>;
  return {
    id: stringValue(dto.id),
    status: stringValue(dto.status) || 'queued',
    transferMode: stringValue(dto.transfer_mode),
    sourceServerID: stringValue(dto.source_server_id),
    sourcePaths: Array.isArray(dto.source_paths) ? dto.source_paths.map((item) => stringValue(item)).filter(Boolean) : [],
    sourceTypes: Array.isArray(dto.source_types) ? dto.source_types.map((item) => stringValue(item)) : [],
    destinationServerID: stringValue(dto.destination_server_id),
    destinationPath: stringValue(dto.destination_path),
    resolvedTargetPath: stringValue(dto.resolved_target_path),
    overwrite: Boolean(dto.overwrite),
    compression: stringValue(dto.compression),
    bytesTransferred: numberValue(dto.bytes_transferred),
    message: stringValue(dto.message),
    error: stringValue(dto.error),
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Operation was cancelled.', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('Operation was cancelled.', 'AbortError'));
    }, { once: true });
  });
}

function downloadNameFromResponse(response: Response): string {
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = /filename=\"?([^\";]+)\"?/i.exec(disposition);
  return match ? match[1] : '';
}

function basenameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

function parentPathFromPath(path: string): string {
  const clean = path.replace(/[\\/]+$/, '');
  if (!clean || clean === '/') return '/';
  if (/^[A-Za-z]:\\?$/.test(clean)) return clean;
  const separator = clean.includes('\\') && !clean.includes('/') ? '\\' : '/';
  const index = clean.lastIndexOf(separator);
  if (index <= 0) return separator === '\\' ? clean : '/';
  return clean.slice(0, index);
}

function normalizeArchiveInnerPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function archiveVirtualPath(archivePath: string, innerPath: string): string {
  return innerPath ? `${archivePath}!/${innerPath}` : `${archivePath}!/`;
}

function parentArchiveInnerPath(innerPath: string): string {
  const clean = normalizeArchiveInnerPath(innerPath);
  const index = clean.lastIndexOf('/');
  return index < 0 ? '' : clean.slice(0, index);
}

function safeDownloadName(value: string): string {
  const basename = (value || '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  const trimmed = basename
    .replace(/[\x00-\x1f\x7f]/g, '_')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  const candidate = trimmed.slice(0, 180) || 'download.bin';
  const stem = candidate.split('.')[0]?.toUpperCase() ?? '';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    return `_${candidate}`;
  }
  if (candidate === '.' || candidate === '..') return 'download.bin';
  return candidate;
}

function encodeStringListBase64(values: string[]): string {
  const text = values.join('\n');
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function archiveEntryPreviewLine(value: unknown): string {
  const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const entryPath = stringValue(item.archive_entry_path) || stringValue(item.path) || stringValue(item.name) || '—';
  const type = stringValue(item.type);
  const marker = type === 'directory' ? '[dir]' : '[file]';
  const size = numberValue(item.size);
  const sizeText = size > 0 ? ` ${size} B` : '';
  return `${marker.padEnd(7)} ${entryPath}${sizeText}`;
}

function joinPath(base: string, name: string): string {
  const cleanName = name.trim().replace(/^[/\\]+/, '');
  if (!base || base === '/') return `/${cleanName}`;
  if (/^[A-Za-z]:\\?$/.test(base)) return `${base.replace(/\\?$/, '\\')}${cleanName}`;
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${separator}${cleanName}`;
}
