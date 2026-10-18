package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v3"
)

// unzip reads a downloaded archive into its files, by name.
func unzip(t *testing.T, b []byte) map[string][]byte {
	t.Helper()
	zr, e := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if e != nil {
		t.Fatalf("not a ZIP (%d bytes): %v", len(b), e)
	}
	files := map[string][]byte{}
	for _, file := range zr.File {
		r, e := file.Open()
		if e != nil {
			t.Fatal(e)
		}
		data, e := io.ReadAll(r)
		r.Close()
		if e != nil {
			t.Fatal(e)
		}
		files[file.Name] = data
	}
	return files
}

func TestExportAsFiles(t *testing.T) {
	storage := newMemoryS3(t)
	useMemoryS3(t, storage)
	db := isolatedDB(t)
	ctx := context.Background()
	f := accountsApp(db, false)
	id := member(t, db, "files@example.test")
	other := member(t, db, "other@example.test")
	tok := deviceSession(t, db, id, phoneUA, 24*time.Hour)
	media := NewMediaStore()
	put := func(data []byte) string {
		t.Helper()
		url, e := media.Put(ctx, id, data)
		if e != nil {
			t.Fatal(e)
		}
		return url
	}
	png := testPNG(t)
	cover, step, avatar, plated := put(testJPEG), put(png), put(testJPEG), put(png)
	gone := "https://media.example.com/" + id + "/gone.jpg"
	source := "https://cook.example/lemon-pasta"
	r := validRecipe()
	r.Title, r.Image, r.SourceURL = "Lemon & ricotta pasta / quick", cover, &source
	r.Photos = []string{gone, "https://images.example.com/elsewhere.jpg"}
	r.Ingredients = append(r.Ingredients, Ingredient{Name: "Salt", Unit: "to taste"}, Ingredient{Name: "Lemons", Amount: 1.5})
	r.Steps = []Step{{Title: "Boil", Text: "Cook the pasta.", Seconds: 600, Image: step}, {Title: "Toss", Text: "Toss with the lemon and ricotta."}}
	r.Equipment = []string{"Large pot"}
	if e := persistRecipe(ctx, db, id, "mine", r, false); e != nil {
		t.Fatal(e)
	}
	plain := validRecipe()
	plain.Title, plain.Published = "!!!", true
	if e := persistRecipe(ctx, db, id, "plain", plain, false); e != nil {
		t.Fatal(e)
	}
	theirs := testRecipe(t, db, other, "Their lovely soup", true)
	for _, sql := range []string{
		`UPDATE users SET avatar='` + avatar + `' WHERE id='` + id + `'`,
		`INSERT INTO collections(id,user_id,name,public) VALUES('cb1','` + id + `','Weeknights',true)`,
		`INSERT INTO saves(user_id,recipe_id,collection_id) VALUES('` + id + `','` + theirs + `','cb1')`,
		`INSERT INTO saves(user_id,recipe_id) VALUES('` + id + `','plain')`,
		`INSERT INTO meal_plans(id,user_id,recipe_id,day,meal,servings) VALUES('mp1','` + id + `','` + theirs + `','2026-10-20','Dinner',2)`,
		`INSERT INTO groceries(id,user_id,name,quantity) VALUES('g1','` + id + `','Lemons, unwaxed','3')`,
		`INSERT INTO cooks(id,user_id,recipe_id,note,photo) VALUES('k1','` + id + `','` + theirs + `','Made it twice.','` + plated + `')`,
	} {
		if _, e := db.Exec(ctx, sql); e != nil {
			t.Fatalf("%s: %v", sql, e)
		}
	}

	got := must(t, f, 200, call{method: "GET", path: "/v1/me/export/files", bearer: tok})
	if got.header.Get("Content-Type") != "application/zip" || !strings.HasPrefix(got.header.Get("Content-Disposition"), `attachment; filename="savorly-export-`) ||
		got.header.Get("Cache-Control") != "no-store, no-transform" {
		t.Fatalf("headers: %v", got.header)
	}
	files := unzip(t, got.body)
	root := exportName() + "/"
	recipe := root + "recipes/001-lemon-ricotta-pasta-quick/"
	for name, want := range map[string][]byte{
		recipe + "cover.jpg":                             testJPEG,
		recipe + "step-01.png":                           png,
		root + "profile-photo.jpg":                       testJPEG,
		root + "cooked-photos/001-their-lovely-soup.png": png,
	} {
		if !bytes.Equal(files[name], want) {
			t.Errorf("%s: %d bytes", name, len(files[name]))
		}
	}
	for _, name := range []string{root + "savorly-export.json", root + "README.txt", recipe + "recipe.md", recipe + "recipe.json", root + "recipes/002-recipe/recipe.md",
		root + "cookbooks.md", root + "meal-plans.csv", root + "grocery-list.csv", root + "saved-recipes.csv", root + "cooked.csv"} {
		if len(files[name]) == 0 {
			t.Errorf("missing %s", name)
		}
	}
	// Lists with nothing in them leave no file.
	for _, name := range []string{root + "pantry.csv", root + "reviews.csv", root + "creator-earnings.csv"} {
		if _, ok := files[name]; ok {
			t.Errorf("empty list as %s", name)
		}
	}
	md := string(files[recipe+"recipe.md"])
	for _, want := range []string{"# Lemon & ricotta pasta / quick\n", "![Cover photo](cover.jpg)", "- 200 g Pasta\n", "- Salt, to taste\n", "- 1.5 Lemons\n",
		"## Equipment\n\n- Large pot\n", "### 1. Boil\n\nCook the pasta.\n\nTimer: 10 minutes\n\n![Step 1 photo](step-01.png)", "- Source: " + source, "- Status: Private draft",
		"![Photo 1](<" + gone + ">)", "![Photo 2](<https://images.example.com/elsewhere.jpg>)"} {
		if !strings.Contains(md, want) {
			t.Errorf("recipe.md lacks %q:\n%s", want, md)
		}
	}
	readme := string(files[root+"README.txt"])
	for _, want := range []string{"Photo 1 of \"Lemon & ricotta pasta / quick\": " + gone + " (" + unreadableFile + ")", "elsewhere.jpg (" + notOwnFile + ")", "recipes/: a folder for each recipe", "meal-plans.csv: your meal plan"} {
		if !strings.Contains(readme, want) {
			t.Errorf("README lacks %q:\n%s", want, readme)
		}
	}
	if plan := string(files[root+"meal-plans.csv"]); !strings.HasPrefix(plan, "\ufeffday,meal,recipeTitle,servings,recipeId\n") || !strings.Contains(plan, "2026-10-20,Dinner,Their lovely soup,2,") {
		t.Errorf("meal-plans.csv: %q", plan)
	}
	if list := string(files[root+"grocery-list.csv"]); !strings.Contains(list, `"Lemons, unwaxed",3,`) {
		t.Errorf("grocery-list.csv: %q", list)
	}
	if books := string(files[root+"cookbooks.md"]); !strings.Contains(books, "## Weeknights\n\nShared: anyone with the link can see it.\n\n- Their lovely soup\n") || !strings.Contains(books, "## Saved, in no cookbook\n\n- !!!\n") {
		t.Errorf("cookbooks.md: %s", books)
	}
	var doc struct {
		Format  string
		Recipes []map[string]any
	}
	if e := json.Unmarshal(files[root+"savorly-export.json"], &doc); e != nil || doc.Format != "savorly-export" || len(doc.Recipes) != 2 {
		t.Fatalf("savorly-export.json: %v %v", doc, e)
	}
	// Someone else's recipe is only named, never exported as theirs.
	for name := range files {
		if strings.Contains(name, "their-lovely-soup/") {
			t.Errorf("exported %s", name)
		}
	}

	// The single-use link serves the files once, and a probe doesn't spend it.
	link := must(t, f, 200, call{method: "POST", path: "/v1/me/export-link", bearer: tok, body: map[string]string{"format": "files"}}).object(t)["url"].(string)
	if head := must(t, f, 200, call{method: "HEAD", path: link}); head.header.Get("Content-Type") != "application/zip" {
		t.Fatalf("probe: %v", head.header)
	}
	// One download at a time: while another runs, the link stays unspent.
	release, e := exportFilesSlot(id)
	if e != nil {
		t.Fatal(e)
	}
	if busy := must(t, f, 429, call{method: "GET", path: link}); busy.message() != "Your files are already downloading. Try again once that download has finished." {
		t.Fatalf("busy: %s", busy.body)
	}
	must(t, f, 429, call{method: "GET", path: "/v1/me/export/files", bearer: tok})
	release()
	if files := unzip(t, must(t, f, 200, call{method: "GET", path: link}).body); len(files[recipe+"cover.jpg"]) == 0 {
		t.Fatal("the link's download is missing files")
	}
	must(t, f, 404, call{method: "GET", path: link})
	// The JSON file stays the default, and nothing else is accepted.
	plainLink := must(t, f, 200, call{method: "POST", path: "/v1/me/export-link", bearer: tok}).object(t)["url"].(string)
	if json := must(t, f, 200, call{method: "GET", path: plainLink}); json.header.Get("Content-Type") != "application/json" {
		t.Fatalf("default link: %v", json.header)
	}
	if bad := must(t, f, 400, call{method: "POST", path: "/v1/me/export-link", bearer: tok, body: map[string]string{"format": "pdf"}}); bad.message() != "Choose the JSON file or the files." {
		t.Fatalf("bad format: %s", bad.body)
	}
	must(t, f, 401, call{method: "GET", path: "/v1/me/export/files"})
}

