package database

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrations embed.FS

//go:embed seed.json
var seedData []byte

func Open(ctx context.Context, url string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	config.MaxConns = 12
	config.MaxConnLifetime = 30 * time.Minute
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, err
	}
	if err = db.Ping(ctx); err != nil {
		db.Close()
		return nil, err
	}
	// Migrations are serialized so multiple API replicas can start safely.
	tx, err := db.Begin(ctx)
	if err != nil {
		db.Close()
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7182301)"); err != nil {
		_ = tx.Rollback(ctx)
		db.Close()
		return nil, err
	}
	if _, err = tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		_ = tx.Rollback(ctx)
		db.Close()
		return nil, err
	}
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		_ = tx.Rollback(ctx)
		db.Close()
		return nil, err
	}
	for _, entry := range entries {
		var applied bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)`, entry.Name()).Scan(&applied); err != nil {
			break
		}
		if applied {
			continue
		}
		var sql []byte
		sql, err = migrations.ReadFile("migrations/" + entry.Name())
		if err != nil {
			break
		}
		if _, err = tx.Exec(ctx, string(sql)); err != nil {
			break
		}
		if _, err = tx.Exec(ctx, `INSERT INTO schema_migrations(version) VALUES($1)`, entry.Name()); err != nil {
			break
		}
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		_ = tx.Rollback(ctx)
		db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	return db, nil
}

func Seed(ctx context.Context, db *pgxpool.Pool) error {
	var data struct {
		Users   []struct{ ID, Name, Handle, Bio, Avatar string }
		Recipes []json.RawMessage
	}
	if err := json.Unmarshal(seedData, &data); err != nil {
		return err
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, u := range data.Users {
		_, err = tx.Exec(ctx, `INSERT INTO users(id,email,password_hash,name,handle,bio,avatar) VALUES($1,$2,'!disabled',$3,$4,$5,$6) ON CONFLICT DO NOTHING`, u.ID, u.Handle+"@test-kitchen.invalid", u.Name, u.Handle, u.Bio, u.Avatar)
		if err != nil {
			return err
		}
	}
	for _, raw := range data.Recipes {
		var r struct {
			ID                                                    string
			AuthorID                                              string `json:"authorId"`
			Title, Description, Cuisine, Difficulty, Image, Video string
			Minutes, Servings, Calories                           int
			Tags, Equipment                                       []string
			Ingredients, Steps, Photos                            json.RawMessage
		}
		if err = json.Unmarshal(raw, &r); err != nil {
			return err
		}
		// Seed recipes already in the database only pick up a gallery or an equipment list they
		// don't have yet.
		_, err = tx.Exec(ctx, `INSERT INTO recipes(id,author_id,title,description,cuisine,minutes,servings,difficulty,image,video,ingredients,steps,tags,calories,photos,equipment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15::jsonb,'[]'),COALESCE($16::text[],'{}'))
 ON CONFLICT (id) DO UPDATE SET photos=CASE WHEN recipes.photos='[]' THEN excluded.photos ELSE recipes.photos END,
  equipment=CASE WHEN recipes.equipment='{}' THEN excluded.equipment ELSE recipes.equipment END
 WHERE (recipes.photos='[]' AND excluded.photos<>'[]') OR (recipes.equipment='{}' AND excluded.equipment<>'{}')`, r.ID, r.AuthorID, r.Title, r.Description, r.Cuisine, r.Minutes, r.Servings, r.Difficulty, r.Image, r.Video, r.Ingredients, r.Steps, r.Tags, r.Calories, r.Photos, r.Equipment)
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
