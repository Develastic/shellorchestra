// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { DesktopAppSandbox } from '../app-framework/sandbox';
import { FileVersionCollection, FileVersionContent } from '../file-manager/model';
import { SudoEditorPayload, SudoEditorSaveDraft, safeSudoersPath, type SudoEditorPayloadDTO, type SudoersFileDTO } from './model';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';

export class SudoEditorService {
  readonly serverID: string;
  private readonly sandbox: DesktopAppSandbox;
  constructor(serverID: string, sandbox: DesktopAppSandbox) {
    this.serverID = serverID;
    this.sandbox = sandbox;
    this.sandbox.assertServerID(serverID);
  }
  async list(): Promise<SudoEditorPayload> {
    return this.run({ sudo_mode: 'list' }, 'Sudoers files could not be loaded.');
  }
  async read(path: string): Promise<SudoEditorPayload> {
    if (!safeSudoersPath(path)) throw new Error('Choose a supported sudoers file before reading.');
    return this.run({ sudo_mode: 'read', sudo_path: path }, 'Sudoers file could not be loaded.');
  }
  async validate(draft: SudoEditorSaveDraft): Promise<SudoEditorPayload> {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    return this.run({ ...draft.toArgs(), sudo_mode: 'validate' }, 'Sudoers draft could not be validated.');
  }
  async save(draft: SudoEditorSaveDraft): Promise<SudoEditorPayload> {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    return this.run({ ...draft.toArgs(), sudo_mode: 'save' }, 'Sudoers file could not be saved.', true);
  }
  async versions(path: string): Promise<FileVersionCollection> {
    if (!safeSudoersPath(path)) throw new Error('Choose a supported sudoers file before loading history.');
    const response = await this.sandbox.fetch(`/api/file-versions?server_id=${encodeURIComponent(this.serverID)}&path=${encodeURIComponent(path)}`, { method: 'GET', requiredCapability: 'sudoers' });
    if (!response.ok) throw new Error(await response.text() || 'ShellOrchestra could not load sudoers file history.');
    return new FileVersionCollection(await response.json());
  }
  async versionContent(versionID: string): Promise<FileVersionContent> {
    const response = await this.sandbox.fetch(`/api/file-versions/${encodeURIComponent(versionID)}`, { method: 'GET', requiredCapability: 'sudoers' });
    if (!response.ok) throw new Error(await response.text() || 'ShellOrchestra could not load this sudoers file version.');
    return new FileVersionContent(await response.json());
  }
  private async run(args: Record<string, string>, fallback: string, confirmed = false): Promise<SudoEditorPayload> {
    try {
      const streamArgs = shouldStreamSudoData(args) ? { ...args, sudo_stream_format: 'row_events' } : args;
      if (!shouldStreamSudoData(args)) {
        const data = await this.sandbox.runData(streamArgs, 'sudoers', confirmed);
        return SudoEditorPayload.fromUnknown(data.result);
      }
      const response = await this.sandbox.fetch('/api/desktop-apps/sudo_editor/data-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: this.serverID, args: streamArgs, confirmed }),
        requiredCapability: 'sudoers',
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response, fallback));
      return SudoEditorPayload.fromUnknown(await readSudoStream(response));
    } catch (error) {
      if (error instanceof Error && error.message) throw error;
      throw new Error(fallback);
    }
  }
}

type SudoStreamEvent = {
  event?: string;
  data?: unknown;
};

async function readSudoStream(response: Response): Promise<unknown> {
  let result: unknown;
  const payload: SudoEditorPayloadDTO = { available: true, files: [] };
  const files: SudoersFileDTO[] = [];
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'result') {
        const data = event.data && typeof event.data === 'object' ? event.data as { result?: unknown } : {};
        result = data.result ?? {};
        return;
      }
      if (event.event === 'meta' || event.event === 'done') {
        Object.assign(payload, flattenSudoStreamEvent(event as SudoStreamEvent));
        return;
      }
      if (event.event === 'row') {
        const row = normalizeSudoRow((event as SudoStreamEvent).data);
        if (row.kind === 'sudoers_file') files.push(row.item as SudoersFileDTO);
        else if (row.kind === 'sudoers_content') Object.assign(payload, row.item);
      }
    },
  });
  await client.readNDJSON();
  if (result !== undefined) return result;
  if (files.length) payload.files = files;
  return payload;
}

function shouldStreamSudoData(args: Record<string, string>): boolean {
  const mode = (args.sudo_mode || 'list').trim();
  return mode === 'list' || mode === 'read';
}

function normalizeSudoRow(value: unknown): { kind: 'sudoers_file' | 'sudoers_content' | ''; item: unknown } {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const kind = data.kind === 'sudoers_file' || data.kind === 'sudoers_content' ? data.kind : '';
  return { kind, item: data.item && typeof data.item === 'object' ? data.item : data };
}

function flattenSudoStreamEvent(event: SudoStreamEvent): Partial<SudoEditorPayloadDTO> {
  const result: Partial<SudoEditorPayloadDTO> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event as Record<string, unknown>;
  for (const key of ['mode', 'message', 'path', 'content', 'validation_output'] as const) {
    const value = data[key];
    if (typeof value === 'string') result[key] = value;
  }
  for (const key of ['available', 'saved', 'valid'] as const) {
    const value = data[key];
    if (typeof value === 'boolean') result[key] = value;
  }
  const size = data.size;
  if (typeof size === 'string' || typeof size === 'number') result.size = size;
  return result;
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = await response.clone().json().catch(() => ({})) as { error?: string };
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  const text = await response.clone().text().catch(() => '');
  return text.trim() || fallback;
}
