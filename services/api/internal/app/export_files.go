package app

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gofiber/fiber/v3"
	"github.com/jackc/pgx/v5"
)

// The data export as files (GET /me/export/files, or a link from POST /me/export-link with
// {"format":"files"}): one ZIP a member can keep and open without Savorly, written while it
// downloads and never held whole in memory. It holds the JSON export (export.go) as it is, a
// folder for each of the member's recipes (recipe.md to read, recipe.json, and the photos, step
// photos and clips copied from storage), the lists as CSV files, and a README.txt saying what
// each is. Only the member's own files are copied (MediaStore.Own); any other address, and any
// file storage can't give, is listed in the README instead.
//
// A new key in exportSQL is in savorly-export.json by itself. To give it files as well, add a
// line: to exportTables for a CSV file of its items, and to exportFolders for a folder of the
// media files they name (family recipe recordings, say).

// exportTable is a list in the JSON export written as a CSV file: its JSON key, the file, what
// it holds (for the README), and the item fields kept, which are also its header row.
type exportTable struct {
	key, file, about string
	fields           []string
}

var exportTables = []exportTable{
	{"cookbooks", "cookbooks.csv", "your cookbooks", []string{"name", "description", "public", "createdAt", "id"}},
	{"saves", "saved-recipes.csv", "the recipes you saved, and the cookbook each is in", []string{"recipeTitle", "cookbookId", "savedAt", "recipeId"}},
	{"mealPlans", "meal-plans.csv", "your meal plan", []string{"day", "meal", "recipeTitle", "servings", "recipeId"}},
	{"groceries", "grocery-list.csv", "your grocery list", []string{"name", "quantity", "category", "checked", "createdAt"}},
	{"pantry", "pantry.csv", "your pantry", []string{"name", "quantity", "expiresOn"}},
	{"reviews", "reviews.csv", "the reviews you wrote", []string{"recipeTitle", "rating", "body", "createdAt", "updatedAt", "recipeId"}},
	{"reviewReplies", "review-replies.csv", "your answers to reviews of your recipes", []string{"recipeTitle", "reply", "repliedAt", "recipeId"}},
	{"comments", "comments.csv", "the comments you wrote", []string{"recipeTitle", "body", "createdAt", "updatedAt", "replyTo", "id", "recipeId"}},
	{"cooked", "cooked.csv", "the recipes you said you cooked", []string{"recipeTitle", "note", "photo", "createdAt", "recipeId"}},
	{"cookSessions", "cooking-sessions.csv", "the recipes you cooked in cooking mode, and how far you got", []string{"recipeTitle", "startedAt", "finishedAt", "stepReached", "steps", "verifiedCook", "recipeId"}},
	{"following", "following.csv", "the cooks you follow", []string{"name", "handle", "id"}},
	{"creatorEarnings", "creator-earnings.csv", "what your recipes earned from the creator fund, by month, in US cents", []string{"month", "cooks", "amountCents", "status", "paidAt"}},
	{"creatorPayouts", "creator-payouts.csv", "the creator fund's payouts to you, in US cents", []string{"amountCents", "status", "createdAt"}},
	{"cookQuestions", "cooking-questions.csv", "what you asked at a step while cooking", []string{"recipeTitle", "step", "question", "askedAt", "recipeId"}},
	{"recipeEdits", "your-versions.csv", "your own changes to other cooks' recipes (the changes themselves are in savorly-export.json)", []string{"recipeTitle", "kind", "said", "updatedAt", "recipeId"}},
	{"kitchenNotes", "kitchen-notes.csv", "what you told Savorly about your kitchen and taste", []string{"note", "createdAt"}},
	{"recipeSuggestions", "suggested-fixes.csv", "the fixes you suggested to other cooks' recipes", []string{"recipeTitle", "kind", "reason", "status", "response", "createdAt", "decidedAt", "recipeId"}},
	{"connectedApps", "connected-apps.csv", "the assistants linked to your account", []string{"app", "linkedAt", "lastUsedAt"}},
}

// exportFolder copies the media files a list's items name into a folder: its JSON key, the
// folder, what it holds, the item fields with a file's address (or a list of addresses), and the
// field each file is named after.
type exportFolder struct {
	key, folder, about string
	fields             []string
	name               string
}

