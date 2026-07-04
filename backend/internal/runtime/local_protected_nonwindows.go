// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

//go:build !windows

package runtime

import (
	"context"
	"fmt"

	"golang.org/x/crypto/ssh"
)

func LocalProtectedKeyRuntimeAvailable() bool {
	return false
}

func LocalProtectedKeyPublicKeyStrings(ctx context.Context) ([]string, error) {
	_ = ctx
	return nil, fmt.Errorf("local Windows protected key authentication is available only in the Windows desktop-server package")
}

func localProtectedKeySigners(ctx context.Context) ([]ssh.Signer, error) {
	_ = ctx
	return nil, fmt.Errorf("local Windows protected key authentication is available only in the Windows desktop-server package")
}
