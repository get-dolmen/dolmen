package gitsync

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"dolmen/internal/conn"
	"dolmen/internal/driver"
	"dolmen/internal/folder"
	"dolmen/internal/scratch"
)

func TestSealRoundTrip(t *testing.T) {
	plain := []byte(`{"hello":"world"}`)
	sealed, err := seal(plain, "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, plain) {
		t.Fatal("the ciphertext contains the plaintext")
	}
	got, err := open(sealed, "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(plain) {
		t.Fatalf("got %q, want %q", got, plain)
	}
	if _, err := open(sealed, "wrong"); err != ErrPassword {
		t.Fatalf("wrong password: got %v, want ErrPassword", err)
	}
}

func TestMergeKeepsNewestAndHonoursTombstones(t *testing.T) {
	local := Bundle{
		Connections: []driver.Config{{ID: "1", Name: "local", UpdatedAt: 100}, {ID: "2", Name: "gone", UpdatedAt: 50}},
		Folders:     []folder.Folder{{ID: "f1", Name: "folder", UpdatedAt: 10}},
		Scratches:   []scratch.Entry{{ID: "s1", Name: "a.sql", UpdatedAt: 100}},
	}
	remote := Bundle{
		Connections: []driver.Config{{ID: "1", Name: "remote", UpdatedAt: 200}, {ID: "2", Name: "gone", UpdatedAt: 50}, {ID: "3", Name: "remote only", UpdatedAt: 80}},
		Scratches:   []scratch.Entry{{ID: "s1", Name: "a.sql", UpdatedAt: 50}, {ID: "s2", Name: "b.sql", UpdatedAt: 90}},
		Deleted:     map[string]int64{"conn:2": 60},
	}
	got := mergeBundles(local, remote)

	found := map[string]string{}
	for _, c := range got.Connections {
		found[c.ID] = c.Name
	}
	if found["1"] != "remote" || found["2"] != "" || found["3"] != "remote only" {
		t.Fatalf("connections = %+v", found)
	}
	if len(got.ScratchList()) != 2 {
		t.Fatalf("scratches = %+v", got.ScratchList())
	}
}

func TestMissingItemsBecomeTombstones(t *testing.T) {
	known := map[string]bool{"conn:1": true, "scratch:x": true}
	local := Bundle{Connections: []driver.Config{{ID: "1", Name: "still here"}}}
	got := missingItems(known, local)
	if _, ok := got["conn:1"]; ok {
		t.Fatal("a still-present connection was marked deleted")
	}
	if _, ok := got["scratch:x"]; !ok {
		t.Fatal("a disappeared scratch was not marked deleted")
	}
}

