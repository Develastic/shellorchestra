// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { DesktopAppSandbox } from '../app-framework/sandbox';
import { DesktopScriptActionService, type ScriptRun } from '../shared';
import { SSHServerActionResult, SSHServerConfigDraft, SSHServerPayload, SSHServerRollbackDraft } from './model';

export class SSHServerService {
  readonly serverID: string;
  private readonly sandbox: DesktopAppSandbox;
  private readonly actions: DesktopScriptActionService;

  constructor(serverID: string, sandbox: DesktopAppSandbox) {
    this.serverID = serverID;
    this.sandbox = sandbox;
    this.sandbox.assertServerID(serverID);
    this.actions = new DesktopScriptActionService('ssh_server', serverID, sandbox, 'script-actions');
  }

  async load(): Promise<SSHServerPayload> {
    const data = await this.sandbox.runData({}, 'ssh-server');
    return SSHServerPayload.fromUnknown(data.result);
  }

  async validate(draft: SSHServerConfigDraft): Promise<SSHServerActionResult> {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    const response = await this.actions.run('validate', draft.toArgs('validate'), false);
    return this.waitForAction(response.run.id, 'OpenSSH validation failed on the managed server.');
  }

  async apply(draft: SSHServerConfigDraft): Promise<SSHServerActionResult> {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    const response = await this.actions.run('apply', draft.toArgs('apply'), true);
    return this.waitForAction(response.run.id, 'OpenSSH config apply failed on the managed server.');
  }

  async rollback(draft: SSHServerRollbackDraft): Promise<SSHServerActionResult> {
    const validation = draft.validate();
    if (validation) throw new Error(validation);
    const response = await this.actions.run('rollback', draft.toArgs(), true);
    return this.waitForAction(response.run.id, 'OpenSSH rollback failed on the managed server.');
  }

  private async waitForAction(runID: string, fallback: string): Promise<SSHServerActionResult> {
    const run: ScriptRun = await this.actions.waitForRun(runID, 90000, 900);
    if (run.state === 'failed') throw new Error(run.error || fallback);
    return SSHServerActionResult.fromUnknown(run.result);
  }
}
