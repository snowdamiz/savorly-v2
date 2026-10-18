package ai

// Text/agent model verified on 2026-10-07; recipe/image models on 2026-10-03; the edit model on
// 2026-10-15. Source: OpenRouter model and image capability catalogs.
const (
	DefaultRecipeModel = "openai/gpt-6.1-sol"
	DefaultAgentModel  = "openai/gpt-6-luna"
	DefaultImageModel  = "openai/gpt-image-2.5-flare"
	// Touch-ups edit a real photo, where GPT Image 2.5 Sunburst leads Flare most (Arena single-image
	// editing) at the same per-token price; Flare stays the faster choice for new covers.
	DefaultImageEditModel = "openai/gpt-image-2.5-sunburst"
	// A translation is a short, structured rewrite: the agent's fast, inexpensive model, with low
	// reasoning, is enough.
	DefaultTranslationModel = DefaultAgentModel
	// Family recordings are transcribed by Whisper large v3, which answers with timed segments.
	// Checked on 2026-10-17: $0.0075 to $0.031 per 1,000 seconds of audio, by provider.
	DefaultTranscriptionModel = "openai/whisper-large-v3"
)

// GenerationEstimate is a reservation, not a provider invoice. Keep both manual
// jobs and assistant-created media on the same estimates when models change.
func GenerationEstimate(kind string) float64 {
	switch {
	case kind == "video":
		return 1.50
	case kind == "recipe":
		// A recipe read from a page: GPT-6.1 Sol's reasoning and the whole recipe.
		return .25
	default:
		// One medium 4:3 GPT Image 2.5 Flare cover is about $0.01–0.02 (October 2026).
		return .05
	}
}
