// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import { createTheme } from '@mui/material/styles';
import { shellOrchestraAppThemeOptions, shellOrchestraFonts } from '../../../shared/theme/shellOrchestraTheme';

export const monoFontFamily = shellOrchestraFonts.monoFontFamily;

export const theme = createTheme(shellOrchestraAppThemeOptions as Parameters<typeof createTheme>[0]);
