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
	// Step clips are short, silent and one to a step: Seedance 2.0 Mini's Eco tier at 720p is
	// $0.036 a second (reapi.ai/models/seedance-2-0-mini, October 18, 2026).
	DefaultVideoModel = "doubao-seedance-2.0-eco-mini"
	// Family recordings are transcribed by Whisper large v3, which answers with timed segments.
	// Checked on 2026-10-17: $0.0075 to $0.031 per 1,000 seconds of audio, by provider.
	DefaultTranscriptionModel = "openai/whisper-large-v3"
)

// GenerationEstimate is a reservation, not a provider invoice. Keep both manual
// jobs and assistant-created media on the same estimates when models change.
func GenerationEstimate(kind string) float64 {
	switch {
	case kind == "clip" || kind == "video":
		// One four-second 720p clip on Seedance 2.0 Mini Eco is $0.144. Released apps' "video"
		// jobs make the same clip.
		return .18
	case kind == "recipe":
		// A recipe read from a page: GPT-6.1 Sol's reasoning and the whole recipe.
		return .25
	default:
		// One medium 4:3 GPT Image 2.5 Flare cover is about $0.01–0.02 (October 2026).
		return .05
	}
}
