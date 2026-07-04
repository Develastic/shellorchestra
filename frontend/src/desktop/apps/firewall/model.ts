// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type FirewallDTO = { generated_at?: string; manager?: string; status_text?: string; rules_text?: string };
export type FirewallAction = 'enable' | 'disable' | 'add_rule' | 'delete_rule';
export type FirewallRuleRow = {
  id: string;
  identifier: string;
  target: string;
  action: string;
  source: string;
  details: string;
  raw: string;
};

export class FirewallPayload {
  readonly generatedAt: string;
  readonly manager: string;
  readonly statusText: string;
  readonly rulesText: string;

  constructor(dto: FirewallDTO) {
    this.generatedAt = typeof dto.generated_at === 'string' ? dto.generated_at : '';
    this.manager = typeof dto.manager === 'string' && dto.manager ? dto.manager : 'unknown';
    this.statusText = typeof dto.status_text === 'string' ? dto.status_text : '';
    this.rulesText = typeof dto.rules_text === 'string' ? dto.rules_text : '';
  }

  static fromUnknown(value: unknown): FirewallPayload {
    if (!value || typeof value !== 'object') return new FirewallPayload({});
    return new FirewallPayload(value as FirewallDTO);
  }

  updatedLabel(): string {
    if (!this.generatedAt) return '—';
    const date = new Date(this.generatedAt);
    if (Number.isNaN(date.getTime())) return this.generatedAt;
    return date.toLocaleTimeString();
  }

  enabledLabel(): string {
    if (!this.isSupportedManager()) return 'Unsupported';
    if (this.isEnabled()) return 'Enabled';
    if (this.isDisabled()) return 'Disabled';
    return 'Unknown';
  }

  isUfw(): boolean {
    return this.manager === 'ufw';
  }

  isWindowsNetSecurity(): boolean {
    return this.manager === 'windows_netsecurity';
  }

  isMacOSApplicationFirewall(): boolean {
    return this.manager === 'macos_application_firewall';
  }

  isSupportedManager(): boolean {
    return this.isUfw() || this.isWindowsNetSecurity() || this.isMacOSApplicationFirewall();
  }

  managerLabel(): string {
    if (this.isUfw()) return 'UFW';
    if (this.isWindowsNetSecurity()) return 'Windows Firewall';
    if (this.isMacOSApplicationFirewall()) return 'macOS Application Firewall';
    return this.manager;
  }

  isEnabled(): boolean {
    if (this.isWindowsNetSecurity()) return /enabled:\s*true/im.test(this.statusText);
    if (this.isMacOSApplicationFirewall()) return /enabled|firewall is enabled|state\s*=\s*1/im.test(this.statusText);
    return /^status:\s+active\b/im.test(this.statusText);
  }

  isDisabled(): boolean {
    if (this.isWindowsNetSecurity()) return /enabled:\s*false/im.test(this.statusText) && !/enabled:\s*true/im.test(this.statusText);
    if (this.isMacOSApplicationFirewall()) return /disabled|firewall is disabled|state\s*=\s*0/im.test(this.statusText);
    return /^status:\s+inactive\b/im.test(this.statusText);
  }

  hasIncomingSSHRule(sshPort: number): boolean {
    const port = Number.isFinite(sshPort) && sshPort > 0 ? Math.trunc(sshPort) : 22;
    const haystack = `${this.statusText}\n${this.rulesText}`;
    return haystack.split(/\r?\n/).some((line) => firewallRuleAllowsIncomingSSH(line, port));
  }

  hasDeletableRule(): boolean {
    if (this.isUfw()) return this.ruleRows().some((row) => /^[0-9]+$/.test(row.identifier));
    if (this.isWindowsNetSecurity()) return this.rulesText.trim().length > 0;
    return false;
  }

  ruleRows(): FirewallRuleRow[] {
    if (this.isUfw()) return parseUfwNumberedRules(this.rulesText);
    if (this.isWindowsNetSecurity()) return parseWindowsFirewallRules(this.rulesText);
    return [];
  }
}

