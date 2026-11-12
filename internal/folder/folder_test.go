package folder

import "testing"

func TestStoreNestingAndDelete(t *testing.T) {
	s := NewStore(t.TempDir())

	root, err := s.Save(Folder{Name: "  Work  "})
	if err != nil || root.ID == "" || root.Name != "Work" {
		t.Fatalf("root: %+v %v", root, err)
	}
	child, err := s.Save(Folder{Name: "Clients", ParentID: root.ID})
	if err != nil {
		t.Fatal(err)
	}
	grandchild, err := s.Save(Folder{Name: "Acme", ParentID: child.ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Save(Folder{Name: "Loop", ParentID: grandchild.ID}); err != nil {
		t.Fatal(err)
	}
	// A folder cannot become its own ancestor.
	if _, err := s.Save(Folder{ID: root.ID, Name: "Work", ParentID: grandchild.ID}); err == nil {
		t.Fatal("cycle accepted")
	}
	if _, err := s.Save(Folder{Name: "Orphan", ParentID: "nope"}); err == nil {
		t.Fatal("missing parent accepted")
	}
	if _, err := s.Save(Folder{Name: "   "}); err == nil {
		t.Fatal("blank name accepted")
	}

	parent, err := s.Delete(child.ID)
	if err != nil || parent != root.ID {
		t.Fatalf("delete: %q %v", parent, err)
	}
	list, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range list {
		if f.ID == child.ID {
			t.Fatal("deleted folder still present")
		}
		if f.ID == grandchild.ID && f.ParentID != root.ID {
			t.Fatalf("grandchild not reparented: %+v", f)
		}
	}
}