var exportFolders = []exportFolder{
	{"cooked", "cooked-photos", "the photos you added when you said you cooked a recipe", []string{"photo"}, "recipeTitle"},
	{"recordings", "family-recordings", "your family recordings, named after who is speaking (their transcripts are in savorly-export.json)", []string{"url"}, "speaker"},
}

// A download streams storage to its member for as long as it takes, so each member has one at a
// time and this process writes at most exportFilesAtOnce, for at most exportFilesTime each.
const (
	exportFilesAtOnce = 4
	exportFilesTime   = 2 * time.Hour
	// exportWriteWindow is how long a write to the download may take before it gives up.
	exportWriteWindow = time.Minute
)

var (
	exportFilesRunning sync.Map
	exportFilesSlots   = make(chan struct{}, exportFilesAtOnce)
)

// exportFilesSlot reserves a download of owner's files; release ends it.
func exportFilesSlot(owner string) (release func(), e error) {
	if _, busy := exportFilesRunning.LoadOrStore(owner, true); busy {
		return nil, fiber.NewError(429, "Your files are already downloading. Try again once that download has finished.")
	}
	select {
	case exportFilesSlots <- struct{}{}:
	default:
		exportFilesRunning.Delete(owner)
		return nil, fiber.NewError(503, "Many downloads are running right now. Try again in a few minutes.")
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			<-exportFilesSlots
			exportFilesRunning.Delete(owner)
		})
	}, nil
}

func (a *App) exportFilesMe(c fiber.Ctx) error {
	release, e := exportFilesSlot(userID(c))
	if e != nil {
		return e
	}
	return a.sendExportFiles(c, userID(c), release)
}

// exportName names the download, and the folder inside it, after today.
func exportName() string { return "savorly-export-" + time.Now().UTC().Format("2006-01-02") }

func exportFilesHeaders(c fiber.Ctx) {
	c.Set("Content-Type", "application/zip")
	c.Set("Content-Disposition", `attachment; filename="`+exportName()+`.zip"`)
	// no-transform: photos and clips are compressed already, and compressing the stream would
	// hold it back.
	c.Set("Cache-Control", "no-store, no-transform")
}

// sendExportFiles answers with owner's export as a ZIP, streamed: the JSON export is read now,
// and storage file by file while the client downloads. release (exportFilesSlot) is called once
// the download ends, however it ends.
func (a *App) sendExportFiles(c fiber.Ctx, owner string, release func()) error {
	var doc []byte
	if e := a.DB.QueryRow(c.Context(), exportSQL, owner).Scan(&doc); e != nil {
		release()
		if errors.Is(e, pgx.ErrNoRows) {
			return fiber.NewError(404, "This item could not be found.")
		}
		return e
	}
	exportFilesHeaders(c)
	// The response is written after the handler returns, by then under the server's WriteTimeout;
	// each write moves the connection's deadline on, so a large download goes on while data flows.
	conn := c.RequestCtx().Conn()
	base := a.Context
	if base == nil {
		base = context.Background()
	}
	root := exportName() + "/"
	return c.SendStreamWriter(func(w *bufio.Writer) {
		defer release()
		ctx, cancel := context.WithTimeout(base, exportFilesTime)
		defer cancel()
		zw := zip.NewWriter(&deadlineWriter{w: w, conn: conn})
		x := &exportZip{ctx: ctx, zip: zw, store: a.Media, owner: owner, root: root, flush: func() error {
			if e := zw.Flush(); e != nil {
				return e
			}
			return w.Flush()
		}}
		if e := x.write(doc); e != nil {
			slog.Warn("export files stopped", "userId", owner, "error", e)
		}
	})
}

// deadlineWriter moves the connection's write deadline on as the download is written, at most
// once a second.
type deadlineWriter struct {
	w     io.Writer
	conn  net.Conn
	moved time.Time
}

func (d *deadlineWriter) Write(p []byte) (int, error) {
	if d.conn != nil && time.Since(d.moved) > time.Second {
		d.moved = time.Now()
		_ = d.conn.SetWriteDeadline(d.moved.Add(exportWriteWindow))
	}
	return d.w.Write(p)
}

// exportZip writes one member's export as files under root.
type exportZip struct {
	ctx         context.Context
	zip         *zip.Writer
	flush       func() error
	store       *MediaStore
	owner, root string
	// contents is what the archive holds, and left what it lists instead, for the README.
	contents, left []string
}

