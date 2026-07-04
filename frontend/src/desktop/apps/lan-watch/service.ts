// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { DesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopScriptActionService, type ScriptRun } from '../shared';
import { LanWatchPayload, type LanWatchDTO } from './model';
import type { components } from '../../../api/schema';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';

type DesktopAppInstallResponse = components['schemas']['DesktopAppInstallResponse'];

export class LanWatchService {
  readonly serverID: string;
  private readonly sandbox: DesktopAppSandbox;
  private readonly actions: DesktopScriptActionService;
  constructor(serverID: string, sandbox: DesktopAppSandbox) { this.serverID = serverID; this.sandbox = sandbox; this.sandbox.assertServerID(serverID); this.actions = new DesktopScriptActionService('lan_watch', serverID, sandbox, 'script-actions'); }
  async load(options: { limit: number; noProbe: boolean }, onProgress?: (payload: unknown) => void): Promise<LanWatchPayload> {
    const response = await this.sandbox.fetch('/api/desktop-apps/lan_watch/data-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server_id: this.serverID,
        args: { lan_watch_limit: String(options.limit), lan_watch_no_probe: options.noProbe ? 'true' : 'false', lan_watch_stream_format: 'row_events' },
        confirmed: false,
      }),
      requiredCapability: 'network',
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream LAN Watch data from this server.'));
    return LanWatchPayload.fromUnknown(await readLanWatchStream(response, onProgress));
  }

  async installProbeBackend(): Promise<DesktopAppInstallResponse> {
    return this.sandbox.install('script-actions', true);
  }

  async installProbeBackendAndWait(): Promise<ScriptRun> {
    const response = await this.installProbeBackend();
    return this.actions.waitForRun(response.run.id, 90000);
  }
}

type LanWatchStreamEvent = {
  event?: string;
  data?: unknown;
};

async function readLanWatchStream(response: Response, onProgress?: (payload: unknown) => void): Promise<unknown> {
  let result: unknown;
  const payload: LanWatchDTO = { subnets: [], hosts: [] };
  const subnets: unknown[] = [];
  const hosts: unknown[] = [];
  const emitProgress = () => {
    onProgress?.({ ...payload, subnets: [...subnets] as LanWatchDTO['subnets'], hosts: [...hosts] as LanWatchDTO['hosts'] });
  };
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'result') {
        const data = event.data && typeof event.data === 'object' ? event.data as { result?: unknown } : {};
        result = data.result ?? {};
        return;
      }
      if (event.event === 'meta' || event.event === 'done') {
        Object.assign(payload, flattenLanWatchStreamEvent(event as LanWatchStreamEvent));
        emitProgress();
        return;
      }
      if (event.event === 'row') {
        const row = normalizeLanWatchRow((event as LanWatchStreamEvent).data);
        if (row.kind === 'subnet') subnets.push(row.item);
        else if (row.kind === 'host') hosts.push(row.item);
        if (hosts.length + subnets.length === 1 || (hosts.length > 0 && hosts.length % 6 === 0)) emitProgress();
      }
    },
  });
  await client.readNDJSON();
  if (result !== undefined) return result;
  payload.subnets = subnets as LanWatchDTO['subnets'];
  payload.hosts = hosts as LanWatchDTO['hosts'];
  emitProgress();
  return payload;
}

function normalizeLanWatchRow(value: unknown): { kind: 'subnet' | 'host' | ''; item: unknown } {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const kind = data.kind === 'subnet' || data.kind === 'host' ? data.kind : '';
  return { kind, item: data.item && typeof data.item === 'object' ? data.item : data };
}

function flattenLanWatchStreamEvent(event: LanWatchStreamEvent): Partial<LanWatchDTO> {
  const result: Partial<LanWatchDTO> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event as Record<string, unknown>;
  for (const key of ['generated_at', 'platform', 'source', 'probe_backend', 'probe_backend_message'] as const) {
    const value = data[key];
    if (typeof value === 'string') result[key] = value;
  }
  for (const key of ['limit', 'candidate_count', 'checked', 'remaining'] as const) {
    const value = data[key];
    if (typeof value === 'number') result[key] = value;
  }
  for (const key of ['no_probe', 'probe_backend_available', 'probe_backend_missing'] as const) {
    const value = data[key];
    if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = await response.clone().json().catch(() => ({})) as { error?: string };
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  const text = await response.clone().text().catch(() => '');
  return text.trim() || fallback;
}
