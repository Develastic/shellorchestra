// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { ReactNode } from 'react';

export type DesktopAppActionTone = 'default' | 'primary' | 'warning' | 'danger';

export type DesktopAppActionConfig = {
  id: string;
  label: string;
  icon: ReactNode;
  group?: string;
  groupLabel?: string;
  spacerBefore?: boolean;
  tooltip?: string;
  disabled?: boolean;
  disabledReason?: string;
  tone?: DesktopAppActionTone;
  run: () => void;
};

export class DesktopAppAction {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly group: string;
  readonly groupLabel: string;
  readonly spacerBefore: boolean;
  readonly tooltip: string;
  readonly disabled: boolean;
  readonly disabledReason: string;
  readonly tone: DesktopAppActionTone;
  readonly run: () => void;

  constructor(config: DesktopAppActionConfig) {
    this.id = sanitizeActionID(config.id);
    this.label = config.label.trim() || this.id;
    this.icon = config.icon;
    this.group = (config.group || '').trim();
    this.groupLabel = (config.groupLabel || '').trim();
    this.spacerBefore = Boolean(config.spacerBefore);
    this.tooltip = (config.tooltip || config.label).trim();
    this.disabled = Boolean(config.disabled);
    this.disabledReason = (config.disabledReason || '').trim();
    this.tone = config.tone || 'default';
    this.run = config.run;
  }

  get hint(): string {
    if (this.disabled && this.disabledReason) return this.disabledReason;
    return this.tooltip;
  }

  get enabled(): boolean {
    return !this.disabled;
  }
}

export class DesktopAppActionList {
  readonly actions: DesktopAppAction[];

  constructor(actions: DesktopAppActionConfig[]) {
    this.actions = actions.map((action) => new DesktopAppAction(action)).filter((action) => action.id);
  }

  get length(): number {
    return this.actions.length;
  }

  byID(id: string): DesktopAppAction | undefined {
    const normalized = sanitizeActionID(id);
    return this.actions.find((action) => action.id === normalized);
  }

  enabled(id: string): boolean {
    return Boolean(this.byID(id)?.enabled);
  }
}

function sanitizeActionID(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);
}