func (x *exportZip) write(doc []byte) error {
	var all map[string]json.RawMessage
	if e := json.Unmarshal(doc, &all); e != nil {
		return e
	}
	var pretty bytes.Buffer
	if e := json.Indent(&pretty, doc, "", "  "); e != nil {
		return e
	}
	if e := x.text("savorly-export.json", pretty.Bytes(), "everything Savorly keeps for your account in one JSON file: all the files below show, and more (your sous-chef conversations, devices and imports)"); e != nil {
		return e
	}
	if e := x.recipes(all["recipes"]); e != nil {
		return e
	}
	if e := x.cookbooks(all["cookbooks"], all["saves"]); e != nil {
		return e
	}
	for _, t := range exportTables {
		if e := x.table(t, all[t.key]); e != nil {
			return e
		}
	}
	for _, f := range exportFolders {
		if e := x.folder(f, all[f.key]); e != nil {
			return e
		}
	}
	var profile struct{ Name, Handle, Avatar string }
	_ = json.Unmarshal(all["profile"], &profile)
	if name, e := x.media("", "profile-photo", profile.Avatar, "Your profile photo"); e != nil {
		return e
	} else if name != "" {
		x.contents = append(x.contents, name+": your profile photo")
	}
	if e := x.text("README.txt", x.readme(profile.Name, profile.Handle), ""); e != nil {
		return e
	}
	return x.zip.Close()
}

// text adds a file of text; about, if any, says in the README what it is.
func (x *exportZip) text(name string, b []byte, about string) error {
	if e := x.ctx.Err(); e != nil {
		return e
	}
	w, e := x.zip.CreateHeader(&zip.FileHeader{Name: x.root + name, Method: zip.Deflate, Modified: time.Now()})
	if e == nil {
		_, e = w.Write(b)
	}
	if e != nil {
		return e
	}
	if about != "" {
		x.contents = append(x.contents, name+": "+about)
	}
	return x.flush()
}

// readTracker remembers why reading failed, telling a file storage cut short from a download
// that stopped.
type readTracker struct {
	r   io.Reader
	err error
}

func (t *readTracker) Read(p []byte) (int, error) {
	n, e := t.r.Read(p)
	if e != nil && !errors.Is(e, io.EOF) {
		t.err = e
	}
	return n, e
}

// Why a file is listed in the README rather than included.
const (
	notOwnFile     = "it's kept at this address rather than in your Savorly storage"
	unreadableFile = "storage couldn't give it during this download"
	cutShortFile   = "the copy was cut short"
)

// media copies one of the member's own files into the archive as dir+base and its extension, and
// answers that name. Anything else is listed in the README as what, with its address: an
// address that isn't the member's own file, or one storage can't give. Only a failing download
// is an error.
func (x *exportZip) media(dir, base, url, what string) (string, error) {
	if url == "" {
		return "", nil
	}
	if e := x.ctx.Err(); e != nil {
		return "", e
	}
	if x.store == nil || !x.store.Own(x.owner, url) {
		x.leave(what, url, notOwnFile)
		return "", nil
	}
	body, kind, e := x.store.Open(x.ctx, x.owner, url)
	if e != nil {
		slog.Info("export file unavailable", "userId", x.owner, "error", e)
		x.leave(what, url, unreadableFile)
		return "", nil
	}
	defer body.Close()
	name := dir + base + mediaExtension(url, kind)
	// Photos and clips are compressed already: stored as they are.
	w, e := x.zip.CreateHeader(&zip.FileHeader{Name: x.root + name, Method: zip.Store, Modified: time.Now()})
	if e != nil {
		return "", e
	}
	src := &readTracker{r: body}
	if _, e = io.Copy(w, src); e != nil {
		if src.err == nil {
			return "", e
		}
		x.leave(what, url, cutShortFile)
	}
	return name, x.flush()
}

func (x *exportZip) leave(what, url, why string) {
	x.left = append(x.left, fmt.Sprintf("- %s: %s (%s)", what, url, why))
}

// mediaExtension is a stored file's extension: its address's, or else its type's.
func mediaExtension(url, kind string) string {
	ext := strings.ToLower(path.Ext(strings.SplitN(url, "?", 2)[0]))
	switch ext {
	case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".mp4", ".webm", ".mov", ".m4a", ".mp3", ".wav", ".ogg", ".aac":
		return ext
	}
	switch strings.TrimSpace(strings.SplitN(kind, ";", 2)[0]) {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	case "video/mp4":
		return ".mp4"
	case "video/webm":
		return ".webm"
	case "audio/mpeg":
		return ".mp3"
	case "audio/mp4":
		return ".m4a"
	case "audio/webm", "audio/ogg":
		return ".ogg"
	}
	return ""
}

