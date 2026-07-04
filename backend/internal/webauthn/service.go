// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package webauthnsvc

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"shellorchestra/backend/internal/config"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

type Config struct {
	RPDisplayName string
	RPID          string
	RPOrigins     []string
}

type Service struct {
	webauthn *webauthn.WebAuthn
}

type RegistrationAuthenticatorPolicy string

const RegistrationAuthenticatorPlatform RegistrationAuthenticatorPolicy = "platform"

type User struct {
	ID          []byte
	Name        string
	DisplayName string
	Credentials []webauthn.Credential
}

func New(config Config) (*Service, error) {
	if config.RPDisplayName == "" {
		return nil, fmt.Errorf("WebAuthn RP display name is required")
	}
	if config.RPID == "" {
		return nil, fmt.Errorf("WebAuthn RP ID is required")
	}
	if len(config.RPOrigins) == 0 {
		return nil, fmt.Errorf("at least one WebAuthn origin is required")
	}
	instance, err := webauthn.New(&webauthn.Config{
		RPDisplayName: config.RPDisplayName,
		RPID:          config.RPID,
		RPOrigins:     config.RPOrigins,
	})
	if err != nil {
		return nil, err
	}
	return &Service{webauthn: instance}, nil
}

func NewFromAppConfig(cfg config.AppConfig) (*Service, error) {
	origin, rpID, err := OriginAndRPID(cfg.App.BaseURL)
	if err != nil {
		return nil, err
	}
	return New(Config{
		RPDisplayName: cfg.App.Name,
		RPID:          rpID,
		RPOrigins:     []string{origin},
	})
}

func NewFromOrigin(appName string, origin string) (*Service, error) {
	normalizedOrigin, rpID, err := OriginAndRPID(origin)
	if err != nil {
		return nil, err
	}
	return New(Config{
		RPDisplayName: appName,
		RPID:          rpID,
		RPOrigins:     []string{normalizedOrigin},
	})
}

func (s *Service) Ready() bool {
	return s != nil && s.webauthn != nil
}

func (s *Service) BeginRegistration(user User, policy RegistrationAuthenticatorPolicy) (*protocol.CredentialCreation, *webauthn.SessionData, error) {
	authenticatorSelection := protocol.AuthenticatorSelection{
		AuthenticatorAttachment: protocol.Platform,
		RequireResidentKey:      protocol.ResidentKeyRequired(),
		ResidentKey:             protocol.ResidentKeyRequirementRequired,
		UserVerification:        protocol.VerificationRequired,
	}
	hints := []protocol.PublicKeyCredentialHints{protocol.PublicKeyCredentialHintClientDevice}

	return s.webauthn.BeginRegistration(user,
		webauthn.WithAuthenticatorSelection(authenticatorSelection),
		webauthn.WithPublicKeyCredentialHints(hints),
		webauthn.WithConveyancePreference(protocol.PreferNoAttestation),
	)
}

func (s *Service) BeginLogin() (*protocol.CredentialAssertion, *webauthn.SessionData, error) {
	return s.webauthn.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired))
}

func (s *Service) BeginLoginAllowed(credentialIDs [][]byte) (*protocol.CredentialAssertion, *webauthn.SessionData, error) {
	descriptors := make([]protocol.CredentialDescriptor, 0, len(credentialIDs))
	for _, credentialID := range credentialIDs {
		if len(credentialID) == 0 {
			continue
		}
		descriptors = append(descriptors, protocol.CredentialDescriptor{
			Type:         protocol.PublicKeyCredentialType,
			CredentialID: protocol.URLEncodedBase64(credentialID),
		})
	}
	if len(descriptors) == 0 {
		return s.BeginLogin()
	}
	return s.webauthn.BeginDiscoverableLogin(
		webauthn.WithUserVerification(protocol.VerificationRequired),
		webauthn.WithAllowedCredentials(descriptors),
	)
}

func (s *Service) FinishRegistration(user User, session webauthn.SessionData, request *http.Request) (*webauthn.Credential, error) {
	return s.webauthn.FinishRegistration(user, session, request)
}

func (s *Service) FinishLogin(handler webauthn.DiscoverableUserHandler, session webauthn.SessionData, request *http.Request) (User, *webauthn.Credential, error) {
	user, credential, err := s.webauthn.FinishPasskeyLogin(handler, session, request)
	if err != nil {
		return User{}, nil, err
	}
	typed, ok := user.(User)
	if !ok {
		return User{}, nil, fmt.Errorf("unexpected WebAuthn user type")
	}
	return typed, credential, nil
}

func EncodeCredential(credential webauthn.Credential) (string, error) {
	data, err := json.Marshal(credential)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func DecodeCredential(raw string) (webauthn.Credential, error) {
	var credential webauthn.Credential
	if err := json.Unmarshal([]byte(raw), &credential); err != nil {
		return webauthn.Credential{}, err
	}
	return credential, nil
}

func (u User) WebAuthnID() []byte { return u.ID }

func (u User) WebAuthnName() string { return u.Name }

func (u User) WebAuthnDisplayName() string { return u.DisplayName }

func (u User) WebAuthnCredentials() []webauthn.Credential { return u.Credentials }

func OriginAndRPID(baseURL string) (string, string, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return "", "", fmt.Errorf("WebAuthn origin is invalid: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", "", fmt.Errorf("WebAuthn origin must use http or https")
	}
	host := parsed.Hostname()
	if host == "" {
		return "", "", fmt.Errorf("WebAuthn origin host is required")
	}
	origin := parsed.Scheme + "://" + parsed.Host
	return origin, host, nil
}
