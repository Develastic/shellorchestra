// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import type { ReactNode } from 'react';
import Stack from '@mui/material/Stack';
import type { DesktopAppActionList } from './actionList';
import { DesktopAppToolbar } from './AppToolbar';

export function DesktopAppFrame({
  actions,
  infoTitle,
  onInfo,
  rightSlot,
  statusBar,
  children,
}: {
  actions: DesktopAppActionList;
  infoTitle?: string;
  onInfo?: () => void;
  rightSlot?: ReactNode;
  statusBar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack spacing={0} sx={{ height: '100%', minHeight: 0 }}>
      <DesktopAppToolbar actions={actions} infoTitle={infoTitle} onInfo={onInfo} rightSlot={rightSlot} />
      <Stack spacing={1} sx={{ flex: 1, minHeight: 0, pt: 0, pb: 0 }}>
        {children}
      </Stack>
      {statusBar}
    </Stack>
  );
}
