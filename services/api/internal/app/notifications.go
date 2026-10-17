package app

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// Account emails. Only English exists so far; every letter takes the reader's language, so a
// translation slots in here without touching the handlers that send it. Letters never quote
// text a member typed (their name, say), because some go to addresses not yet proven theirs.
type letterKind int

const (
	letterWelcome letterKind = iota
	letterVerify
	letterEmailChangeCode
	letterEmailChanged
	letterPasswordChanged
	letterNewSignIn
	letterAccountDeleted
)

type letterData struct {
	Code               string
	OldEmail, NewEmail string
	Device             string // from deviceLabel's fixed vocabulary
	When               time.Time
}

type letter struct{ Subject, Text string }

// letterLanguages maps a language code to its letters; anything missing falls back to English.
var letterLanguages = map[string]func(letterKind, letterData) letter{"en": englishLetter}

func compose(kind letterKind, lang string, d letterData) letter {
	if write, ok := letterLanguages[lang]; ok {
		return write(kind, d)
	}
	return englishLetter(kind, d)
}

func englishLetter(kind letterKind, d letterData) letter {
	const sign = "\n\n— Savorly"
	switch kind {
	case letterWelcome:
		return letter{"Welcome to Savorly", "Welcome to Savorly! To confirm your email address, enter this code in My kitchen:\n\n" + d.Code + "\n\nThe code expires in 24 hours. If you didn't create a Savorly account, you can ignore this email." + sign}
	case letterVerify:
		return letter{"Your Savorly confirmation code", "Enter this code in My kitchen to confirm your email address:\n\n" + d.Code + "\n\nThe code expires in 24 hours. If you didn't ask for it, you can ignore this email." + sign}
	case letterEmailChangeCode:
		return letter{"Confirm your new Savorly email", "Enter this code in Savorly to confirm your new email address:\n\n" + d.Code + "\n\nThe code expires in 15 minutes. If you didn't ask to change your Savorly email, you can ignore this email." + sign}
	case letterEmailChanged:
		return letter{"Your Savorly email was changed", "The email address of your Savorly account was changed from " + d.OldEmail + " to " + d.NewEmail + ".\n\nIf you made this change, there's nothing else to do. If you didn't, contact Savorly support right away." + sign}
	case letterPasswordChanged:
		return letter{"Your Savorly password was changed", "The password of your Savorly account was just changed, and your other devices were signed out.\n\nIf you made this change, there's nothing else to do. If you didn't, choose a new password with Forgot password on the sign-in screen right away." + sign}
	case letterNewSignIn:
		return letter{"New sign-in to your Savorly account", "Your Savorly account was just signed in on a new device: " + d.Device + ", at " + d.When.UTC().Format("2 January 2006, 15:04 UTC") + ".\n\nIf this was you, there's nothing to do. If it wasn't, change your password and sign out your other devices in My kitchen." + sign}
	case letterAccountDeleted:
		return letter{"Your Savorly account was deleted", "Your Savorly account and everything in it, including your recipes, reviews, cookbooks and plans, have been deleted as you asked. Any subscription was cancelled.\n\nThank you for cooking with us." + sign}
	}
	return letter{}
}

// deviceLabel describes a user agent for an email, e.g. "Chrome on macOS".
func deviceLabel(ua string) string {
	client, system := deviceOf(ua)
	if client == "Savorly" {
		client = "the Savorly app"
	}
	switch {
	case client != "" && system != "":
		return client + " on " + system
	case client != "" || system != "":
		return client + system
	}
	return "an unrecognized device"
}

// pendingLetters tracks notifications still being sent, so tests can wait for them.
var pendingLetters sync.WaitGroup

// notify sends an account notification off the request path. It is best effort: a failure is
// logged and never reaches the member's request. Members have no language setting yet, so
// letters are in English.
func notify(to string, kind letterKind, d letterData) {
	if !emailEnabled() || strings.TrimSpace(to) == "" {
		return
	}
	l := compose(kind, "en", d)
	pendingLetters.Add(1)
	go func() {
		defer pendingLetters.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if e := sendEmail(ctx, to, l.Subject, l.Text); e != nil {
			slog.Warn("account notification failed", "subject", l.Subject, "error", e)
		}
	}()
}
