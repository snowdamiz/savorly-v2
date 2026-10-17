package app

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/jpeg"
	_ "image/png" // decoders for recipe photos
	"math"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// photoSide bounds recipe photos sent to the vision model: cookbook text stays legible at
// this size, and a larger photo costs more without reading better.
const photoSide = 1600

// Bigger photos are passed on untouched rather than decoded, which would take too much memory.
const photoMaxPixels = 40_000_000

// fitPhoto shrinks a JPEG, PNG or WebP photo whose longest side exceeds photoSide to a
// JPEG upright per its EXIF orientation, and reports whether it did. A photo it can't
// read is left for the provider, as before.
func fitPhoto(photo []byte) ([]byte, bool) {
	config, _, e := image.DecodeConfig(bytes.NewReader(photo))
	if e != nil || max(config.Width, config.Height) <= photoSide || config.Width*config.Height > photoMaxPixels {
		return photo, false
	}
	src, _, e := image.Decode(bytes.NewReader(photo))
	if e != nil {
		return photo, false
	}
	scale := float64(photoSide) / float64(max(config.Width, config.Height))
	width := max(1, int(math.Round(float64(config.Width)*scale)))
	height := max(1, int(math.Round(float64(config.Height)*scale)))
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	// JPEG has no transparency; transparent areas read best on white.
	draw.Draw(dst, dst.Bounds(), image.White, image.Point{}, draw.Src)
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Over, nil)
	var out bytes.Buffer
	if e = jpeg.Encode(&out, orient(dst, exifOrientation(photo)), &jpeg.Options{Quality: 85}); e != nil {
		return photo, false
	}
	return out.Bytes(), true
}

// exifOrientation reads a JPEG's EXIF orientation (1–8), or 1. Phones store portrait photos
// sideways with this tag, and re-encoding drops it.
func exifOrientation(b []byte) int {
	if len(b) < 4 || b[0] != 0xFF || b[1] != 0xD8 {
		return 1
	}
	for i := 2; i+4 <= len(b) && b[i] == 0xFF; {
		marker, size := b[i+1], int(binary.BigEndian.Uint16(b[i+2:]))
		if marker == 0xDA || size < 2 || i+2+size > len(b) {
			return 1
		}
		segment := b[i+4 : i+2+size]
		if marker == 0xE1 && len(segment) > 14 && string(segment[:6]) == "Exif\x00\x00" {
			return tiffOrientation(segment[6:])
		}
		i += 2 + size
	}
	return 1
}

func tiffOrientation(t []byte) int {
	var order binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	ifd := int(order.Uint32(t[4:]))
	if ifd < 8 || ifd+2 > len(t) {
		return 1
	}
	count := int(order.Uint16(t[ifd:]))
	for n := range count {
		entry := ifd + 2 + 12*n
		if entry+12 > len(t) {
			return 1
		}
		if order.Uint16(t[entry:]) == 0x0112 {
			if o := int(order.Uint16(t[entry+8:])); o >= 1 && o <= 8 {
				return o
			}
			return 1
		}
	}
	return 1
}

// orient turns an image stored with EXIF orientation o upright.
func orient(src *image.RGBA, o int) *image.RGBA {
	if o < 2 || o > 8 {
		return src
	}
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := range dh {
		for x := range dw {
			sx, sy := x, y
			switch o {
			case 2:
				sx = w - 1 - x
			case 3:
				sx, sy = w-1-x, h-1-y
			case 4:
				sy = h - 1 - y
			case 5:
				sx, sy = y, x
			case 6:
				sx, sy = y, h-1-x
			case 7:
				sx, sy = w-1-y, h-1-x
			case 8:
				sx, sy = w-1-y, x
			}
			copy(dst.Pix[dst.PixOffset(x, y):dst.PixOffset(x, y)+4], src.Pix[src.PixOffset(sx, sy):src.PixOffset(sx, sy)+4])
		}
	}
	return dst
}
