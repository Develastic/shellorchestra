// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { DesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopScriptActionService, type DesktopAppActionResponse, type ScriptRun } from '../shared';
import { CronEditorPayload, CronEditorSaveDraft, safeUserName, type CronPayloadDTO, type CronUserDTO } from './model';
import type { components } from '../../../api/schema';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';

type DesktopAppInstallResponse = components['schemas']['DesktopAppInstallResponse'];

export class CronEditorService {
  readonly serverID: string;
  private readonly sandbox: DesktopAppSandbox;
  private readonly actions: DesktopScriptActionService;
  constructor(serverID: string, sandbox: DesktopAppSandbox) {
    this.serverID = serverID;
    this.sandbox = sandbox;
    this.sandbox.assertServerID(serverID);
    this.actions = new DesktopScriptActionService('cron_editor', serverID, sandbox, 'script-actions');
  }

  async users(): Promise<CronEditorPayload> {
    return this.run({ cron_mode: 'users' }, 'Cron users could not be loaded.');
  }

  async read(user: string): Promise<CronEditorPayload> {
    if (!safeUserName(user)) throw new Error('Choose a valid user before reading crontab.');
    return this.run({ cron_mode: 'read', cron_user: user }, 'Crontab could not be loaded.');
  }

  async validate(draft: CronEditorSaveDraft): Promise<CronEditorPayload> {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    return this.run(draft.toValidationArgs(), 'Crontab could not be validated.');
  }

  async save(draft: CronEditorSaveDraft): Promise<DesktopAppActionResponse> {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    return this.actions.run('save', draft.toArgs(), true);
  }

  async saveAndWait(draft: CronEditorSaveDraft): Promise<ScriptRun> {
    const response = await this.save(draft);
    const run = await this.actions.waitForRun(response.run.id, 90000);
    if (run.state === 'failed') throw new Error(cronSaveFailureMessage(run.error));
    return run;
  }

  async install(): Promise<DesktopAppInstallResponse> {
    return this.sandbox.install('script-actions', true);
  }

  async installAndWait(): Promise<ScriptRun> {
    const response = await this.install();
    return this.actions.waitForRun(response.run.id, 90000);
  }

  private async run(args: Record<string, string>, fallback: string): Promise<CronEditorPayload> {
    try {
      const streamArgs = shouldStreamCronData(args) ? { ...args, cron_stream_format: 'row_events' } : args;
      if (!shouldStreamCronData(args)) {
        const data = await this.sandbox.runData(streamArgs, 'cron');
        return CronEditorPayload.fromUnknown(data.result);
      }
      const response = await this.sandbox.fetch('/api/desktop-apps/cron_editor/data-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server_id: this.serverID, args: streamArgs, confirmed: false }),
        requiredCapability: 'cron',
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response, fallback));
      return CronEditorPayload.fromUnknown(await readCronStream(response));
    } catch (error) {
      if (error instanceof Error && error.message) throw error;
      throw new Error(fallback);
    }
  }
}

type CronStreamEvent = {
  event?: string;
  data?: unknown;
};

async function readCronStream(response: Response): Promise<unknown> {
  let result: unknown;
  const payload: CronPayloadDTO = { available: true, users: [] };
  const users: CronUserDTO[] = [];
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'result') {
        const data = event.data && typeof event.data === 'object' ? event.data as { result?: unknown } : {};
        result = data.result ?? {};
        return;
      }
      if (event.event === 'meta' || event.event === 'done') {
        Object.assign(payload, flattenCronStreamEvent(event as CronStreamEvent));
        return;
      }
      if (event.event === 'row') {
        const row = normalizeCronRow((event as CronStreamEvent).data);
        if (row.kind === 'user') users.push(row.item as CronUserDTO);
        else if (row.kind === 'crontab') Object.assign(payload, row.item);
      }
    },
  });
  await client.readNDJSON();
  if (result !== undefined) return result;
  if (users.length) payload.users = users;
  return payload;
}

function shouldStreamCronData(args: Record<string, string>): boolean {
  const mode = (args.cron_mode || 'users').trim();
  return mode === 'users' || mode === 'read';
}

function normalizeCronRow(value: unknown): { kind: 'user' | 'crontab' | ''; item: unknown } {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const kind = data.kind === 'user' || data.kind === 'crontab' ? data.kind : '';
  return { kind, item: data.item && typeof data.item === 'object' ? data.item : data };
}

function flattenCronStreamEvent(event: CronStreamEvent): Partial<CronPayloadDTO> {
  const result: Partial<CronPayloadDTO> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event as Record<string, unknown>;
  for (const key of ['mode', 'message', 'current_user', 'user', 'content'] as const) {
    const value = data[key];
    if (typeof value === 'string') result[key] = value;
  }
  for (const key of ['available', 'exists', 'saved', 'valid'] as const) {
    const value = data[key];
    if (typeof value === 'boolean') result[key] = value;
  }
  const entries = data.entries;
  if (typeof entries === 'number' && Number.isFinite(entries)) result.entries = entries;
  return result;
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = await response.clone().json().catch(() => ({})) as { error?: string };
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  const text = await response.clone().text().catch(() => '');
  return text.trim() || fallback;
}

export function cronSaveFailureMessage(error: string | null | undefined): string {
  const detail = stripProcessPrefix(String(error ?? '').trim());
  if (!detail) return 'ShellOrchestra could not save this crontab because the managed server rejected the operation.';
  if (/Root privileges are required to manage another user's crontab/i.test(detail)) {
    return "ShellOrchestra could not save this crontab because the SSH login account does not have root privileges for the selected user. Choose this SSH login account's own crontab, or grant sudo/doas/root access before managing another user's crontab.";
  }
  if (/permission denied|not allowed|sudo|doas|must be root|requires root/i.test(detail)) {
    return `ShellOrchestra could not save this crontab because the managed server rejected the permission check: ${detail}`;
  }
  return `ShellOrchestra could not save this crontab: ${detail}`;
}

function stripProcessPrefix(value: string): string {
  return value
    .replace(/^Process exited with status \d+:\s*/i, '')
    .replace(/^ssh:\s*/i, '')
    .trim();
}