// exportRecipe is what a recipe's files are made from, as the JSON export has it.
type exportRecipe struct {
	ID          string       `json:"id"`
	Title       string       `json:"title"`
	Description string       `json:"description"`
	Cuisine     string       `json:"cuisine"`
	Minutes     int          `json:"minutes"`
	Servings    int          `json:"servings"`
	Difficulty  string       `json:"difficulty"`
	Calories    int          `json:"calories"`
	Tags        []string     `json:"tags"`
	Ingredients []Ingredient `json:"ingredients"`
	Steps       []Step       `json:"steps"`
	Equipment   []string     `json:"equipment"`
	Image       string       `json:"image"`
	Photos      []string     `json:"photos"`
	Video       string       `json:"video"`
	Language    string       `json:"language"`
	SourceURL   string       `json:"sourceUrl"`
	AIGenerated bool         `json:"aiGenerated"`
	Published   bool         `json:"published"`
	CreatedAt   string       `json:"createdAt"`
}

// recipes writes a folder for each recipe: its media, recipe.md and recipe.json.
func (x *exportZip) recipes(raw json.RawMessage) error {
	var list []json.RawMessage
	if len(raw) > 0 {
		if e := json.Unmarshal(raw, &list); e != nil {
			return e
		}
	}
	for i, item := range list {
		var r exportRecipe
		if e := json.Unmarshal(item, &r); e != nil {
			return e
		}
		dir := fmt.Sprintf("recipes/%03d-%s/", i+1, fileSlug(r.Title, "recipe"))
		// files maps each address to its file in the folder, so the Markdown shows the copy.
		files := map[string]string{}
		add := func(base, url, what string) error {
			if _, done := files[url]; done || url == "" {
				return nil
			}
			name, e := x.media(dir, base, url, what+" of "+strconv.Quote(oneLine(r.Title)))
			if name != "" {
				files[url] = path.Base(name)
			}
			return e
		}
		e := add("cover", r.Image, "The cover photo")
		for n, p := range r.Photos {
			if e == nil {
				e = add(fmt.Sprintf("photo-%d", n+1), p, fmt.Sprintf("Photo %d", n+1))
			}
		}
		if e == nil {
			e = add("video", r.Video, "The video")
		}
		for n, s := range r.Steps {
			if e == nil {
				e = add(fmt.Sprintf("step-%02d", n+1), s.Image, fmt.Sprintf("Step %d's photo", n+1))
			}
			if e == nil {
				e = add(fmt.Sprintf("step-%02d-clip", n+1), s.Video, fmt.Sprintf("Step %d's clip", n+1))
			}
		}
		if e != nil {
			return e
		}
		if e = x.text(dir+"recipe.md", []byte(recipeMarkdown(r, files)), ""); e != nil {
			return e
		}
		var pretty bytes.Buffer
		if e = json.Indent(&pretty, item, "", "  "); e != nil {
			return e
		}
		if e = x.text(dir+"recipe.json", pretty.Bytes(), ""); e != nil {
			return e
		}
	}
	if len(list) > 0 {
		x.contents = append(x.contents, "recipes/: a folder for each recipe you wrote or imported, drafts included, with recipe.md to read or print, recipe.json with the same as data, and its photos, step photos and clips")
	}
	return nil
}

