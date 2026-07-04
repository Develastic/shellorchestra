// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { debugSupportCompiled } from '../debug/buildFlags';
import type { UISettings } from '../settings/uiSettings';

export type TerminalKeymapLayout = UISettings['terminal_keymap_layout'];

export type TerminalKeymapLayoutOption = {
  value: TerminalKeymapLayout;
  label: string;
};

export const terminalKeymapLayoutOptions: TerminalKeymapLayoutOption[] = debugSupportCompiled
  ? [
      { value: 'en', label: 'EN command-friendly' },
      { value: 'ru', label: 'RU Cyrillic helper' },
    ]
  : [
      { value: 'en', label: 'EN command-friendly' },
    ];

export function normalizeTerminalKeymapLayout(value: TerminalKeymapLayout | string | null | undefined): TerminalKeymapLayout {
  if (debugSupportCompiled && value === 'ru') return 'ru';
  return 'en';
}

export function terminalKeymapLayoutHelperText(): string {
  return debugSupportCompiled
    ? 'EN repairs accidental Cyrillic input; RU maps Latin keys to Cyrillic.'
    : 'Production builds keep the command-friendly EN helper only.';
}
