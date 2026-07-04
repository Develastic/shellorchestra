// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type TerminalSpecialKey =
  | 'Escape'
  | 'Tab'
  | 'Backspace'
  | 'Insert'
  | 'Delete'
  | 'Enter'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown'
  | `F${number}`;

const functionKeySequences: Record<string, string> = Object.freeze({
  F1: '\x1bOP',
  F2: '\x1bOQ',
  F3: '\x1bOR',
  F4: '\x1bOS',
  F5: '\x1b[15~',
  F6: '\x1b[17~',
  F7: '\x1b[18~',
  F8: '\x1b[19~',
  F9: '\x1b[20~',
  F10: '\x1b[21~',
  F11: '\x1b[23~',
  F12: '\x1b[24~',
});

export function terminalSpecialKeySequence(key: TerminalSpecialKey): string {
  if (key.startsWith('F')) {
    return functionKeySequences[key] ?? '';
  }
  switch (key) {
    case 'Escape':
      return '\x1b';
    case 'Tab':
      return '\t';
    case 'Backspace':
      return '\x7f';
    case 'Insert':
      return '\x1b[2~';
    case 'Delete':
      return '\x1b[3~';
    case 'Enter':
      return '\r';
    case 'ArrowUp':
      return '\x1b[A';
    case 'ArrowDown':
      return '\x1b[B';
    case 'ArrowRight':
      return '\x1b[C';
    case 'ArrowLeft':
      return '\x1b[D';
    case 'Home':
      return '\x1b[H';
    case 'End':
      return '\x1b[F';
    case 'PageUp':
      return '\x1b[5~';
    case 'PageDown':
      return '\x1b[6~';
    default:
      return '';
  }
}

export function terminalCtrlSequence(value: string): string {
  if (value.length !== 1) return '';
  const lower = value.toLowerCase();
  if (lower >= 'a' && lower <= 'z') {
    return String.fromCharCode(lower.charCodeAt(0) - 96);
  }
  switch (value) {
    case '[':
      return '\x1b';
    case ']':
      return '\x1d';
    case '\\':
      return '\x1c';
    case '^':
      return '\x1e';
    case '_':
      return '\x1f';
    case '?':
      return '\x7f';
    default:
      return '';
  }
}

export function terminalAltSequence(value: string): string {
  return value ? `\x1b${value}` : '';
}