// recipeMarkdown is a recipe to read: its facts, ingredients, equipment and method, showing the
// archive's copy of each photo where there is one (files) and its address otherwise.
func recipeMarkdown(r exportRecipe, files map[string]string) string {
	link := func(url string) string {
		if name, ok := files[url]; ok {
			return name
		}
		return "<" + url + ">"
	}
	var b strings.Builder
	b.WriteString("# " + oneLine(r.Title) + "\n\n")
	if r.Image != "" {
		b.WriteString("![Cover photo](" + link(r.Image) + ")\n\n")
	}
	if r.Description != "" {
		b.WriteString(r.Description + "\n\n")
	}
	var facts []string
	fact := func(label, value string) {
		if value != "" {
			facts = append(facts, "- "+label+": "+value)
		}
	}
	fact("Cuisine", r.Cuisine)
	fact("Time", spokenDuration(r.Minutes*60))
	if r.Servings > 0 {
		fact("Servings", strconv.Itoa(r.Servings))
	}
	fact("Difficulty", r.Difficulty)
	if r.Calories > 0 {
		fact("Calories", strconv.Itoa(r.Calories))
	}
	fact("Tags", strings.Join(r.Tags, ", "))
	fact("Language", r.Language)
	if r.Published {
		fact("Status", "Published")
	} else {
		fact("Status", "Private draft")
	}
	if r.AIGenerated {
		fact("Made with AI", "Yes")
	}
	fact("Source", r.SourceURL)
	if len(r.CreatedAt) >= 10 {
		fact("Added", r.CreatedAt[:10])
	}
	b.WriteString(strings.Join(facts, "\n") + "\n\n## Ingredients\n\n")
	for _, in := range r.Ingredients {
		b.WriteString("- " + ingredientLine(in) + "\n")
	}
	if len(r.Equipment) > 0 {
		b.WriteString("\n## Equipment\n\n")
		for _, e := range r.Equipment {
			b.WriteString("- " + oneLine(e) + "\n")
		}
	}
	b.WriteString("\n## Method\n")
	for i, s := range r.Steps {
		fmt.Fprintf(&b, "\n### %d. %s\n\n%s\n", i+1, oneLine(s.Title), s.Text)
		if s.Seconds > 0 {
			b.WriteString("\nTimer: " + spokenDuration(s.Seconds) + "\n")
		}
		if s.Image != "" {
			fmt.Fprintf(&b, "\n![Step %d photo](%s)\n", i+1, link(s.Image))
		}
		if s.Video != "" {
			fmt.Fprintf(&b, "\n[Step %d clip](%s)\n", i+1, link(s.Video))
		}
	}
	if r.Video != "" || len(r.Photos) > 0 {
		b.WriteString("\n## Photos and video\n\n")
		for n, p := range r.Photos {
			fmt.Fprintf(&b, "![Photo %d](%s)\n\n", n+1, link(p))
		}
		if r.Video != "" {
			b.WriteString("[Video](" + link(r.Video) + ")\n")
		}
	}
	return b.String()
}

// ingredientLine is an ingredient as a recipe card writes it: "200 g spaghetti", "salt, to taste".
func ingredientLine(in Ingredient) string {
	line := oneLine(in.Name)
	if in.Amount > 0 {
		amount := strconv.FormatFloat(math.Round(in.Amount*100)/100, 'f', -1, 64)
		return strings.Join(strings.Fields(amount+" "+in.Unit+" "+line), " ")
	}
	if in.Unit != "" {
		line += ", " + in.Unit
	}
	return line
}

// spokenDuration says a number of seconds in hours, minutes or seconds ("1 hour 30 minutes").
func spokenDuration(seconds int) string {
	unit := func(n int, one string) string {
		if n == 1 {
			return "1 " + one
		}
		return strconv.Itoa(n) + " " + one + "s"
	}
	switch {
	case seconds <= 0:
		return ""
	case seconds < 120 && seconds%60 != 0:
		return unit(seconds, "second")
	}
	minutes := int(math.Round(float64(seconds) / 60))
	if minutes < 60 {
		return unit(minutes, "minute")
	}
	if minutes%60 == 0 {
		return unit(minutes/60, "hour")
	}
	return unit(minutes/60, "hour") + " " + unit(minutes%60, "minute")
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

// fileSlug is title as part of a file name: lowercase letters and digits in any script, with
// hyphens between words, up to 50 characters; fallback when nothing is left.
func fileSlug(title, fallback string) string {
	var b strings.Builder
	hyphen := false
	for _, r := range strings.ToLower(title) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			if hyphen && b.Len() > 0 {
				b.WriteByte('-')
			}
			hyphen = false
			b.WriteRune(r)
			if utf8.RuneCountInString(b.String()) >= 50 {
				break
			}
		} else {
			hyphen = true
		}
	}
	if b.Len() == 0 {
		return fallback
	}
	return b.String()
}

// table writes a list as a CSV file in UTF-8, with the mark that tells spreadsheets so.
func (x *exportZip) table(t exportTable, raw json.RawMessage) error {
	var items []map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &items) != nil || len(items) == 0 {
		return nil
	}
	b := bytes.NewBufferString("\ufeff")
	w := csv.NewWriter(b)
	_ = w.Write(t.fields)
	for _, item := range items {
		row := make([]string, len(t.fields))
		for i, field := range t.fields {
			row[i] = cellText(item[field])
		}
		_ = w.Write(row)
	}
	w.Flush()
	if e := w.Error(); e != nil {
		return e
	}
	return x.text(t.file, b.Bytes(), t.about)
}

