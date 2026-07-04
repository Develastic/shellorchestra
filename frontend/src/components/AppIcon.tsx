// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

import Box from '@mui/material/Box';
import shellorchestraPromptIconURL from '../assets/app-icons/shellorchestra_prompt_icon_1.png';
import shellorchestraIconURL from '../assets/app-icons/shellorchestra_icon_1.png';
import shellorchestraLogoURL from '../assets/app-icons/shellorchestra_logo_1.png';

export function AppIcon({ size = 48, decorative = false }: { size?: number; decorative?: boolean }) {
  const iconKind = size < 64 ? 'prompt' : size >= 120 ? 'logo' : 'icon';
  const src = iconKind === 'prompt' ? shellorchestraPromptIconURL : iconKind === 'logo' ? shellorchestraLogoURL : shellorchestraIconURL;

  return (
    <Box
      component="img"
      src={src}
      alt={decorative ? '' : iconKind === 'logo' ? 'ShellOrchestra app logo' : 'ShellOrchestra app icon'}
      aria-hidden={decorative ? true : undefined}
      sx={{
        display: 'block',
        width: size,
        height: size,
        objectFit: iconKind === 'logo' ? 'contain' : 'cover',
      }}
    />
  );
}

export { shellorchestraPromptIconURL, shellorchestraIconURL, shellorchestraLogoURL };
