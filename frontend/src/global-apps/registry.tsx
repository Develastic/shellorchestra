// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import PlaylistPlayIcon from '@mui/icons-material/PlaylistPlay';
import BackupIcon from '@mui/icons-material/Backup';
import HubIcon from '@mui/icons-material/Hub';

export type GlobalAppDefinition = {
  id: string;
  label: string;
  route: string;
  description: string;
  icon: typeof PlaylistPlayIcon;
  edition: 'community' | 'pro' | 'business' | 'enterprise';
};

export const globalAppDefinitions = [
  {
    id: 'batch-script',
    label: 'Batch Script',
    route: '/global-apps/batch-script',
    description: 'Run reusable scripts across selected managed servers with per-platform variants, preflight checks, and run history.',
    icon: PlaylistPlayIcon,
    edition: 'community',
  },
  {
    id: 'backup-manager',
    label: 'Backup Manager',
    route: '/global-apps/backup-manager',
    description: 'Create backup buckets, define backup tasks, test excludes, and run server-side archives with visible rotation policy.',
    icon: BackupIcon,
    edition: 'community',
  },
  {
    id: 'ssh-tunnels',
    label: 'SSH Tunnels',
    route: '/global-apps/ssh-tunnels',
    description: 'Manage backend-side TCP forwards and SOCKS proxies through ShellOrchestra managed SSH connections.',
    icon: HubIcon,
    edition: 'pro',
  },
] satisfies GlobalAppDefinition[];

export function globalAppByID(id: string): GlobalAppDefinition | undefined {
  return globalAppDefinitions.find((app) => app.id === id);
}
