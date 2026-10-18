package app

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gofiber/fiber/v3"
	"github.com/gofiber/fiber/v3/middleware/compress"
	"github.com/gofiber/fiber/v3/middleware/cors"
	"github.com/gofiber/fiber/v3/middleware/helmet"
	"github.com/gofiber/fiber/v3/middleware/limiter"
	"github.com/gofiber/fiber/v3/middleware/recover"
	"github.com/gofiber/fiber/v3/middleware/requestid"
	"github.com/jackc/pgx/v5/pgxpool"
	"savorly/api/internal/ai"
	"savorly/api/internal/live"
	"savorly/api/internal/narration"
)

type Config struct {
	Production bool
	Origins    []string
	// ProxyHeader carries the client IP when a gateway that always overwrites it fronts the
	// API, so rate limits apply per visitor rather than to the gateway's own address.
	ProxyHeader string
}

func Env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
func LoadConfig() Config {
	return Config{Production: os.Getenv("APP_ENV") == "production", Origins: strings.Split(Env("ALLOWED_ORIGINS", "http://localhost:8081"), ","), ProxyHeader: os.Getenv("TRUSTED_PROXY_HEADER")}
}

type App struct {
	DB               *pgxpool.Pool
	Config           Config
	AI               *ai.Client
	Media            *MediaStore
	Live             *live.Client
	Narrator         *narration.Client
	NarrationStreams narration.Hub
	Context          context.Context
	agentOnce        sync.Once
	agentRouter      *fiber.App
	// turns holds the cancel function of each sous-chef turn running here, by id.
	turns     sync.Map
	oidcOnce  sync.Once
	verifiers map[string]*oidc.IDTokenVerifier
	throttles accountThrottles
	// translations shares and limits recipe translations (translations.go).
	translations translationWork
}

// errorHandler answers in JSON. requestId lets support find the request's log lines.
func errorHandler(c fiber.Ctx, err error) error {
	code := 500
	message := "Something went wrong. Please try again."
	rid := requestid.FromContext(c)
	var fe *fiber.Error
	if errors.As(err, &fe) {
		code = fe.Code
		message = fe.Message
	} else {
		slog.Error("request failed", "error", err, "path", c.Path(), "requestId", rid)
	}
	body := fiber.Map{"error": message}
	if rid != "" {
		body["requestId"] = rid
	}
	return c.Status(code).JSON(body)
}

