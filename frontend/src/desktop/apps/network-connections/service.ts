// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { DesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopScriptActionService, type ScriptRun } from '../shared';
import { NetworkConnectionsPayload, type NetworkConnectionsDTO } from './model';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';

export class NetworkConnectionsService {
  readonly serverID: string;
  private readonly actions: DesktopScriptActionService;
  private readonly sandbox: DesktopAppSandbox;
  constructor(serverID: string, sandbox: DesktopAppSandbox) { this.serverID = serverID; this.sandbox = sandbox; this.sandbox.assertServerID(serverID); this.actions = new DesktopScriptActionService('network_connections', serverID, sandbox, 'script-actions'); }
  async load(onProgress?: (payload: unknown) => void): Promise<NetworkConnectionsPayload> {
    const response = await this.sandbox.fetch('/api/desktop-apps/network_connections/data-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: this.serverID, args: { network_connections_stream_format: 'row_events' }, confirmed: false }),
      requiredCapability: 'network',
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream network connection data from this server.'));
    return NetworkConnectionsPayload.fromUnknown(await readNetworkConnectionsStream(response, onProgress));
  }
  async setHostname(hostname: string) {
    return this.actions.run('set_hostname', { network_action: 'set_hostname', network_hostname: hostname }, true);
  }
  async previewHostname(hostname: string): Promise<ScriptRun> {
    return this.preview('set_hostname', { network_action: 'set_hostname', network_hostname: hostname });
  }
  async setMTU(iface: string, mtu: string) {
    return this.actions.run('set_mtu', { network_action: 'set_mtu', network_interface: iface, network_mtu: mtu }, true);
  }
  async previewMTU(iface: string, mtu: string): Promise<ScriptRun> {
    return this.preview('set_mtu', { network_action: 'set_mtu', network_interface: iface, network_mtu: mtu });
  }
  async setDNS(iface: string, dns: string) {
    return this.actions.run('set_dns', { network_action: 'set_dns', network_interface: iface, network_dns: dns }, true);
  }
  async previewDNS(iface: string, dns: string): Promise<ScriptRun> {
    return this.preview('set_dns', { network_action: 'set_dns', network_interface: iface, network_dns: dns });
  }
  private async preview(action: string, args: Record<string, string>): Promise<ScriptRun> {
    const response = await this.actions.run(action, { ...args, dry_run: '1' }, false);
    const run = await this.actions.waitForRun(response.run.id, 35000, 700);
    if (run.state === 'failed') throw new Error(run.error || 'Network change preview failed.');
    return run;
  }
}

type NetworkConnectionsStreamEvent = {
  event?: string;
  data?: unknown;
};

async function readNetworkConnectionsStream(response: Response, onProgress?: (payload: unknown) => void): Promise<unknown> {
  let result: unknown;
  const payload: NetworkConnectionsDTO = { routes: [], adapters: [] };
  const routes: unknown[] = [];
  const adapters: unknown[] = [];
  const emitProgress = () => {
    onProgress?.({ ...payload, routes: [...routes] as NetworkConnectionsDTO['routes'], adapters: [...adapters] as NetworkConnectionsDTO['adapters'] });
  };
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'result') {
        const data = event.data && typeof event.data === 'object' ? event.data as { result?: unknown } : {};
        result = data.result ?? {};
        return;
      }
      if (event.event === 'meta' || event.event === 'done') {
        Object.assign(payload, flattenNetworkConnectionsStreamEvent(event as NetworkConnectionsStreamEvent));
        emitProgress();
        return;
      }
      if (event.event === 'row') {
        const row = normalizeNetworkConnectionsRow((event as NetworkConnectionsStreamEvent).data);
        if (row.kind === 'route') routes.push(row.item);
        else if (row.kind === 'adapter') adapters.push(row.item);
        if (routes.length + adapters.length === 1 || (routes.length + adapters.length) % 8 === 0) emitProgress();
      }
    },
  });
  await client.readNDJSON();
  if (result !== undefined) return result;
  payload.routes = routes as NetworkConnectionsDTO['routes'];
  payload.adapters = adapters as NetworkConnectionsDTO['adapters'];
  emitProgress();
  return payload;
}

function normalizeNetworkConnectionsRow(value: unknown): { kind: 'route' | 'adapter' | ''; item: unknown } {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const kind = data.kind === 'route' || data.kind === 'adapter' ? data.kind : '';
  return { kind, item: data.item && typeof data.item === 'object' ? data.item : data };
}

function flattenNetworkConnectionsStreamEvent(event: NetworkConnectionsStreamEvent): Partial<NetworkConnectionsDTO> {
  const result: Partial<NetworkConnectionsDTO> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event as Record<string, unknown>;
  for (const key of ['platform', 'manager', 'hostname', 'message'] as const) {
    const value = data[key];
    if (typeof value === 'string') result[key] = value;
  }
  for (const key of ['dns', 'dns_search_domains'] as const) {
    const value = data[key];
    if (Array.isArray(value)) result[key] = value.filter((item): item is string => typeof item === 'string');
  }
  const sshPath = data.ssh_path;
  if (sshPath && typeof sshPath === 'object') result.ssh_path = sshPath as NetworkConnectionsDTO['ssh_path'];
  return result;
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = await response.clone().json().catch(() => ({})) as { error?: string };
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  const text = await response.clone().text().catch(() => '');
  return text.trim() || fallback;
}