// Without storage, every file is listed by its address instead.
func TestExportAsFilesWithoutStorage(t *testing.T) {
	db := isolatedDB(t)
	ctx := context.Background()
	f := accountsApp(db, false)
	id := member(t, db, "files@example.test")
	tok := deviceSession(t, db, id, phoneUA, 24*time.Hour)
	r := validRecipe()
	r.Image = "https://media.example.com/" + id + "/cover.jpg"
	if e := persistRecipe(ctx, db, id, "mine", r, false); e != nil {
		t.Fatal(e)
	}
	files := unzip(t, must(t, f, 200, call{method: "GET", path: "/v1/me/export/files", bearer: tok}).body)
	root := exportName() + "/"
	if md := string(files[root+"recipes/001-lemon-pasta/recipe.md"]); !strings.Contains(md, "![Cover photo](<"+r.Image+">)") {
		t.Fatalf("recipe.md: %s", md)
	}
	if readme := string(files[root+"README.txt"]); !strings.Contains(readme, "Not included as files (1)") {
		t.Fatalf("README: %s", readme)
	}
}

func TestExportFileNames(t *testing.T) {
	for title, want := range map[string]string{
		"Lemon & ricotta pasta / quick": "lemon-ricotta-pasta-quick",
		"  Crème brûlée!  ":             "crème-brûlée",
		"麻婆豆腐":                          "麻婆豆腐",
		"!!!":                           "recipe",
		strings.Repeat("ab ", 40):       strings.TrimSuffix(strings.Repeat("ab-", 17), "-"),
	} {
		if got := fileSlug(title, "recipe"); got != want {
			t.Errorf("%q: %q, want %q", title, got, want)
		}
	}
	for seconds, want := range map[int]string{0: "", 45: "45 seconds", 60: "1 minute", 90: "90 seconds", 600: "10 minutes", 3600: "1 hour", 5400: "1 hour 30 minutes", 7260: "2 hours 1 minute"} {
		if got := spokenDuration(seconds); got != want {
			t.Errorf("%d: %q, want %q", seconds, got, want)
		}
	}
	for url, kind := range map[string]string{"https://m.example/a.JPG?x=1": ".jpg", "https://m.example/a": "", "https://m.example/clip": ".mp4"} {
		mime := ""
		if kind == ".mp4" {
			mime = "video/mp4"
		}
		if got := mediaExtension(url, mime); got != kind {
			t.Errorf("%s: %q, want %q", url, got, kind)
		}
	}
}

