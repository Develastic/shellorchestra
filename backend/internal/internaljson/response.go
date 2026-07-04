// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package internaljson

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

func DecodeStrictResponse(body io.Reader, maxBytes int64, out any, label string) error {
	data, err := ReadAllLimited(body, maxBytes, label)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	var trailing struct{}
	if err := decoder.Decode(&trailing); err != io.EOF {
		return fmt.Errorf("%s body must contain exactly one JSON object", label)
	}
	return nil
}

func DecodeBestEffort(body io.Reader, maxBytes int64, out any) {
	data, err := ReadAllLimited(body, maxBytes, "internal error response")
	if err != nil {
		return
	}
	_ = json.NewDecoder(bytes.NewReader(data)).Decode(out)
}

func ReadAllLimited(body io.Reader, maxBytes int64, label string) ([]byte, error) {
	if maxBytes <= 0 {
		return nil, fmt.Errorf("%s limit must be positive", label)
	}
	data, err := io.ReadAll(io.LimitReader(body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("%s body is too large", label)
	}
	return data, nil
}
