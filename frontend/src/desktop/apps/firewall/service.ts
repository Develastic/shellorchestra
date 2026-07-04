// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { DesktopScriptActionService, type ScriptRun } from '../shared';
import type { DesktopAppSandbox } from '../app-framework/sandbox';
import type { components } from '../../../api/schema';
import { FirewallActionDraft, FirewallPayload, type FirewallDTO } from './model';
import { RemoteStreamClient, type RemoteStreamEvent } from '../../../streaming/RemoteStreamClient';

type DesktopAppInstallResponse = components['schemas']['DesktopAppInstallResponse'];

export class FirewallAppService {
  readonly serverID: string;
  private readonly actions: DesktopScriptActionService;
  private readonly sandbox: DesktopAppSandbox;
  constructor(serverID: string, sandbox: DesktopAppSandbox) { this.serverID = serverID; this.sandbox = sandbox; this.sandbox.assertServerID(serverID); this.actions = new DesktopScriptActionService('firewall', serverID, sandbox, 'script-actions'); }
  async load(): Promise<FirewallPayload> {
    const response = await this.sandbox.fetch('/api/desktop-apps/firewall/data-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server_id: this.serverID, args: { firewall_stream_format: 'row_events' }, confirmed: false }),
      requiredCapability: 'firewall',
    });
    if (!response.ok) throw new Error(await responseErrorMessage(response, 'ShellOrchestra could not stream firewall status from this server.'));
    return FirewallPayload.fromUnknown(await readFirewallStream(response));
  }
  async act(draft: FirewallActionDraft) {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    const response = await this.actions.run(draft.action, draft.toArgs(), true);
    const run = await this.actions.waitForRun(response.run.id, 90000);
    if (run.state === 'failed') {
      throw new Error(run.error || `${response.command} failed on the managed server.`);
    }
    return { ...response, run };
  }

  async install(): Promise<DesktopAppInstallResponse> {
    return this.sandbox.install('script-actions', true);
  }

  async installAndWait(): Promise<ScriptRun> {
    const response = await this.install();
    return this.actions.waitForRun(response.run.id, 90000);
  }
}

type FirewallStreamEvent = {
  event?: string;
  data?: unknown;
};

async function readFirewallStream(response: Response): Promise<unknown> {
  let result: unknown;
  const payload: FirewallDTO = {
    generated_at: '',
    manager: 'unknown',
    status_text: '',
    rules_text: '',
  };
  const ruleLines: string[] = [];
  const client = new RemoteStreamClient(response, {
    onEvent: (event: RemoteStreamEvent) => {
      if (event.event === 'result') {
        const data = event.data && typeof event.data === 'object' ? event.data as { result?: unknown } : {};
        result = data.result ?? {};
        return;
      }
      if (event.event === 'meta' || event.event === 'done') {
        Object.assign(payload, flattenFirewallStreamEvent(event as FirewallStreamEvent));
        return;
      }
      if (event.event === 'row') {
        const raw = firewallRuleLine((event as FirewallStreamEvent).data);
        if (raw) ruleLines.push(raw);
      }
    },
  });
  await client.readNDJSON();
  if (result !== undefined) return result;
  payload.rules_text = ruleLines.join('\n');
  return payload;
}

function flattenFirewallStreamEvent(event: FirewallStreamEvent): Partial<FirewallDTO> {
  const result: Partial<FirewallDTO> = {};
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : event as Record<string, unknown>;
  for (const key of ['generated_at', 'manager', 'status_text'] as const) {
    const value = data[key];
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

function firewallRuleLine(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const raw = data.raw;
  if (typeof raw === 'string') return raw.trim();
  const item = data.item && typeof data.item === 'object' ? data.item as Record<string, unknown> : {};
  if (typeof item.raw === 'string') return item.raw.trim();
  return '';
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = await response.clone().json().catch(() => ({})) as { error?: string };
  if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
  const text = await response.clone().text().catch(() => '');
  return text.trim() || fallback;
}