// Over a real connection the archive streams as it's written, and the member's download slot is
// free again once it ends.
func TestExportFilesStreamOverTheNetwork(t *testing.T) {
	storage := newMemoryS3(t)
	useMemoryS3(t, storage)
	db := isolatedDB(t)
	ctx := context.Background()
	f := accountsApp(db, false)
	id := member(t, db, "files@example.test")
	tok := deviceSession(t, db, id, phoneUA, 24*time.Hour)
	cover, e := NewMediaStore().Put(ctx, id, append(testJPEG, bytes.Repeat([]byte{1}, 2<<20)...))
	if e != nil {
		t.Fatal(e)
	}
	r := validRecipe()
	r.Image = cover
	if e = persistRecipe(ctx, db, id, "mine", r, false); e != nil {
		t.Fatal(e)
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer listener.Close()
	go func() { _ = f.Listener(listener, fiber.ListenConfig{DisableStartupMessage: true}) }()
	client := &http.Client{Timeout: 10 * time.Second}
	defer client.CloseIdleConnections()
	for range 2 {
		req, _ := http.NewRequest("GET", "http://"+listener.Addr().String()+"/v1/me/export/files", nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		res, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		b, e := io.ReadAll(res.Body)
		res.Body.Close()
		if e != nil || res.StatusCode != 200 || len(res.TransferEncoding) == 0 {
			t.Fatalf("download: %d %v %v", res.StatusCode, res.TransferEncoding, e)
		}
		if files := unzip(t, b); len(files[exportName()+"/recipes/001-lemon-pasta/cover.jpg"]) != len(testJPEG)+2<<20 {
			t.Fatal("the cover photo was cut short")
		}
	}
}
