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

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "the MCP endpoint accepts POST requests only", http.StatusMethodNotAllowed)
		return
	}
	cfg := s.policy()
	if !authorized(r, cfg.Token) {
		w.Header().Set("WWW-Authenticate", `Bearer realm="dolmen"`)
		http.Error(w, "a valid bearer token is required", http.StatusUnauthorized)
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		s.write(w, rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"),
			Error: &rpcError{Code: -32700, Message: "could not read the request body"}})
		return
	}
	var req rpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		s.write(w, rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"),
			Error: &rpcError{Code: -32700, Message: "invalid JSON: " + err.Error()}})
		return
	}
	if strings.TrimSpace(req.JSONRPC) != "2.0" {
		s.write(w, rpcResponse{JSONRPC: "2.0", ID: req.ID,
			Error: &rpcError{Code: -32600, Message: `jsonrpc must be "2.0"`}})
		return
	}
	if len(req.ID) == 0 {
		// Notifications (initialized, cancelled, …) need no body.
		w.WriteHeader(http.StatusAccepted)
		return
	}
	s.write(w, s.handle(r.Context(), req))
}

func (s *server) handle(ctx context.Context, req rpcRequest) rpcResponse {
	resp := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		resp.Result = s.initialize(req.Params)
	case "ping":
		resp.Result = map[string]any{}
	case "tools/list":
		resp.Result = map[string]any{"tools": s.tools.ListTools()}
	case "tools/call":
		resp.Result = s.callTool(ctx, req.Params)
	default:
		resp.Error = &rpcError{Code: -32601, Message: fmt.Sprintf("method %q is not supported", req.Method)}
	}
	return resp
}

func (s *server) initialize(params json.RawMessage) map[string]any {
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(params, &p)
	version := latestProtocolVersion
	if supportedProtocols[p.ProtocolVersion] {
		version = p.ProtocolVersion
	}
	cfg := s.policy()
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
		"instructions": cfg.DescribePermissions(),
	}
}

func (s *server) callTool(ctx context.Context, params json.RawMessage) callResult {
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(params, &p); err != nil || strings.TrimSpace(p.Name) == "" {
		return toolError("tools/call needs a tool name")
	}
	out, err := s.tools.Call(ctx, p.Name, p.Arguments)
	if err != nil {
		return toolError(err.Error())
	}
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return toolError("could not encode the tool result: " + err.Error())
	}
	return callResult{Content: []content{{Type: "text", Text: string(b)}}}
}

func toolError(text string) callResult {
	return callResult{Content: []content{{Type: "text", Text: text}}, IsError: true}
}

func (s *server) write(w http.ResponseWriter, resp rpcResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(resp)
}

// authorized compares the bearer token without leaking its length through
// early exits.
func authorized(r *http.Request, token string) bool {
	if token == "" {
		return false
	}
	const prefix = "Bearer "
	header := r.Header.Get("Authorization")
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return false
	}
	got := strings.TrimSpace(header[len(prefix):])
	if got == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(token)) == 1
}
