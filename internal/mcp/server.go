package mcp

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const (
	// EndpointPath is where MCP clients send JSON-RPC messages.
	EndpointPath = "/mcp"

	latestProtocolVersion = "2025-06-18"
	maxBodyBytes          = 1 << 20
)

// The streamable HTTP transport revisions Dolmen understands. A client that
// asks for an older revision gets it; anything unknown gets the latest.
var supportedProtocols = map[string]bool{
	"2024-11-05": true,
	"2025-03-26": true,
	"2025-06-18": true,
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type content struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type callResult struct {
	Content []content `json:"content"`
	IsError bool      `json:"isError,omitempty"`
}

// NewHandler serves one MCP endpoint. policy is read on every request, so a
// new token or permission saved in the settings dialog applies without a
// restart.
func NewHandler(tools *Tools, policy func() Config, version string) http.Handler {
	s := &server{tools: tools, policy: policy, version: version}
	mux := http.NewServeMux()
	mux.Handle(EndpointPath, s)
	return mux
}

type server struct {
	tools   *Tools
	policy  func() Config
	version string
}

func (s *server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", http.MethodPost)
		http.Error(writer, "the MCP endpoint accepts POST requests only", http.StatusMethodNotAllowed)
		return
	}
	config := s.policy()
	if !authorized(request, config.Token) {
		writer.Header().Set("WWW-Authenticate", `Bearer realm="dolmen"`)
		http.Error(writer, "a valid bearer token is required", http.StatusUnauthorized)
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, maxBodyBytes))
	if err != nil {
		s.write(writer, rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"),
			Error: &rpcError{Code: -32700, Message: "could not read the request body"}})
		return
	}
	var message rpcRequest
	if err := json.Unmarshal(body, &message); err != nil {
		s.write(writer, rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"),
			Error: &rpcError{Code: -32700, Message: "invalid JSON: " + err.Error()}})
		return
	}
	if strings.TrimSpace(message.JSONRPC) != "2.0" {
		s.write(writer, rpcResponse{JSONRPC: "2.0", ID: message.ID,
			Error: &rpcError{Code: -32600, Message: `jsonrpc must be "2.0"`}})
		return
	}
	if len(message.ID) == 0 {
		// Notifications (initialized, cancelled, …) need no body.
		writer.WriteHeader(http.StatusAccepted)
		return
	}
	s.write(writer, s.handle(request.Context(), message))
}

func (s *server) handle(ctx context.Context, message rpcRequest) rpcResponse {
	response := rpcResponse{JSONRPC: "2.0", ID: message.ID}
	switch message.Method {
	case "initialize":
		response.Result = s.initialize(message.Params)
	case "ping":
		response.Result = map[string]any{}
	case "tools/list":
		response.Result = map[string]any{"tools": s.tools.ListTools()}
	case "tools/call":
		response.Result = s.callTool(ctx, message.Params)
	default:
		response.Error = &rpcError{Code: -32601, Message: fmt.Sprintf("method %q is not supported", message.Method)}
	}
	return response
}

func (s *server) initialize(parameters json.RawMessage) map[string]any {
	var payload struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(parameters, &payload)
	version := latestProtocolVersion
	if supportedProtocols[payload.ProtocolVersion] {
		version = payload.ProtocolVersion
	}
	config := s.policy()
	return map[string]any{
		"protocolVersion": version,
		"capabilities": map[string]any{
			"tools": map[string]any{"listChanged": false},
		},
		"serverInfo": map[string]any{
			"name":    "dolmen",
			"title":   "Dolmen",
			"version": s.version,
		},
		"instructions": config.DescribePermissions(),
	}
}

func (s *server) callTool(ctx context.Context, parameters json.RawMessage) callResult {
	var payload struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(parameters, &payload); err != nil || strings.TrimSpace(payload.Name) == "" {
		return toolError("tools/call needs a tool name")
	}
	result, err := s.tools.Call(ctx, payload.Name, payload.Arguments)
	if err != nil {
		return toolError(err.Error())
	}
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return toolError("could not encode the tool result: " + err.Error())
	}
	return callResult{Content: []content{{Type: "text", Text: string(encoded)}}}
}

func toolError(text string) callResult {
	return callResult{Content: []content{{Type: "text", Text: text}}, IsError: true}
}

func (s *server) write(writer http.ResponseWriter, response rpcResponse) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(writer).Encode(response)
}

// authorized compares the bearer token without leaking its length through
// early exits.
func authorized(request *http.Request, token string) bool {
	if token == "" {
		return false
	}
	const prefix = "Bearer "
	header := request.Header.Get("Authorization")
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return false
	}
	got := strings.TrimSpace(header[len(prefix):])
	if got == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(token)) == 1
}