func TestSyncBetweenTwoMachines(t *testing.T) {
	remote := filepath.Join(t.TempDir(), "remote.git")
	run(t, "git", "init", "--bare", "-q", remote)
	url := "file://" + remote

	a, aStores := newTestService(t, url)
	b, bStores := newTestService(t, url)

	// Machine A creates a connection, a folder and a scratch.
	f, err := aStores.folders.Save(folder.Folder{Name: "Work"})
	if err != nil {
		t.Fatal(err)
	}
	config, err := aStores.connections.Save(driver.Config{Name: "shop", Kind: driver.SQLite, FilePath: "/tmp/shop.db", FolderID: f.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := aStores.scratches.Create("a1", "users.sql", config.ID, "", "", "", "select * from users;"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Sync(""); err != nil {
		t.Fatalf("first sync: %v", err)
	}

	// Machine B receives everything.
	if _, err := b.Sync(""); err != nil {
		t.Fatalf("second machine sync: %v", err)
	}
	connections, err := bStores.connections.List()
	if err != nil || len(connections) != 1 || connections[0].Name != "shop" {
		t.Fatalf("connections = %+v, err = %v", connections, err)
	}
	folders, _ := bStores.folders.List()
	if len(folders) != 1 || folders[0].Name != "Work" {
		t.Fatalf("folders = %+v", folders)
	}
	entries, _ := bStores.scratches.Snapshot()
	if len(entries) != 1 || entries[0].Content != "select * from users;" {
		t.Fatalf("scratches = %+v", entries)
	}

	// B edits and adds a scratch; A picks them up.
	if err := bStores.scratches.SaveContent("a1", "select 1;"); err != nil {
		t.Fatal(err)
	}
	if _, err := bStores.scratches.Create("b1", "report.sql", "", "", "", "", "select count(*) from users;"); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Sync(""); err != nil {
		t.Fatalf("second machine push: %v", err)
	}
	if _, err := a.Sync(""); err != nil {
		t.Fatalf("first machine pull: %v", err)
	}
	entries, _ = aStores.scratches.Snapshot()
	if len(entries) != 2 {
		t.Fatalf("scratches after pull = %+v", entries)
	}
	for _, e := range entries {
		if e.ID == "a1" && e.Content != "select 1;" {
			t.Fatalf("edit did not propagate: %+v", e)
		}
	}

	// A deletes b1; B removes it too.
	before, _ := aStores.scratches.Snapshot()
	_ = before
	if err := aStores.scratches.Delete("b1"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Sync(""); err != nil {
		t.Fatalf("delete push: %v", err)
	}
	if _, err := b.Sync(""); err != nil {
		t.Fatalf("delete pull: %v", err)
	}
	entries, _ = bStores.scratches.Snapshot()
	if len(entries) != 1 || entries[0].ID != "a1" {
		t.Fatalf("scratches after delete = %+v", entries)
	}
}

func TestEncryptedSync(t *testing.T) {
	remote := filepath.Join(t.TempDir(), "remote.git")
	run(t, "git", "init", "--bare", "-q", remote)
	url := "file://" + remote

	a, aStores := newTestService(t, url)
	if _, err := aStores.connections.Save(driver.Config{Name: "secret", Kind: driver.SQLite, FilePath: "/tmp/s.db", Password: "hunter2"}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.SaveConfig(Config{Enabled: true, Remote: url, Branch: "main", Encrypted: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Sync(""); err == nil {
		t.Fatal("sync without a master password should fail")
	}
	if _, err := a.Sync("master"); err != nil {
		t.Fatalf("encrypted sync: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(a.dir, encryptedFile))
	if err != nil {
		t.Fatalf("encrypted bundle missing: %v", err)
	}
	if bytes.Contains(raw, []byte("hunter2")) || bytes.Contains(raw, []byte("secret")) {
		t.Fatal("the encrypted bundle leaks connection details")
	}

	// Another machine must opt into encryption and then needs the right password.
	b, bStores := newTestService(t, url)
	if _, err := b.Sync("master"); err == nil {
		t.Fatal("an unencrypted machine should refuse to downgrade an encrypted remote")
	}
	if _, err := b.SaveConfig(Config{Enabled: true, Remote: url, Branch: "main", Encrypted: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Sync("wrong"); err == nil {
		t.Fatal("a wrong master password should fail")
	}
	if _, err := b.Sync("master"); err != nil {
		t.Fatalf("decrypting on the second machine: %v", err)
	}
	connections, _ := bStores.connections.List()
	if len(connections) != 1 || connections[0].Password != "hunter2" {
		t.Fatalf("connections = %+v", connections)
	}
}

type testStores struct {
	connections *conn.Store
	folders     *folder.Store
	scratches   *scratch.Store
}

func newTestService(t *testing.T, remote string) (*Service, *testStores) {
	t.Helper()
	dir := t.TempDir()
	sc, err := scratch.NewStore(filepath.Join(dir, "scratch"))
	if err != nil {
		t.Fatal(err)
	}
	stores := &testStores{connections: conn.NewStore(dir), folders: folder.NewStore(dir), scratches: sc}
	svc := NewService(dir, stores.connections, stores.folders, stores.scratches)
	if _, err := svc.SaveConfig(Config{Enabled: true, Remote: remote, Branch: "main"}); err != nil {
		t.Fatal(err)
	}
	return svc, stores
}

func run(t *testing.T, name string, args ...string) {
	t.Helper()
	cmd := exec.Command(name, args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s %v: %v\n%s", name, args, err, out)
	}
}
