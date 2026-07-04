// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { DesktopScriptActionService, type DesktopAppActionResponse, type ScriptRun } from '../shared';
import type { DesktopAppSandbox } from '../app-framework/sandbox';
import { UserAccount, UserActionDraft, UserSSHKeysPayload, UsersPayload, type UserSSHKeysDTO, type UsersPayloadDTO } from './model';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';

export class UsersAppService {
  readonly serverID: string;
  private readonly actions: DesktopScriptActionService;
  private readonly sandbox: DesktopAppSandbox;
  constructor(serverID: string, sandbox: DesktopAppSandbox) { this.serverID = serverID; this.sandbox = sandbox; this.sandbox.assertServerID(serverID); this.actions = new DesktopScriptActionService('users', serverID, sandbox, 'script-actions'); }

  async list(): Promise<UsersPayload> {
    const response = await this.sandbox.fetch('/api/desktop-apps/users/data-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: this.serverID, args: { users_stream_format: 'row_events' }, confirmed: false }),
      requiredCapability: 'users',
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream user account data from this server.'));
    return UsersPayload.fromUnknown(await readUsersListStream(response));
  }

  async sshKeys(user: UserAccount): Promise<UserSSHKeysPayload> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    const response = await this.sandbox.fetch('/api/desktop-apps/users/data-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: this.serverID, args: { users_mode: 'ssh_keys', user_name: user.name, users_stream_format: 'row_events' }, confirmed: false }),
      signal: controller.signal,
      requiredCapability: 'users',
    }).catch((error: unknown) => {
      if (isAbortError(error)) throw new Error('ShellOrchestra did not receive authorized_keys data within 20 seconds. Check that this managed SSH connection is still healthy, then press Refresh.');
      throw error;
    });
    try {
      if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream SSH authorized keys from this server.'));
      return UserSSHKeysPayload.fromUnknown(await readUserSSHKeysStream(response, controller.signal));
    } catch (error) {
      if (isAbortError(error)) throw new Error('ShellOrchestra did not receive authorized_keys data within 20 seconds. Check that this managed SSH connection is still healthy, then press Refresh.');
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async act(draft: UserActionDraft): Promise<DesktopAppActionResponse> {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    return this.actions.run(draft.action, draft.toArgs(), true);
  }

  async waitForRun(runID: string): Promise<ScriptRun> {
    const started = Date.now();
    for (;;) {
      const run = await this.actions.runStatus(runID);
      if (run.state === 'succeeded' || run.state === 'failed') return run;
      if (Date.now() - started > 35000) throw new Error('User action did not finish in time.');
      await new Promise((resolve) => window.setTimeout(resolve, 900));
    }
  }
}

type UsersStreamEvent = {
  event?: string;
  data?: unknown;
};

async function readUsersListStream(response: Response): Promise<unknown> {
  let result: unknown;
  const payload: UsersPayloadDTO = { sessions: [], users: [] };
  const sessions: unknown[] = [];
  const users: unknown[] = [];
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'result') {
        const data = event.data && typeof event.data === 'object' ? event.data as { result?: unknown } : {};
        result = data.result ?? {};
        return;
      }
      if (event.event === 'meta' || event.event === 'done') {
        Object.assign(payload, flattenUsersStreamEvent(event as UsersStreamEvent));
        return;
      }
      if (event.event === 'row') {
        const row = normalizeUsersRow((event as UsersStreamEvent).data);
        if (row.kind === 'session') sessions.push(row.item);
        else if (row.kind === 'user') users.push(row.item);
      }
    },
  });
  await client.readNDJSON();
  if (result !== undefined) return result;
  payload.sessions = sessions as UsersPayloadDTO['sessions'];
  payload.users = users as UsersPayloadDTO['users'];
  return payload;
}

async function readUserSSHKeysStream(response: Response, signal?: AbortSignal): Promise<unknown> {
  let result: unknown;
  const payload: UserSSHKeysDTO = { keys: [] };
  const keys: unknown[] = [];
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'result') {
        const data = event.data && typeof event.data === 'object' ? event.data as { result?: unknown } : {};
        result = data.result ?? {};
        return;
      }
      if (event.event === 'meta' || event.event === 'done') {
        Object.assign(payload, flattenUserSSHKeysStreamEvent(event as UsersStreamEvent));
        return;
      }
      if (event.event === 'row') {
        const row = normalizeUsersRow((event as UsersStreamEvent).data);
        if (row.kind === 'ssh_key') keys.push(row.item);
      }
    },
  });
  await client.readNDJSON(signal);
  if (result !== undefined) return result;
  payload.keys = keys as UserSSHKeysDTO['keys'];
  return payload;
}

function normalizeUsersRow(value: unknown): { kind: 'user' | 'session' | 'ssh_key' | ''; item: unknown } {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const kind = data.kind === 'user' || data.kind === 'session' || data.kind === 'ssh_key' ? data.kind : '';
  return { kind, item: data.item && typeof data.item === 'object' ? data.item : data };
}

function flattenUsersStreamEvent(event: UsersStreamEvent): Partial<UsersPayloadDTO> {
  const result: Partial<UsersPayloadDTO> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event as Record<string, unknown>;
  for (const key of ['platform', 'manager', 'message'] as const) {
    const value = data[key];
    if (typeof value === 'string') result[key] = value;
  }
  const canManage = data.can_manage;
  if (typeof canManage === 'boolean') result.can_manage = canManage;
  return result;
}

function flattenUserSSHKeysStreamEvent(event: UsersStreamEvent): Partial<UserSSHKeysDTO> {
  const result: Partial<UserSSHKeysDTO> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event as Record<string, unknown>;
  for (const key of ['platform', 'manager', 'user', 'authorized_keys_path'] as const) {
    const value = data[key];
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = await response.clone().json().catch(() => ({})) as { error?: string };
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  const text = await response.clone().text().catch(() => '');
  return text.trim() || fallback;
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === 'AbortError';
}
