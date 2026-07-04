// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { DesktopScriptActionService } from '../shared';
import type { DesktopAppSandbox } from '../app-framework/sandbox';
import { ServiceActionDraft, ServiceDetailsPayload, ServiceLogsPayload, ServiceUnit, ServiceUnitFilePayload, ServicesPayload } from './model';
import { LogsPayload } from '../logs/model';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';

export class ServicesAppService {
  readonly serverID: string;
  private readonly actions: DesktopScriptActionService;
  private readonly sandbox: DesktopAppSandbox;
  constructor(serverID: string, sandbox: DesktopAppSandbox) { this.serverID = serverID; this.sandbox = sandbox; this.sandbox.assertServerID(serverID); this.actions = new DesktopScriptActionService('services', serverID, sandbox, 'script-actions'); }
  async list(filter = ''): Promise<ServicesPayload> {
    const response = await this.sandbox.fetch('/api/desktop-apps/services/data-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: this.serverID, args: { services_filter: filter, services_limit: '240', services_stream_format: 'row_events' }, confirmed: false }),
      requiredCapability: 'services',
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream services from this server.'));
    return ServicesPayload.fromUnknown(await readServicesStream(response));
  }
  async unitFile(unit: ServiceUnit): Promise<ServiceUnitFilePayload> {
    if (!unit.canRunAction()) throw new Error('Choose a real service first.');
    const data = await this.sandbox.runData({
      services_mode: 'unit_file',
      service_name: unit.name,
    }, 'services');
    return ServiceUnitFilePayload.fromUnknown(data.result);
  }
  async details(unit: ServiceUnit): Promise<ServiceDetailsPayload> {
    if (!unit.canRunAction()) throw new Error('Choose a real service first.');
    const data = await this.sandbox.runData({
      services_mode: 'details',
      service_name: unit.name,
    }, 'services');
    return ServiceDetailsPayload.fromUnknown(data.result);
  }
  async logs(serviceName: string): Promise<LogsPayload> {
    if (!/^[A-Za-z0-9@_. :\-]+(\.service)?$/.test(serviceName)) throw new Error('Choose a real service first.');
    const data = await this.sandbox.runData({
      services_mode: 'logs',
      service_name: serviceName,
      services_limit: '160',
    }, 'services');
    const payload = ServiceLogsPayload.fromUnknown(data.result);
    return LogsPayload.fromUnknown({
      generated_at: payload.generatedAt,
      source: payload.manager || 'services',
      unit: payload.service,
      entries: payload.logs.map((entry) => ({ timestamp: entry.timestamp, unit: payload.service, message: entry.message })),
    });
  }
  async act(draft: ServiceActionDraft) {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    return this.actions.run(draft.action, draft.toArgs(), true);
  }
}

type ServicesStreamEvent = {
  event?: string;
  data?: unknown;
  error?: string;
};

async function readServicesStream(response: Response): Promise<unknown> {
  let result: unknown;
  const payload: Record<string, unknown> = {
    generated_at: '',
    manager: 'unknown',
    services: [],
  };
  const rows: unknown[] = [];
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'result') {
        const data = event.data && typeof event.data === 'object' ? event.data as { result?: unknown } : {};
        result = data.result ?? {};
        return;
      }
      if (event.event === 'meta' || event.event === 'done') {
        Object.assign(payload, flattenServicesStreamEvent(event as ServicesStreamEvent));
        return;
      }
      if (event.event === 'row') {
        const data = (event as ServicesStreamEvent).data;
        if (data && typeof data === 'object') rows.push(data);
      }
    },
  });
  await client.readNDJSON();
  if (result !== undefined) return result;
  payload.services = rows;
  return payload;
}

function flattenServicesStreamEvent(event: ServicesStreamEvent): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'event' || key === 'transport' || key === 'services') continue;
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
