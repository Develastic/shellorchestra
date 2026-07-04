// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

package worker

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

const (
	webSocketGUID         = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	webSocketOpcodeText   = byte(0x1)
	webSocketOpcodeBinary = byte(0x2)
	webSocketOpcodeClose  = byte(0x8)
	webSocketOpcodePing   = byte(0x9)
	webSocketOpcodePong   = byte(0xa)
	maxWebSocketFrameSize = 1 << 20
)

type webSocketConn struct {
	conn net.Conn
	r    *bufio.Reader
	w    *bufio.Writer
	mu   sync.Mutex
}

func acceptWebSocket(w http.ResponseWriter, r *http.Request) (*webSocketConn, error) {
	if !headerContainsToken(r.Header.Get("Connection"), "upgrade") || !strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") {
		http.Error(w, "WebSocket upgrade is required.", http.StatusBadRequest)
		return nil, fmt.Errorf("request is not a websocket upgrade")
	}
	if strings.TrimSpace(r.Header.Get("Sec-WebSocket-Version")) != "13" {
		http.Error(w, "Unsupported WebSocket version.", http.StatusBadRequest)
		return nil, fmt.Errorf("unsupported websocket version")
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		http.Error(w, "WebSocket key is missing.", http.StatusBadRequest)
		return nil, fmt.Errorf("websocket key is missing")
	}
	if decoded, err := base64.StdEncoding.DecodeString(key); err != nil || len(decoded) != 16 {
		http.Error(w, "WebSocket key is invalid.", http.StatusBadRequest)
		return nil, fmt.Errorf("websocket key is invalid")
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "WebSocket hijacking is not supported.", http.StatusInternalServerError)
		return nil, fmt.Errorf("http hijacker is not available")
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return nil, err
	}
	accept := webSocketAccept(key)
	response := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := rw.WriteString(response); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &webSocketConn{conn: conn, r: rw.Reader, w: rw.Writer}, nil
}

func webSocketAccept(key string) string {
	sum := sha1.Sum([]byte(key + webSocketGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func headerContainsToken(value string, token string) bool {
	for _, part := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

func (c *webSocketConn) ReadMessage() (byte, []byte, error) {
	for {
		opcode, payload, fin, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch opcode {
		case webSocketOpcodePing:
			_ = c.writeFrame(webSocketOpcodePong, payload)
			continue
		case webSocketOpcodePong:
			continue
		case webSocketOpcodeClose:
			_ = c.writeFrame(webSocketOpcodeClose, payload)
			return opcode, payload, io.EOF
		case webSocketOpcodeText, webSocketOpcodeBinary:
			if fin {
				return opcode, payload, nil
			}
			combined := append([]byte(nil), payload...)
			for !fin {
				nextOpcode, nextPayload, nextFin, err := c.readFrame()
				if err != nil {
					return 0, nil, err
				}
				if nextOpcode != 0 {
					return 0, nil, fmt.Errorf("unexpected fragmented websocket opcode %d", nextOpcode)
				}
				combined = append(combined, nextPayload...)
				if len(combined) > maxWebSocketFrameSize {
					return 0, nil, fmt.Errorf("websocket message is too large")
				}
				fin = nextFin
			}
			return opcode, combined, nil
		default:
			return 0, nil, fmt.Errorf("unsupported websocket opcode %d", opcode)
		}
	}
}

func (c *webSocketConn) WriteJSON(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return c.writeFrame(webSocketOpcodeText, data)
}

func (c *webSocketConn) WriteBinary(data []byte) error {
	return c.writeFrame(webSocketOpcodeBinary, data)
}

func (c *webSocketConn) Close() error {
	_ = c.writeFrame(webSocketOpcodeClose, []byte{})
	return c.conn.Close()
}

func (c *webSocketConn) readFrame() (opcode byte, payload []byte, fin bool, err error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(c.r, header); err != nil {
		return 0, nil, false, err
	}
	fin = header[0]&0x80 != 0
	opcode = header[0] & 0x0f
	masked := header[1]&0x80 != 0
	length := uint64(header[1] & 0x7f)
	switch length {
	case 126:
		extended := make([]byte, 2)
		if _, err := io.ReadFull(c.r, extended); err != nil {
			return 0, nil, false, err
		}
		length = uint64(binary.BigEndian.Uint16(extended))
	case 127:
		extended := make([]byte, 8)
		if _, err := io.ReadFull(c.r, extended); err != nil {
			return 0, nil, false, err
		}
		length = binary.BigEndian.Uint64(extended)
	}
	if length > maxWebSocketFrameSize {
		return 0, nil, false, fmt.Errorf("websocket frame is too large")
	}
	if !masked {
		return 0, nil, false, errors.New("client websocket frame is not masked")
	}
	mask := make([]byte, 4)
	if _, err := io.ReadFull(c.r, mask); err != nil {
		return 0, nil, false, err
	}
	payload = make([]byte, int(length))
	if _, err := io.ReadFull(c.r, payload); err != nil {
		return 0, nil, false, err
	}
	for index := range payload {
		payload[index] ^= mask[index%4]
	}
	return opcode, payload, fin, nil
}

func (c *webSocketConn) writeFrame(opcode byte, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	header := []byte{0x80 | opcode}
	length := len(payload)
	switch {
	case length < 126:
		header = append(header, byte(length))
	case length <= 0xffff:
		header = append(header, 126, byte(length>>8), byte(length))
	default:
		header = append(header, 127)
		extended := make([]byte, 8)
		binary.BigEndian.PutUint64(extended, uint64(length))
		header = append(header, extended...)
	}
	if _, err := c.w.Write(header); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := c.w.Write(payload); err != nil {
			return err
		}
	}
	return c.w.Flush()
}
