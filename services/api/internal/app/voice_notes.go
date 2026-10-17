package app

import "cmp"

// What the server itself says in a live call, which the voice model reads out.
const (
	notePause      = "I'll pause the microphone now to save your voice time. Our conversation is saved; you can resume whenever you're ready."
	notePhoto      = "Your recipe's cover photo is ready and attached to the saved draft. You can review, change, or publish it."
	noteVideo      = "Your recipe's short video is ready and attached to the saved draft. You can review, change, or publish it."
	notePhotoVideo = "Your recipe's cover photo and short video are ready and attached to the saved draft. You can review, change, or publish it."
	noteMedia      = "Your recipe is saved. Some media couldn't finish. You can keep the draft, publish it as it is, or ask to retry the media."
)

// voiceNotes translates the notes, and the replies the server writes itself, into the
// languages the app reports. The app translates stored replies for the screen (they are in its
// catalogs, with these translations); a call hears them in the app's language too.
var voiceNotes = map[string]map[string]string{
	notePause: {
		"fr": "Je mets le micro en pause pour économiser votre temps vocal. Notre conversation est enregistrée ; vous pouvez reprendre quand vous voulez.",
		"de": "Ich pausiere jetzt das Mikrofon, um deine Sprachzeit zu sparen. Unser Gespräch ist gespeichert; du kannst jederzeit weitermachen.",
		"ru": "Я поставлю микрофон на паузу, чтобы сэкономить ваше голосовое время. Беседа сохранена — продолжим, когда будете готовы.",
		"es": "Voy a pausar el micrófono para ahorrar tu tiempo de voz. Nuestra conversación está guardada; puedes continuar cuando quieras.",
		"it": "Metto in pausa il microfono per risparmiare il tuo tempo vocale. La conversazione è salvata: puoi riprendere quando vuoi.",
		"pt": "Vou pausar o microfone para economizar seu tempo de voz. Nossa conversa está salva; você pode retomar quando quiser.",
		"zh": "我先暂停麦克风，以节省你的语音时长。对话已保存，你随时可以继续。",
		"ja": "音声時間を節約するため、マイクを一時停止します。会話は保存されているので、いつでも再開できます。",
	},
	notePhoto: {
		"fr": "La photo de couverture de votre recette est prête et ajoutée au brouillon enregistré. Vous pouvez relire la recette, la modifier ou la publier.",
		"de": "Das Titelfoto deines Rezepts ist fertig und hängt am gespeicherten Entwurf. Du kannst das Rezept prüfen, ändern oder veröffentlichen.",
		"ru": "Обложка вашего рецепта готова и добавлена в сохранённый черновик. Рецепт можно просмотреть, изменить или опубликовать.",
		"es": "La foto de portada de tu receta está lista y añadida al borrador guardado. Puedes revisar la receta, cambiarla o publicarla.",
		"it": "La foto di copertina della tua ricetta è pronta e aggiunta alla bozza salvata. Puoi rivedere la ricetta, modificarla o pubblicarla.",
		"pt": "A foto de capa da sua receita está pronta e anexada ao rascunho salvo. Você pode revisar a receita, alterá-la ou publicá-la.",
		"zh": "你的食谱封面照片已经准备好，并已添加到保存的草稿中。你可以查看、修改或发布这份食谱。",
		"ja": "レシピのカバー写真ができ、保存した下書きに追加しました。レシピを確認、変更、または公開できます。",
	},
	noteVideo: {
		"fr": "La courte vidéo de votre recette est prête et ajoutée au brouillon enregistré. Vous pouvez relire la recette, la modifier ou la publier.",
		"de": "Das kurze Video deines Rezepts ist fertig und hängt am gespeicherten Entwurf. Du kannst das Rezept prüfen, ändern oder veröffentlichen.",
		"ru": "Короткое видео для вашего рецепта готово и добавлено в сохранённый черновик. Рецепт можно просмотреть, изменить или опубликовать.",
		"es": "El video corto de tu receta está listo y añadido al borrador guardado. Puedes revisar la receta, cambiarla o publicarla.",
		"it": "Il breve video della tua ricetta è pronto e aggiunto alla bozza salvata. Puoi rivedere la ricetta, modificarla o pubblicarla.",
		"pt": "O vídeo curto da sua receita está pronto e anexado ao rascunho salvo. Você pode revisar a receita, alterá-la ou publicá-la.",
		"zh": "你的食谱短视频已经准备好，并已添加到保存的草稿中。你可以查看、修改或发布这份食谱。",
		"ja": "レシピのショート動画ができ、保存した下書きに追加しました。レシピを確認、変更、または公開できます。",
	},
	notePhotoVideo: {
		"fr": "La photo de couverture et la courte vidéo de votre recette sont prêtes et ajoutées au brouillon enregistré. Vous pouvez relire la recette, la modifier ou la publier.",
		"de": "Titelfoto und kurzes Video deines Rezepts sind fertig und hängen am gespeicherten Entwurf. Du kannst das Rezept prüfen, ändern oder veröffentlichen.",
		"ru": "Обложка и короткое видео для вашего рецепта готовы и добавлены в сохранённый черновик. Рецепт можно просмотреть, изменить или опубликовать.",
		"es": "La foto de portada y el video corto de tu receta están listos y añadidos al borrador guardado. Puedes revisar la receta, cambiarla o publicarla.",
		"it": "La foto di copertina e il breve video della tua ricetta sono pronti e aggiunti alla bozza salvata. Puoi rivedere la ricetta, modificarla o pubblicarla.",
		"pt": "A foto de capa e o vídeo curto da sua receita estão prontos e anexados ao rascunho salvo. Você pode revisar a receita, alterá-la ou publicá-la.",
		"zh": "你的食谱封面照片和短视频已经准备好，并已添加到保存的草稿中。你可以查看、修改或发布这份食谱。",
		"ja": "レシピのカバー写真とショート動画ができ、保存した下書きに追加しました。レシピを確認、変更、または公開できます。",
	},
	noteMedia: {
		"fr": "Votre recette est enregistrée. Certains médias n’ont pas pu être terminés. Vous pouvez garder le brouillon, le publier tel quel ou demander de relancer les médias.",
		"de": "Dein Rezept ist gespeichert. Einige Medien konnten nicht fertiggestellt werden. Du kannst den Entwurf behalten, ihn so veröffentlichen oder die Medien neu erstellen lassen.",
		"ru": "Рецепт сохранён. Часть медиа не удалось подготовить. Можно оставить черновик, опубликовать его как есть или попросить создать медиа заново.",
		"es": "Tu receta está guardada. Algunos archivos multimedia no se pudieron terminar. Puedes conservar el borrador, publicarlo tal como está o pedir que se vuelvan a generar.",
		"it": "La tua ricetta è salvata. Alcuni contenuti multimediali non sono stati completati. Puoi tenere la bozza, pubblicarla così com’è o chiedere di rigenerarli.",
		"pt": "Sua receita está salva. Algumas mídias não puderam ser concluídas. Você pode manter o rascunho, publicá-lo como está ou pedir para gerar as mídias de novo.",
		"zh": "你的食谱已保存，但部分图片或视频未能完成。你可以保留草稿、直接发布，或者让我重新生成。",
		"ja": "レシピは保存されました。一部のメディアは完成しませんでした。下書きのまま残す、そのまま公開する、またはメディアの作り直しを頼むことができます。",
	},
	turnFailed: {
		"fr": "Votre sous-chef n’a pas pu terminer cette étape. Votre conversation est enregistrée. Veuillez réessayer.",
		"de": "Dein Souschef konnte diesen Schritt nicht abschließen. Dein Gespräch ist gespeichert. Bitte versuch es noch einmal.",
		"ru": "Помощнику не удалось завершить этот шаг. Беседа сохранена. Попробуйте ещё раз.",
		"es": "Tu asistente no pudo terminar ese paso. Tu conversación está guardada. Inténtalo de nuevo.",
		"it": "L’assistente non è riuscito a completare questo passaggio. La conversazione è salvata. Riprova.",
		"pt": "Seu assistente não conseguiu concluir essa etapa. Sua conversa está salva. Tente novamente.",
		"zh": "厨师助手未能完成这一步。你的对话已保存，请重试。",
		"ja": "アシスタントがこの処理を完了できませんでした。会話は保存されています。もう一度お試しください。",
	},
	turnFailedAfterChanges: {
		"fr": "Votre sous-chef n’a pas pu terminer cette étape, mais certaines modifications ont déjà été enregistrées. Vérifiez-les avant de redemander.",
		"de": "Dein Souschef konnte diesen Schritt nicht abschließen, aber einige Änderungen wurden bereits gespeichert. Prüfe sie, bevor du noch einmal fragst.",
		"ru": "Помощнику не удалось завершить этот шаг, но часть изменений уже сохранена. Проверьте их, прежде чем просить снова.",
		"es": "Tu asistente no pudo terminar ese paso, pero algunos cambios ya se guardaron. Revísalos antes de volver a pedírselo.",
		"it": "L’assistente non è riuscito a completare questo passaggio, ma alcune modifiche sono già state salvate. Controllale prima di chiedere di nuovo.",
		"pt": "Seu assistente não conseguiu concluir essa etapa, mas algumas alterações já foram salvas. Confira-as antes de pedir novamente.",
		"zh": "厨师助手未能完成这一步，但部分更改已保存。请先检查这些更改，再重新提问。",
		"ja": "アシスタントがこの処理を完了できませんでしたが、一部の変更はすでに保存されています。もう一度頼む前に確認してください。",
	},
	turnStopped: {
		"fr": "Arrêté. Votre conversation est enregistrée.",
		"de": "Gestoppt. Dein Gespräch ist gespeichert.",
		"ru": "Остановлено. Беседа сохранена.",
		"es": "Detenido. Tu conversación está guardada.",
		"it": "Interrotto. La conversazione è salvata.",
		"pt": "Interrompido. Sua conversa está salva.",
		"zh": "已停止。对话已保存。",
		"ja": "停止しました。会話は保存されています。",
	},
}

// voiceNote is text the server wrote, in language when it has a translation.
func voiceNote(language, text string) string {
	return cmp.Or(voiceNotes[text][language], text)
}