// rateLimit answers in JSON like every other API error, so the app can show the message.
func rateLimit(max int, window time.Duration) fiber.Handler {
	return limiter.New(limiter.Config{Max: max, Expiration: window, LimitReached: func(c fiber.Ctx) error {
		return fiber.NewError(429, "Too many requests. Please wait a moment and try again.")
	}})
}
func New(db *pgxpool.Pool, config Config) *fiber.App {
	return NewWithContext(context.Background(), db, config)
}
func NewWithContext(ctx context.Context, db *pgxpool.Pool, config Config) *fiber.App {
	a := &App{DB: db, Config: config, AI: ai.New(), Media: NewMediaStore(), Live: live.New(), Narrator: narration.New(), Context: ctx}
	fc := fiber.Config{AppName: "Savorly API", BodyLimit: 55 * 1024 * 1024, ReadTimeout: mediaReadTimeout, WriteTimeout: 30 * time.Second, ErrorHandler: errorHandler}
	if config.ProxyHeader != "" {
		// Only configured where the gateway is the sole route in (Cloudflare Containers have no
		// public address), so every peer is that gateway.
		fc.ProxyHeader, fc.TrustProxy = config.ProxyHeader, true
		fc.TrustProxyConfig = fiber.TrustProxyConfig{Proxies: []string{"0.0.0.0/0", "::/0"}}
	}
	f := fiber.New(fc)
	f.Use(requestid.New(), accessLog, recover.New(recover.Config{EnableStackTrace: true, StackTraceHandler: logPanic}), helmet.New(), compress.New(compress.Config{Next: skipCompression}))
	f.Use(cors.New(cors.Config{AllowOrigins: config.Origins, AllowCredentials: true, AllowMethods: []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}, AllowHeaders: []string{"Content-Type", "Authorization", "Idempotency-Key"}}))
	f.Use(func(c fiber.Ctx) error {
		// Cookies require an allowed Origin on mutation requests. Native clients use bearer tokens.
		if c.Method() != "GET" && c.Method() != "HEAD" && c.Method() != "OPTIONS" {
			if c.Path() != "/v1/media" && !(strings.HasPrefix(c.Path(), "/v1/recipe-studio/") && strings.HasSuffix(c.Path(), "/images")) && len(c.Body()) > 128*1024 {
				return fiber.NewError(413, "This request is too large.")
			}
			origin := c.Get("Origin")
			if origin != "" {
				allowed := false
				for _, o := range config.Origins {
					if o == origin {
						allowed = true
					}
				}
				if !allowed {
					return fiber.NewError(403, "Origin is not allowed.")
				}
			}
			if c.Cookies("savorly_session") != "" && origin == "" && c.Get("Authorization") == "" {
				return fiber.NewError(403, "An Origin header is required.")
			}
		}
		return c.Next()
	})
	// The MCP server and its OAuth endpoints come first, with limits of their own (oauth_server.go).
	a.assistantServer(f)
	f.Use(rateLimit(300, time.Minute))
	f.Get("/health", func(c fiber.Ctx) error {
		ctx, cancel := context.WithTimeout(c.Context(), 2*time.Second)
		defer cancel()
		if err := db.Ping(ctx); err != nil {
			return fiber.NewError(503, "Database unavailable.")
		}
		return c.JSON(fiber.Map{"status": "ok"})
	})
	v := f.Group("/v1")
	v.Get("/capabilities", func(c fiber.Ctx) error {
		// The admin console's site-wide announcement; capabilities still answer if it can't load.
		var announcement fiber.Map
		if db != nil { // unit tests build the app without one
			if s, e := loadSettings(c.Context(), db); e != nil {
				slog.Warn("load operator settings", "error", e)
			} else if s.Announcement != "" {
				announcement = fiber.Map{"text": s.Announcement, "tone": s.AnnouncementTone}
			}
		}
		return c.JSON(fiber.Map{
			"announcement":     announcement,
			"cookingNarration": a.Narrator.Enabled(), "cookingNarrationModel": narration.Model,
			"voiceAI": a.Live.Enabled() && a.AI.TextEnabled(), "voiceModel": a.Live.ModelID(),
			"voicePerMinuteUSD": 0.05,
			"recipeChat":        a.AI.TextEnabled(), "recipePhotos": a.AI.TextEnabled() && a.Media.S3 != nil,
			"textAI": a.AI.TextEnabled(), "recipeModel": a.AI.RecipeModel, "agentModel": a.AI.AgentModel,
			"imageAI": a.AI.TextEnabled(), "imageModel": a.AI.ImageModel, "imageEditModel": a.AI.ImageEditModel,
			"videoAI": a.AI.VideoEnabled(), "videoProvider": "reAPI", "videoModel": a.AI.VideoModel, "videoEstimateUSD": 1.005,
			"recipeTranslation": a.AI.TextEnabled(), "translationModel": a.AI.TranslationModel,
			"passwordRecovery": emailEnabled(),
			"turnstileSiteKey": turnstileSiteKey(),
			"plans":            paidPlans(), "billing": billingEnabled(), "appleSignIn": len(oauthAudiences("apple")) > 0, "googleSignIn": len(oauthAudiences("google")) > 0,
			"creatorFund": creatorFundEnabled(),
			// Ordering the grocery list or a recipe's ingredients (grocery_checkout.go): "instacart" or "".
			"groceryCheckout": groceryCheckoutProvider(),
			// Public client identifiers the sign-in SDKs need; none of these are secrets.
			"auth": fiber.Map{"googleWebClientId": os.Getenv("GOOGLE_WEB_CLIENT_ID"), "googleIosClientId": os.Getenv("GOOGLE_IOS_CLIENT_ID"), "appleServicesId": os.Getenv("APPLE_SERVICES_ID"), "appleRedirectUri": os.Getenv("APPLE_REDIRECT_URI")},
			// Hands-free cooking's "Chef, …" questions (POST /recipes/:id/ask); its commands need nothing.
			"cookingQuestions": a.AI.TextEnabled(),
			// Family recipes from a recording or a recipe card (family.go).
			"familyRecipes": a.AI.TextEnabled() && a.Media.S3 != nil,
		})
	})
	// Each sign-in route has its own budget, so a few mistyped passwords don't also block a reset.
	v.Post("/auth/register", rateLimit(20, time.Hour), a.register)
	v.Post("/auth/login", rateLimit(20, 15*time.Minute), a.login)
	v.Post("/auth/forgot", rateLimit(5, 15*time.Minute), a.forgotPassword)
	v.Post("/auth/reset", rateLimit(10, 15*time.Minute), a.resetPassword)
	// Google's web button takes a nonce each time it renders, so nonces don't share login's limit.
	v.Post("/auth/nonce", rateLimit(60, 15*time.Minute), a.authNonce)
	v.Post("/auth/oauth", rateLimit(30, 15*time.Minute), a.oauthSignIn)
	v.Post("/auth/logout", a.requireAuth, a.logout)
	v.Get("/me", a.requireAuth, a.me)
	v.Patch("/me", a.requireAuth, a.updateMe)
	v.Delete("/me", a.requireAuth, a.deleteMe)
	v.Post("/me/onboarded", a.requireAuth, a.onboarded)
	v.Get("/handles/:handle", a.requireAuth, a.handleAvailability)
	a.accountRoutes(v)
	v.Get("/recipes", a.listRecipes)
	v.Get("/recipes/:id", a.getRecipe)
	v.Post("/recipes/:id/steps/:step/narration", a.requireAuth, a.prepareNarration)
	v.Get("/recipes/:id/steps/:step/narration/:key", a.requireAuth, a.readNarration)
	v.Post("/recipes", a.requireAuth, a.createRecipe)
	v.Put("/recipes/:id", a.requireAuth, a.updateRecipe)
	v.Delete("/recipes/:id", a.requireAuth, a.deleteRecipe)
	v.Get("/creators", a.creators)
	v.Get("/creators/:id", a.creator)
	v.Put("/creators/:id/follow", a.requireAuth, a.follow)
	v.Delete("/creators/:id/follow", a.requireAuth, a.unfollow)
	v.Get("/recipes/:id/reviews", a.reviews)
	v.Put("/recipes/:id/review", a.requireAuth, a.review)
	v.Post("/recipes/:id/report", a.requireAuth, a.report)
	v.Get("/library", a.requireAuth, a.library)
	v.Put("/recipes/:id/save", a.requireAuth, a.save)
	v.Delete("/recipes/:id/save", a.requireAuth, a.unsave)
	v.Post("/collections", a.requireAuth, a.createCollection)
	v.Delete("/collections/:id", a.requireAuth, a.deleteCollection)
	v.Get("/kitchen", a.requireAuth, a.kitchen)
	v.Post("/planner", a.requireAuth, a.plan)
	v.Delete("/planner/:id", a.requireAuth, a.deletePlan)
	v.Post("/groceries", a.requireAuth, a.addGrocery)
	v.Patch("/groceries/:id", a.requireAuth, a.checkGrocery)
	v.Delete("/groceries/:id", a.requireAuth, a.deleteGrocery)
	v.Post("/recipes/:id/groceries", a.requireAuth, a.recipeGroceries)
	v.Post("/pantry", a.requireAuth, a.addPantry)
	v.Delete("/pantry/:id", a.requireAuth, a.deletePantry)
	v.Get("/billing", a.requireAuth, a.billing)
	v.Post("/billing/checkout", a.requireAuth, a.checkout)
	v.Post("/billing/portal", a.requireAuth, a.billingPortal)
	v.Post("/billing/webhook", a.stripeWebhook)
	v.Post("/media", a.requireAuth, a.uploadMedia)
	v.Post("/media/touch-up", a.requireAuth, a.touchUp)
	v.Post("/ai/jobs", a.requireAuth, a.createJob)
	v.Get("/ai/jobs", a.requireAuth, a.jobs)
	v.Get("/ai/jobs/:id", a.requireAuth, a.job)
	v.Get("/recipe-studio", a.requireAuth, a.studioList)
	v.Post("/recipe-studio", a.requireAuth, a.studioCreate)
	v.Get("/recipe-studio/:id", a.requireAuth, a.studioGet)
	v.Delete("/recipe-studio/:id", a.requireAuth, a.studioDelete)
	v.Post("/recipe-studio/:id/messages", a.requireAuth, a.studioMessage)
	v.Put("/recipe-studio/:id/context", a.requireAuth, a.studioContext)
	v.Post("/recipe-studio/:id/images", a.requireAuth, a.studioImage)
	v.Post("/recipe-studio/:id/undo", a.requireAuth, a.studioUndo)
	v.Post("/recipe-studio/:id/cancel", a.requireAuth, a.studioCancel)
	v.Post("/recipe-studio/:id/voice", a.requireAuth, a.voiceCreate)
	v.Delete("/recipe-studio/voice/:session", a.requireAuth, a.voiceClose)
	a.recipeRoutes(v)
	a.socialRoutes(v)
	a.engagementRoutes(v)
	a.adminRoutes(v)
	a.foodRoutes(v)
	a.translationRoutes(v)
	a.creatorFundRoutes(v)
	a.handsFreeRoutes(v)
	a.groceryCheckoutRoutes(v)
	a.equipmentRoutes(v)
	a.cookInsightRoutes(v)
	a.recipeFixRoutes(v)
	a.yourVersionRoutes(v)
	a.cancellationRoutes(v)
	a.growthRoutes(v)
	a.assistantRoutes(v)
	a.importRoutes(v)
	a.familyRoutes(v)
	return f
}
