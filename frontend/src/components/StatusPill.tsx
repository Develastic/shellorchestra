// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import Chip from '@mui/material/Chip';

const colors: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  connected: 'success',
  connecting: 'info',
  retrying_network: 'warning',
  blocked_auth: 'error',
  blocked_config: 'error',
  jump_unavailable: 'warning',
  locked: 'warning',
  host_key_required: 'warning',
  host_key_mismatch: 'error',
  failed: 'error',
  disconnected: 'default',
};

export function StatusPill({ state }: { state: string }) {
  return <Chip size="small" color={colors[state] ?? 'default'} label={state.replaceAll('_', ' ')} />;
}
