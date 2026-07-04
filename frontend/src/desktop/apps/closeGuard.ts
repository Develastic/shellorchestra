// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

export type DesktopWindowCloseGuard = {
  active: boolean;
  title: string;
  message: string;
  details?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

export function desktopWindowCloseGuardEqual(left: DesktopWindowCloseGuard | undefined, right: DesktopWindowCloseGuard | undefined): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.active === right.active
    && left.title === right.title
    && left.message === right.message
    && (left.details ?? '') === (right.details ?? '')
    && (left.confirmLabel ?? '') === (right.confirmLabel ?? '')
    && (left.cancelLabel ?? '') === (right.cancelLabel ?? '');
}
