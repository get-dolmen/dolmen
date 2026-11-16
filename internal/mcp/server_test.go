package mcp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type testRPC struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error"`
}

func testHandler(t *testing.T) (http.Handler, *Config) {
	t.Helper()
	tools, cfg := newSQLiteTools(t)
	cfg.Enabled = true
	cfg.Token = "secret-token"
	return NewHandler(tools, func() Config { return *cfg }, "test-version"), cfg
}

func post(t *testing.T, h http.Handler, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, EndpointPath, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeRPC(t *testing.T, rec *httptest.ResponseRecorder) testRPC {
	t.Helper()
	var got testRPC
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("invalid response %q: %v", rec.Body.String(), err)
	}
	return got
}

func TestServerRequiresToken(t *testing.T) {
	h, _ := testHandler(t)
	body := `{"jsonrpc":"2.0","id":1,"method":"ping"}`
	if rec := post(t, h, "", body); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: status %d", rec.Code)
	}
	if rec := post(t, h, "wrong", body); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: status %d", rec.Code)
	}
	rec := post(t, h, "secret-token", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("valid token: status %d (%s)", rec.Code, rec.Body.String())
	}
	if got := decodeRPC(t, rec); got.Error != nil || string(got.Result) != "{}" {
		t.Fatalf("ping = %+v", got)
	}
}

func TestServerInitialize(t *testing.T) {
	h, _ := testHandler(t)
	rec := post(t, h, "secret-token",
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test"}}}`)
	got := decodeRPC(t, rec)
	if got.Error != nil {
		t.Fatal(got.Error)
	}
	var result struct {
		ProtocolVersion string `json:"protocolVersion"`
		Capabilities    struct {
			Tools struct {
				ListChanged bool `json:"listChanged"`
			} `json:"tools"`
		} `json:"capabilities"`
		ServerInfo struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"serverInfo"`
		Instructions string `json:"instructions"`
	}
	if err := json.Unmarshal(got.Result, &result); err != nil {
		t.Fatal(err)
	}
	if result.ProtocolVersion != "2024-11-05" {
		t.Errorf("protocolVersion = %q", result.ProtocolVersion)
	}
	if result.ServerInfo.Name != "dolmen" || result.ServerInfo.Version != "test-version" {
		t.Errorf("serverInfo = %+v", result.ServerInfo)
	}
	if !strings.Contains(result.Instructions, "read data") {
		t.Errorf("instructions = %q", result.Instructions)
	}

	// An unknown revision gets the latest one.
	rec = post(t, h, "secret-token",
		`{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}`)
	if err := json.Unmarshal(decodeRPC(t, rec).Result, &result); err != nil {
		t.Fatal(err)
	}
	if result.ProtocolVersion != latestProtocolVersion {
		t.Errorf("fallback protocolVersion = %q", result.ProtocolVersion)
	}
}

func TestServerNotificationsAndErrors(t *testing.T) {
	h, _ := testHandler(t)
	rec := post(t, h, "secret-token", `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	if rec.Code != http.StatusAccepted || rec.Body.Len() != 0 {
		t.Fatalf("notification: status %d, body %q", rec.Code, rec.Body.String())
	}

	got := decodeRPC(t, post(t, h, "secret-token", `{"jsonrpc":"2.0","id":1,"method":"resources/list"}`))
	if got.Error == nil || got.Error.Code != -32601 {
		t.Fatalf("unknown method = %+v", got)
	}
	got = decodeRPC(t, post(t, h, "secret-token", `{oops`))
	if got.Error == nil || got.Error.Code != -32700 {
		t.Fatalf("invalid JSON = %+v", got)
	}
	got = decodeRPC(t, post(t, h, "secret-token", `{"jsonrpc":"1.0","id":1,"method":"ping"}`))
	if got.Error == nil || got.Error.Code != -32600 {
		t.Fatalf("bad version = %+v", got)
	}

	req := httptest.NewRequest(http.MethodGet, EndpointPath, nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	get := httptest.NewRecorder()
	h.ServeHTTP(get, req)
	if get.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: status %d", get.Code)
	}
}

func TestServerTools(t *testing.T) {
	h, _ := testHandler(t)
	got := decodeRPC(t, post(t, h, "secret-token", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	var list struct {
		Tools []Tool `json:"tools"`
	}
	if err := json.Unmarshal(got.Result, &list); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range list.Tools {
		names = append(names, tool.Name)
		if tool.InputSchema["type"] != "object" {
			t.Errorf("%s: inputSchema = %+v", tool.Name, tool.InputSchema)
		}
	}
	if !strings.Contains(strings.Join(names, ","), "read_query") {
		t.Fatalf("tools = %v", names)
	}

	got = decodeRPC(t, post(t, h, "secret-token",
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_connections","arguments":{}}}`))
	var result callResult
	if err := json.Unmarshal(got.Result, &result); err != nil {
		t.Fatal(err)
	}
	if result.IsError || len(result.Content) != 1 || !strings.Contains(result.Content[0].Text, `"name": "local"`) {
		t.Fatalf("list_connections = %+v", result)
	}

	got = decodeRPC(t, post(t, h, "secret-token",
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_query","arguments":{"connection":"local","sql":"select name from people order by id"}}}`))
	result = callResult{}
	if err := json.Unmarshal(got.Result, &result); err != nil {
		t.Fatal(err)
	}
	if result.IsError || !strings.Contains(result.Content[0].Text, "Ada") {
		t.Fatalf("read_query = %+v", result)
	}

	// Without write access the write tool is not even listed, and calling it
	// by name reports a tool error rather than a protocol error.
	got = decodeRPC(t, post(t, h, "secret-token",
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"write_query","arguments":{"connection":"local","sql":"delete from people"}}}`))
	result = callResult{}
	if err := json.Unmarshal(got.Result, &result); err != nil {
		t.Fatal(err)
	}
	if !result.IsError || !strings.Contains(result.Content[0].Text, "writing is disabled") {
		t.Fatalf("write_query = %+v", result)
	}
}

func TestServerFollowsPolicyChanges(t *testing.T) {
	h, cfg := testHandler(t)
	cfg.Write = true
	got := decodeRPC(t, post(t, h, "secret-token", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	var list struct {
		Tools []Tool `json:"tools"`
	}
	if err := json.Unmarshal(got.Result, &list); err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, tool := range list.Tools {
		found = found || tool.Name == "write_query"
	}
	if !found {
		t.Fatal("write_query stayed hidden after write access was granted")
	}

	// A token change takes effect on the next request, without a restart.
	cfg.Token = "new-token"
	if rec := post(t, h, "secret-token", `{"jsonrpc":"2.0","id":1,"method":"ping"}`); rec.Code != http.StatusUnauthorized {
		t.Fatalf("old token accepted: %d", rec.Code)
	}
	if rec := post(t, h, "new-token", `{"jsonrpc":"2.0","id":1,"method":"ping"}`); rec.Code != http.StatusOK {
		t.Fatalf("new token rejected: %d", rec.Code)
	}
}