function firewallRuleAllowsIncomingSSH(line: string, sshPort: number): boolean {
  const normalized = line.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized || !/\ballow\b|\[allow\]/.test(normalized)) return false;
  if (!normalized.includes(' in ') && !/\ballow\s+in\b/.test(normalized) && !/\[allow\]/.test(normalized)) return false;
  if (sshPort === 22 && /\bopenssh\b/.test(normalized)) return true;
  const escapedPort = String(sshPort).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^0-9])${escapedPort}(/tcp)?([^0-9]|$)`).test(normalized);
}

function parseUfwNumberedRules(rulesText: string): FirewallRuleRow[] {
  const rows: FirewallRuleRow[] = [];
  for (const line of rulesText.split(/\r?\n/)) {
    const match = line.match(/^\s*\[\s*([0-9]+)\]\s+(.+?)\s*$/);
    if (!match) continue;
    const identifier = match[1] ?? '';
    const remainder = match[2] ?? '';
    const columns = remainder.split(/\s{2,}/).map((column) => column.trim()).filter(Boolean);
    const target = columns[0] ?? remainder.trim();
    const action = columns[1] ?? '';
    const source = columns.slice(2).join('  ');
    rows.push({
      id: `ufw-${identifier}`,
      identifier,
      target,
      action,
      source,
      details: source,
      raw: line.trim(),
    });
  }
  return rows;
}

function parseWindowsFirewallRules(rulesText: string): FirewallRuleRow[] {
  const rows: FirewallRuleRow[] = [];
  for (const line of rulesText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pipeRow = parseWindowsPipeRule(trimmed, rows.length);
    if (pipeRow) {
      rows.push(pipeRow);
      continue;
    }
    const readableRow = parseWindowsReadableRule(trimmed, rows.length);
    if (readableRow) {
      rows.push(readableRow);
    }
  }
  return rows;
}

function parseWindowsPipeRule(trimmed: string, index: number): FirewallRuleRow | null {
  const parts = trimmed.split('|').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const fields = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    fields.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }
  const name = parts[0] ?? '';
  const action = fields.get('action') ?? '';
  const direction = fields.get('direction') ?? '';
  const port = fields.get('localport') ?? '';
  const enabled = fields.get('enabled') ?? '';
  return {
    id: `windows-${index + 1}`,
    identifier: name,
    target: port ? `TCP ${port}` : name,
    action: [action, direction].filter(Boolean).join(' '),
    source: enabled ? `Enabled=${enabled}` : '',
    details: parts.slice(1).join(' | '),
    raw: trimmed,
  };
}

function parseWindowsReadableRule(trimmed: string, index: number): FirewallRuleRow | null {
  const match = trimmed.match(/^(.+?)\s+\[(Allow|Block)\]\s+([A-Za-z]+)\s+(.+?)\s+(In|Out)\s*$/i);
  if (!match) return null;
  const name = (match[1] ?? '').trim();
  const action = (match[2] ?? '').trim();
  const protocol = (match[3] ?? '').trim();
  const port = (match[4] ?? '').trim();
  const direction = (match[5] ?? '').trim();
  if (!name || !action || !protocol || !direction) return null;
  return {
    id: `windows-${index + 1}`,
    identifier: name,
    target: `${protocol} ${port}`.trim(),
    action: `${action} ${direction}`.trim(),
    source: '',
    details: `${protocol} ${port} ${direction}`.trim(),
    raw: trimmed,
  };
}

export class FirewallActionDraft {
  readonly action: FirewallAction;
  readonly rule: string;
  readonly ruleNumber: string;
  readonly sshPort: number;
  readonly manager: string;

  constructor(action: FirewallAction, rule: string, ruleNumber: string, sshPort: number, manager = '') {
    this.action = action;
    this.rule = rule.trim();
    this.ruleNumber = ruleNumber.trim();
    this.sshPort = sshPort;
    this.manager = manager.trim();
  }

  validate(): string | null {
    if (this.action === 'add_rule' && !/^[A-Za-z0-9._:/ -]{1,160}$/.test(this.rule)) return 'Enter a safe firewall rule, for example: allow 443/tcp.';
    if (this.action === 'delete_rule' && this.manager === 'windows_netsecurity' && !/^[A-Za-z0-9 ._:/()[\]-]{1,160}$/.test(this.ruleNumber)) return 'Enter the exact Windows rule display name shown in the rules list.';
    if (this.action === 'delete_rule' && this.manager !== 'windows_netsecurity' && !/^[0-9]+$/.test(this.ruleNumber)) return 'Enter the numeric rule number shown by UFW.';
    return null;
  }

  toArgs(): Record<string, string> {
    return { firewall_action: this.action, firewall_rule: this.rule, firewall_rule_number: this.ruleNumber, ssh_port: String(this.sshPort || 22) };
  }
}