// cellText is a JSON value as a spreadsheet cell.
func cellText(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	}
	return string(jsonBytes(v))
}

// cookbooks writes cookbooks.md: each cookbook with the recipes saved in it, then the recipes
// saved in none.
func (x *exportZip) cookbooks(books, saves json.RawMessage) error {
	var shelf []struct {
		ID, Name, Description string
		Public                bool
	}
	var saved []struct {
		RecipeTitle string  `json:"recipeTitle"`
		CookbookID  *string `json:"cookbookId"`
	}
	_ = json.Unmarshal(books, &shelf)
	_ = json.Unmarshal(saves, &saved)
	if len(shelf) == 0 && len(saved) == 0 {
		return nil
	}
	var b strings.Builder
	b.WriteString("# Cookbooks\n")
	in := func(id *string) {
		empty := true
		for _, s := range saved {
			if (s.CookbookID == nil && id == nil) || (s.CookbookID != nil && id != nil && *s.CookbookID == *id) {
				b.WriteString("- " + oneLine(s.RecipeTitle) + "\n")
				empty = false
			}
		}
		if empty {
			b.WriteString("No recipes yet.\n")
		}
	}
	for _, book := range shelf {
		b.WriteString("\n## " + oneLine(book.Name) + "\n\n")
		if book.Description != "" {
			b.WriteString(book.Description + "\n\n")
		}
		if book.Public {
			b.WriteString("Shared: anyone with the link can see it.\n\n")
		}
		in(&book.ID)
	}
	for _, s := range saved {
		if s.CookbookID == nil {
			b.WriteString("\n## Saved, in no cookbook\n\n")
			in(nil)
			break
		}
	}
	return x.text("cookbooks.md", []byte(b.String()), "your cookbooks and the recipes saved in each")
}

// folder copies the files a list's items name into f.folder, numbered in the list's order.
func (x *exportZip) folder(f exportFolder, raw json.RawMessage) error {
	var items []map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &items) != nil {
		return nil
	}
	wrote := false
	for i, item := range items {
		label := cellText(item[f.name])
		n := 0
		for _, field := range f.fields {
			for _, url := range addresses(item[field]) {
				n++
				base := fmt.Sprintf("%03d-%s", i+1, fileSlug(label, f.key))
				if n > 1 {
					base += "-" + strconv.Itoa(n)
				}
				name, e := x.media(f.folder+"/", base, url, f.folder+", "+strconv.Quote(oneLine(label)))
				if e != nil {
					return e
				}
				wrote = wrote || name != ""
			}
		}
	}
	if wrote {
		x.contents = append(x.contents, f.folder+"/: "+f.about)
	}
	return nil
}

// addresses are the file addresses a field holds: one, or a list.
func addresses(v any) []string {
	switch x := v.(type) {
	case string:
		if x != "" {
			return []string{x}
		}
	case []any:
		var out []string
		for _, item := range x {
			out = append(out, addresses(item)...)
		}
		return out
	}
	return nil
}

// readme says what the archive holds and lists what it doesn't.
func (x *exportZip) readme(name, handle string) []byte {
	var b strings.Builder
	b.WriteString("Savorly: everything in your kitchen, as files\n\n")
	fmt.Fprintf(&b, "Downloaded on %s", time.Now().UTC().Format("2 January 2006"))
	if name != "" {
		fmt.Fprintf(&b, " for %s", oneLine(name))
		if handle != "" {
			fmt.Fprintf(&b, " (@%s)", handle)
		}
	}
	b.WriteString(".\n\nThese files are yours to keep, and they open without Savorly: each recipe.md is plain text (Markdown) that any text editor shows, the .csv files open in any spreadsheet (they're UTF-8), and the photos and clips are ordinary image and video files. Most recipe apps can take a recipe's text from recipe.md, or its data from recipe.json.\n\nWhat's here\n\n")
	for _, c := range x.contents {
		b.WriteString("- " + c + "\n")
	}
	if len(x.left) > 0 {
		fmt.Fprintf(&b, "\nNot included as files (%d)\n\nThese are listed with their addresses instead:\n\n", len(x.left))
		for _, l := range x.left {
			b.WriteString(l + "\n")
		}
	}
	return []byte(b.String())
}
