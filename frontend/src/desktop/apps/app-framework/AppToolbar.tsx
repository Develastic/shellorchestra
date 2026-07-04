// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { Fragment, useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListSubheader from '@mui/material/ListSubheader';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import type { DesktopAppAction, DesktopAppActionList } from './actionList';
import { DesktopAppIconButton, desktopToolbarPaddingXCSS, desktopToolbarPaddingYCSS, desktopWindowPaddingCSS } from './AppControls';

export function DesktopAppToolbar({ actions, infoTitle, onInfo, rightSlot }: { actions: DesktopAppActionList; infoTitle?: string; onInfo?: () => void; rightSlot?: ReactNode }) {
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down('sm'));
  const [overflowAnchor, setOverflowAnchor] = useState<HTMLElement | null>(null);
  const inlineActions = compact ? actions.actions.slice(0, 3) : actions.actions;
  const overflowActions = compact ? actions.actions.slice(3) : [];
  const overflowOpen = Boolean(overflowAnchor);
  const hasActionButtons = inlineActions.length > 0 || overflowActions.length > 0;
  return (
    <Stack
      direction="row"
      spacing={0.75}
      sx={{
        alignItems: 'center',
        flex: '0 0 auto',
        minHeight: 38,
        mx: `calc(-1 * ${desktopWindowPaddingCSS()})`,
        mt: `calc(-1 * ${desktopWindowPaddingCSS()})`,
        px: desktopToolbarPaddingXCSS(),
        pr: { xs: `calc(${desktopToolbarPaddingXCSS()} + 36px)`, sm: `calc(${desktopToolbarPaddingXCSS()} + 40px)` },
        py: desktopToolbarPaddingYCSS(),
        borderBottom: '1px solid',
        borderColor: 'divider',
        minWidth: 0,
      }}
    >
      {inlineActions.map((action, index) => (
        <Fragment key={action.id}>
          <ToolbarGroupBoundary action={action} actions={inlineActions} index={index} />
          <ActionButton action={action} />
        </Fragment>
      ))}
      {overflowActions.length > 0 && (
        <>
          <Tooltip title="More app actions" arrow disableInteractive slotProps={{ tooltip: { sx: { pointerEvents: 'none' } } }}>
            <DesktopAppIconButton
              aria-label="More app actions"
              aria-haspopup="menu"
              aria-expanded={overflowOpen ? 'true' : undefined}
              onClick={(event) => setOverflowAnchor(event.currentTarget)}
              sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 0.75 }}
            >
              <MoreHorizIcon fontSize="small" />
            </DesktopAppIconButton>
          </Tooltip>
          <Menu
            anchorEl={overflowAnchor}
            open={overflowOpen}
            onClose={() => setOverflowAnchor(null)}
            slotProps={{ paper: { sx: { minWidth: 260, bgcolor: 'rgba(15,21,14,0.98)', border: '1px solid', borderColor: 'divider' } } }}
          >
            {overflowActions.map((action, index) => [
              actionNeedsDivider(overflowActions, action, index) ? <Divider key={`${action.id}-divider`} /> : null,
              actionGroupBoundaryLabel(overflowActions, action, index)
                ? (
                  <ListSubheader
                    key={`${action.id}-group`}
                    disableSticky
                    sx={{ bgcolor: 'transparent', color: 'primary.main', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 10, fontWeight: 900, letterSpacing: 0.9, lineHeight: 2.2, textTransform: 'uppercase' }}
                  >
                    {actionGroupBoundaryLabel(overflowActions, action, index)}
                  </ListSubheader>
                )
                : null,
              <MenuItem
                key={action.id}
                disabled={action.disabled}
                onClick={() => {
                  setOverflowAnchor(null);
                  action.run();
                }}
              >
                <ListItemIcon>{action.icon}</ListItemIcon>
                <ListItemText primary={action.label} secondary={action.hint} slotProps={{ secondary: { sx: { whiteSpace: 'normal' } } }} />
              </MenuItem>,
            ])}
          </Menu>
        </>
      )}
      {onInfo && (
        <>
          {hasActionButtons && <Divider orientation="vertical" flexItem sx={{ mx: 0.25 }} />}
          <Tooltip title={infoTitle || 'About this app'} arrow disableInteractive slotProps={{ tooltip: { sx: { pointerEvents: 'none' } } }}>
            <DesktopAppIconButton onClick={onInfo} aria-label={infoTitle || 'About this app'} sx={{ color: 'text.secondary', '&:hover': { color: 'primary.main' } }}>
              <InfoOutlinedIcon fontSize="small" />
            </DesktopAppIconButton>
          </Tooltip>
        </>
      )}
      <Box sx={{ flex: 1 }} />
      {rightSlot ? <Box sx={{ flex: '0 0 auto', minWidth: 0, display: { xs: 'none', sm: 'block' } }}>{rightSlot}</Box> : null}
    </Stack>
  );
}

function actionNeedsDivider(actions: DesktopAppAction[], action: DesktopAppAction, index: number): boolean {
  if (index <= 0) return false;
  const previous = actions[index - 1];
  if (action.spacerBefore) return true;
  if (action.tone === 'danger') return true;
  return Boolean(action.group && previous.group && action.group !== previous.group);
}

function actionGroupBoundaryLabel(actions: DesktopAppAction[], action: DesktopAppAction, index: number): string {
  if (!action.groupLabel) return '';
  if (index <= 0) return action.groupLabel;
  const previous = actions[index - 1];
  if (previous.group !== action.group) return action.groupLabel;
  return '';
}

function ToolbarGroupBoundary({ action, actions, index }: { action: DesktopAppAction; actions: DesktopAppAction[]; index: number }) {
  const label = actionGroupBoundaryLabel(actions, action, index);
  const needsDivider = actionNeedsDivider(actions, action, index);
  if (!label && !needsDivider) return null;
  return (
    <>
      {needsDivider && <Divider orientation="vertical" flexItem sx={{ mx: 0.25 }} />}
      {label && (
        <Typography
          data-testid={`desktop-app-toolbar-group-${action.group}`}
          sx={{
            display: { xs: 'none', md: 'inline-flex' },
            alignItems: 'center',
            minHeight: 28,
            color: 'primary.main',
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            fontSize: 10,
            fontWeight: 900,
            letterSpacing: 0.8,
            lineHeight: 1,
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </Typography>
      )}
    </>
  );
}

function ActionButton({ action }: { action: DesktopAppAction }) {
  const color: 'error' | 'warning' | 'primary' = action.tone === 'danger' ? 'error' : action.tone === 'warning' ? 'warning' : 'primary';
  return (
    <Tooltip title={action.hint} arrow disableInteractive slotProps={{ tooltip: { sx: { pointerEvents: 'none' } } }}>
      <span>
        <DesktopAppIconButton color={color} disabled={action.disabled} onClick={action.run} aria-label={action.label} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 0.75 }}>
          {action.icon}
        </DesktopAppIconButton>
      </span>
    </Tooltip>
  );
}

export function DesktopAppInfoText({ children }: { children: ReactNode }) {
  return <Typography sx={{ color: 'rgba(222, 229, 217, 0.82)', fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-line' }}>{children}</Typography>;
}
