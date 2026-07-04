// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { DesktopScriptActionService, type DesktopAppActionResponse, type ScriptRun } from '../shared';
import type { DesktopAppSandbox } from '../app-framework/sandbox';
import { ContainerActionDraft, ContainerInstallDraft, ContainerLogsDraft, ContainersPayload } from './model';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';

export class ContainersAppService {
  readonly serverID: string;
  private readonly sandbox: DesktopAppSandbox;
  private readonly actions: DesktopScriptActionService;
  private inventoryCache: ContainersPayload | null = null;
  constructor(serverID: string, sandbox: DesktopAppSandbox) { this.serverID = serverID; this.sandbox = sandbox; this.sandbox.assertServerID(serverID); this.actions = new DesktopScriptActionService('containers', serverID, sandbox, 'script-actions'); }
  async load(query = ''): Promise<ContainersPayload> {
    const args = {
      containers_query: query,
      containers_limit: '240',
      containers_known_state_token: query.trim() ? '' : this.inventoryCache?.stateToken ?? '',
      containers_stream_format: 'row_events',
    };
    const response = await this.sandbox.fetch('/api/desktop-apps/containers/data-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: this.serverID, args, confirmed: false }),
      requiredCapability: 'containers',
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream container data from this server.'));
    const payload = ContainersPayload.fromUnknown(await readContainersStream(response));
    if (!query.trim()) {
      if (payload.notModified && this.inventoryCache) {
        return this.inventoryCache.withRefreshMetadata(payload);
      }
      if (!payload.notModified && payload.stateToken) {
        this.inventoryCache = payload;
      }
    }
    return payload;
  }
  async act(draft: ContainerActionDraft): Promise<DesktopAppActionResponse> {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    return this.actions.run(draft.action, draft.toArgs(), true);
  }

  async preview(draft: ContainerActionDraft): Promise<ScriptRun> {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    const response = await this.actions.run(draft.action, { ...draft.toArgs(), dry_run: '1' }, false);
    const run = await this.actions.waitForRun(response.run.id, 45000, 700);
    if (run.state === 'failed') {
      throw new Error(run.error || `${draft.action} preview failed on the managed server.`);
    }
    return run;
  }

  async actAndWait(draft: ContainerActionDraft): Promise<DesktopAppActionResponse> {
    const response = await this.act(draft);
    const run = await this.actions.waitForRun(response.run.id, 45000, 900);
    if (run.state === 'failed') {
      throw new Error(run.error || `${draft.action} failed on the managed server.`);
    }
    return { ...response, run };
  }

  async previewInstall(draft: ContainerInstallDraft): Promise<ScriptRun> {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    const response = await this.actions.run('install', { ...draft.toArgs(), dry_run: '1' }, false);
    const run = await this.actions.waitForRun(response.run.id, 60000, 800);
    if (run.state === 'failed') {
      throw new Error(run.error || 'Container install preview failed on the managed server.');
    }
    return run;
  }

  async installAndWait(draft: ContainerInstallDraft): Promise<DesktopAppActionResponse> {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    const response = await this.actions.run('install', draft.toArgs(), true);
    const run = await this.actions.waitForRun(response.run.id, 300000, 1200);
    if (run.state === 'failed') {
      throw new Error(run.error || 'Container install failed on the managed server.');
    }
    return { ...response, run };
  }

  async logs(draft: ContainerLogsDraft): Promise<ScriptRun> {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    const response = await this.actions.run('logs', draft.toArgs(), false);
    const run = await this.actions.waitForRun(response.run.id, 45000, 900);
    if (run.state === 'failed') {
      throw new Error(run.error || 'Container log loading failed on the managed server.');
    }
    return run;
  }
}

type ContainersStreamEvent = {
  event?: string;
  data?: unknown;
  error?: string;
};

async function readContainersStream(response: Response): Promise<unknown> {
  let result: unknown;
  const payload: Record<string, unknown> = {
    generated_at: '',
    engine: 'unknown',
    engine_error: '',
    errors: [],
    query: '',
    state_token: '',
    not_modified: false,
    containers: [],
    images: [],
    volumes: [],
    networks: [],
  };
  const collections: Record<string, unknown[]> = {
    container: [],
    image: [],
    volume: [],
    network: [],
  };
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'result') {
        const data = event.data && typeof event.data === 'object' ? event.data as { result?: unknown } : {};
        result = data.result ?? {};
        return;
      }
      if (event.event === 'meta' || event.event === 'done') {
        Object.assign(payload, flattenContainersStreamEvent(event as ContainersStreamEvent));
        return;
      }
      if (event.event === 'row') {
        const data = (event as ContainersStreamEvent).data;
        if (!data || typeof data !== 'object') return;
        const record = data as { kind?: unknown; item?: unknown };
        const kind = typeof record.kind === 'string' ? record.kind : '';
        if (record.item && typeof record.item === 'object' && Object.prototype.hasOwnProperty.call(collections, kind)) {
          collections[kind].push(record.item);
        }
      }
    },
  });
  await client.readNDJSON();
  if (result !== undefined) return result;
  payload.containers = collections.container;
  payload.images = collections.image;
  payload.volumes = collections.volume;
  payload.networks = collections.network;
  return payload;
}

function flattenContainersStreamEvent(event: ContainersStreamEvent): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'event' || key === 'transport' || key === 'containers' || key === 'images' || key === 'volumes' || key === 'networks') continue;
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
