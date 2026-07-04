// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { RuntimeUnlockDebugEvent, RuntimeUnlockDebugOptions } from '../security/deviceShareVault';
import { sendClientDebugEvent } from './clientDebugLog';

export function runtimeUnlockDebugOptions(
  source: string,
  enabled: boolean,
  onEvent?: (event: RuntimeUnlockDebugEvent) => void,
): RuntimeUnlockDebugOptions | undefined {
  if (!enabled) return undefined;
  return {
    enabled: true,
    onEvent: (event) => {
      onEvent?.(event);
      sendClientDebugEvent(source, event, true);
    },
  };
}
