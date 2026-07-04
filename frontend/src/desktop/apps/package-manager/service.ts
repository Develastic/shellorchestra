// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { DesktopScriptActionService, type ScriptRun } from '../shared';
import type { DesktopAppSandbox } from '../app-framework/sandbox';
import { PackageManagerPayload, type PackageManagerAction, type PackageMutationDraft } from './model';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';

export class PackageManagerService {
  readonly serverID: string;
  private readonly actions: DesktopScriptActionService;
  private readonly sandbox: DesktopAppSandbox;
  private installedCache: PackageManagerPayload | null = null;

  constructor(serverID: string, sandbox: DesktopAppSandbox) {
    this.serverID = serverID;
    this.sandbox = sandbox;
    this.sandbox.assertServerID(serverID);
    this.actions = new DesktopScriptActionService('package_manager', serverID, sandbox, 'script-actions');
  }

  async load(action: PackageManagerAction, query = ''): Promise<PackageManagerPayload> {
    const payload = PackageManagerPayload.fromUnknown(await this.loadStream(action, query));
    if (action === 'installed' && !query.trim()) {
      if (payload.notModified && this.installedCache) {
        return this.installedCache.withRefreshMetadata(payload);
      }
      if (!payload.notModified && payload.stateToken) {
        this.installedCache = payload;
      }
    }
    return payload;
  }

  private async loadStream(action: PackageManagerAction, query = ''): Promise<Record<string, unknown>> {
    const args: Record<string, string> = {
      package_action: action,
      package_query: query,
      package_limit: action === 'installed' ? '80' : action === 'security' ? '120' : '80',
      package_known_state_token: action === 'installed' && !query.trim() ? this.installedCache?.stateToken ?? '' : '',
      package_stream_format: 'row_events',
    };
    const response = await this.sandbox.fetch('/api/desktop-apps/package_manager/data-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: this.serverID, args, confirmed: false }),
      requiredCapability: 'packages',
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not load package data through the managed target.'));
    return readPackageManagerNDJSON(response, action, query);
  }

  async updateMetadata(manager: string): Promise<ScriptRun> {
    const response = await this.actions.run('metadata_update', { package_manager: manager || 'auto' }, true);
    const run = await this.actions.waitForRun(response.run.id, 180000, 1200);
    if (run.state === 'failed') throw new Error(run.error || 'Package repository metadata update failed.');
    return run;
  }

  async upgrade() {
    return this.actions.run('upgrade', {}, true);
  }

  async previewUpgrade(): Promise<ScriptRun> {
    return this.preview('upgrade', {});
  }

  async install(draft: PackageMutationDraft) {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    return this.actions.run('install', draft.toArgs(), true);
  }

  async previewInstall(draft: PackageMutationDraft): Promise<ScriptRun> {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    return this.preview('install', draft.toArgs());
  }

  async remove(draft: PackageMutationDraft) {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    return this.actions.run('remove', draft.toArgs(), true);
  }

  async previewRemove(draft: PackageMutationDraft): Promise<ScriptRun> {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    return this.preview('remove', draft.toArgs());
  }

  private async preview(action: string, args: Record<string, string>): Promise<ScriptRun> {
    const response = await this.actions.run(action, { ...args, dry_run: '1' }, false);
    const run = await this.actions.waitForRun(response.run.id, 45000, 700);
    if (run.state === 'failed') throw new Error(run.error || 'Package change preview failed.');
    return run;
  }
}

type PackageManagerStreamEvent = Record<string, unknown> & {
  event?: 'meta' | 'row' | 'done' | 'result' | 'error' | string;
  data?: unknown;
  error?: unknown;
};

async function readPackageManagerNDJSON(response: Response, action: PackageManagerAction, query: string): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    generated_at: '',
    manager: 'unknown',
    action,
    query,
    packages: [],
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
      Object.assign(payload, flattenPackageManagerStreamEvent(event as PackageManagerStreamEvent));
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
  payload.packages = rows;
  return payload;
}

function flattenPackageManagerStreamEvent(event: PackageManagerStreamEvent): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'event' || key === 'transport' || key === 'packages') continue;
    result[key] = value;
  }
  return result;
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = await response.clone().json().catch(() => ({})) as { error?: string };
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  const text = await response.clone().text().catch(() => '');
  return text.trim() || fallback;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
