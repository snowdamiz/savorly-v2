package ai

// Text/agent model verified on 2026-10-07; recipe/image models on 2026-10-03; the edit model on
// 2026-10-15. Source: OpenRouter model and image capability catalogs.
const (
	DefaultTextModel   = "openai/gpt-6-luna"
	DefaultRecipeModel = "openai/gpt-6.1-sol"
	DefaultAgentModel  = "openai/gpt-6-luna"
	DefaultImageModel  = "openai/gpt-image-2.5-flare"
	// Touch-ups edit a real photo, where GPT Image 2.5 Sunburst leads Flare most (Arena single-image
	// editing) at the same per-token price; Flare stays the faster choice for new covers.
	DefaultImageEditModel = "openai/gpt-image-2.5-sunburst"
)

func detailedTask(kind string) bool {
	return kind == "recipe" || kind == "adapt" || kind == "plan"
}

func (c *Client) textSettings(kind string) (model, effort, sort string, tokens int) {
	if detailedTask(kind) {
		// Budget includes reasoning tokens as well as the complete recipe JSON.
		return c.RecipeModel, "medium", "throughput", 8192
	}
	return c.TextModel, "low", "latency", 3500
}

// GenerationEstimate is a reservation, not a provider invoice. Keep both manual
// jobs and assistant-created media on the same estimates when models change.
func GenerationEstimate(kind string) float64 {
	switch {
	case kind == "video":
		return 1.50
	case kind == "image":
		// One medium 4:3 GPT Image 2.5 Flare cover is about $0.01–0.02 (October 2026).
		return .05
	case detailedTask(kind):
		return .25
	default:
		return .05
	}
}
