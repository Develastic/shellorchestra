// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import AppsIcon from '@mui/icons-material/Apps';
import BuildIcon from '@mui/icons-material/Build';
import DashboardIcon from '@mui/icons-material/Dashboard';
import DescriptionIcon from '@mui/icons-material/Description';
import EditIcon from '@mui/icons-material/Edit';
import EventNoteIcon from '@mui/icons-material/EventNote';
import FolderIcon from '@mui/icons-material/Folder';
import HubIcon from '@mui/icons-material/Hub';
import MemoryIcon from '@mui/icons-material/Memory';
import PeopleAltIcon from '@mui/icons-material/PeopleAlt';
import SettingsEthernetIcon from '@mui/icons-material/SettingsEthernet';
import ShieldIcon from '@mui/icons-material/Shield';
import SpeedIcon from '@mui/icons-material/Speed';
import StorageIcon from '@mui/icons-material/Storage';
import TableChartIcon from '@mui/icons-material/TableChart';
import TerminalIcon from '@mui/icons-material/Terminal';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import type { SvgIconProps } from '@mui/material/SvgIcon';

export function DesktopAppIconGlyph({ icon, ...props }: { icon?: string } & SvgIconProps) {
  switch ((icon ?? '').trim()) {
    case 'packages':
      return <AppsIcon {...props} />;
    case 'files':
      return <FolderIcon {...props} />;
    case 'processes':
    case 'monitor':
      return <MemoryIcon {...props} />;
    case 'docker':
      return <DashboardIcon {...props} />;
    case 'logs':
      return <EventNoteIcon {...props} />;
    case 'services':
      return <BuildIcon {...props} />;
    case 'network':
      return <SettingsEthernetIcon {...props} />;
    case 'connections':
      return <HubIcon {...props} />;
    case 'lan_watch':
      return <TravelExploreIcon {...props} />;
    case 'users':
      return <PeopleAltIcon {...props} />;
    case 'schedule':
      return <EventNoteIcon {...props} />;
    case 'security':
    case 'firewall':
      return <ShieldIcon {...props} />;
    case 'storage':
      return <StorageIcon {...props} />;
    case 'document':
      return <DescriptionIcon {...props} />;
    case 'spreadsheet':
      return <TableChartIcon {...props} />;
    case 'speed':
      return <SpeedIcon {...props} />;
    case 'edit':
      return <EditIcon {...props} />;
    case 'terminal':
    default:
      return <TerminalIcon {...props} />;
  }
}
