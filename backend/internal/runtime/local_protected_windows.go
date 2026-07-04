// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

//go:build windows

package runtime

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

const defaultOpenSSHAgentPipe = `\\.\pipe\openssh-ssh-agent`

func LocalProtectedKeyRuntimeAvailable() bool {
	signers, err := localProtectedKeySigners(context.Background())
	return err == nil && len(signers) > 0
}

func LocalProtectedKeyPublicKeyStrings(ctx context.Context) ([]string, error) {
	signers, err := localProtectedKeySigners(ctx)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(signers))
	for _, signer := range signers {
		keys = append(keys, strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))))
	}
	return keys, nil
}

func localProtectedKeySigners(ctx context.Context) ([]ssh.Signer, error) {
	_ = ctx
	file, err := openWindowsOpenSSHAgent()
	if err != nil {
		return nil, fmt.Errorf("local protected key provider is not available: %w", err)
	}
	defer file.Close()
	agentSigners, err := agent.NewClient(file).Signers()
	if err != nil {
		return nil, fmt.Errorf("cannot list local protected keys from Windows OpenSSH agent: %w", err)
	}
	if len(agentSigners) == 0 {
		return nil, fmt.Errorf("Windows OpenSSH agent has no keys available for unattended authentication")
	}
	signers := make([]ssh.Signer, 0, len(agentSigners))
	for _, signer := range agentSigners {
		signers = append(signers, windowsAgentSigner{publicKey: signer.PublicKey()})
	}
	return signers, nil
}

func openWindowsOpenSSHAgent() (*os.File, error) {
	path := strings.TrimSpace(os.Getenv("SSH_AUTH_SOCK"))
	if path == "" {
		path = defaultOpenSSHAgentPipe
	}
	return os.OpenFile(path, os.O_RDWR, 0)
}

type windowsAgentSigner struct {
	publicKey ssh.PublicKey
}

func (s windowsAgentSigner) PublicKey() ssh.PublicKey {
	return s.publicKey
}

func (s windowsAgentSigner) Sign(rand io.Reader, data []byte) (*ssh.Signature, error) {
	return s.sign(rand, data, "")
}

func (s windowsAgentSigner) SignWithAlgorithm(rand io.Reader, data []byte, algorithm string) (*ssh.Signature, error) {
	return s.sign(rand, data, algorithm)
}

func (s windowsAgentSigner) sign(rand io.Reader, data []byte, algorithm string) (*ssh.Signature, error) {
	file, err := openWindowsOpenSSHAgent()
	if err != nil {
		return nil, fmt.Errorf("local protected key provider is not available: %w", err)
	}
	defer file.Close()
	agentSigners, err := agent.NewClient(file).Signers()
	if err != nil {
		return nil, fmt.Errorf("cannot list local protected keys from Windows OpenSSH agent: %w", err)
	}
	for _, signer := range agentSigners {
		if !bytes.Equal(signer.PublicKey().Marshal(), s.publicKey.Marshal()) {
			continue
		}
		if algorithm != "" {
			if algorithmSigner, ok := signer.(ssh.AlgorithmSigner); ok {
				return algorithmSigner.SignWithAlgorithm(rand, data, algorithm)
			}
		}
		return signer.Sign(rand, data)
	}
	return nil, fmt.Errorf("selected local protected key is no longer available in Windows OpenSSH agent")
}
