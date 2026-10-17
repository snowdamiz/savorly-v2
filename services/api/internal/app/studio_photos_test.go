package app

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

// photoTwoTone is red on its left half and blue on its right.
func photoTwoTone(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			c := color.RGBA{R: 255, A: 255}
			if x >= w/2 {
				c = color.RGBA{B: 255, A: 255}
			}
			img.SetRGBA(x, y, c)
		}
	}
	return img
}
func photoJPEG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var b bytes.Buffer
	if e := jpeg.Encode(&b, img, &jpeg.Options{Quality: 90}); e != nil {
		t.Fatal(e)
	}
	return b.Bytes()
}

// photoWithOrientation inserts an EXIF segment carrying orientation o right after the JPEG's SOI.
func photoWithOrientation(photo []byte, o byte, little bool) []byte {
	tiff := []byte{'M', 'M', 0, 0x2A, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0}
	if little {
		tiff = []byte{'I', 'I', 0x2A, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, o, 0, 0, 0, 0, 0, 0, 0}
	}
	segment := append([]byte("Exif\x00\x00"), tiff...)
	size := len(segment) + 2
	out := append([]byte{0xFF, 0xD8, 0xFF, 0xE1, byte(size >> 8), byte(size)}, segment...)
	return append(out, photo[2:]...)
}
func photoDecode(t *testing.T, b []byte) image.Image {
	t.Helper()
	img, format, e := image.Decode(bytes.NewReader(b))
	if e != nil || format != "jpeg" {
		t.Fatalf("not a JPEG: %v %s", e, format)
	}
	return img
}
func photoNear(c color.Color, want color.RGBA) bool {
	r, g, b, _ := c.RGBA()
	d := func(x uint32, y uint8) bool { v := int(x>>8) - int(y); return v > -60 && v < 60 }
	return d(r, want.R) && d(g, want.G) && d(b, want.B)
}

func TestFitPhotoShrinksLargePhotosOnly(t *testing.T) {
	small := photoJPEG(t, photoTwoTone(1200, 900))
	if out, resized := fitPhoto(small); resized || !bytes.Equal(out, small) {
		t.Fatal("a photo within bounds was re-encoded")
	}
	for _, corrupt := range [][]byte{[]byte("not a photo"), small[:40]} {
		if out, resized := fitPhoto(corrupt); resized || !bytes.Equal(out, corrupt) {
			t.Fatal("an unreadable photo was changed")
		}
	}
	out, resized := fitPhoto(photoJPEG(t, photoTwoTone(3200, 2000)))
	if !resized {
		t.Fatal("a large photo was sent as it came")
	}
	img := photoDecode(t, out)
	if img.Bounds().Dx() != 1600 || img.Bounds().Dy() != 1000 || !photoNear(img.At(100, 500), color.RGBA{R: 255}) || !photoNear(img.At(1500, 500), color.RGBA{B: 255}) {
		t.Fatalf("shrunk to %v", img.Bounds())
	}
	// Transparent PNG areas come out white, not black.
	clear := image.NewNRGBA(image.Rect(0, 0, 2000, 400))
	var b bytes.Buffer
	if e := png.Encode(&b, clear); e != nil {
		t.Fatal(e)
	}
	out, resized = fitPhoto(b.Bytes())
	if img = photoDecode(t, out); !resized || img.Bounds().Dx() != 1600 || !photoNear(img.At(800, 160), color.RGBA{R: 255, G: 255, B: 255}) {
		t.Fatalf("transparent PNG: %v %v", img.Bounds(), img.At(800, 160))
	}
}

func TestFitPhotoKeepsPhonePhotosUpright(t *testing.T) {
	stored := photoJPEG(t, photoTwoTone(3200, 1600))
	for _, little := range []bool{false, true} {
		// 6: stored rotated, shown turned 90° clockwise, so the stored left (red) is on top.
		rotated := photoWithOrientation(stored, 6, little)
		if o := exifOrientation(rotated); o != 6 {
			t.Fatalf("orientation %d", o)
		}
		out, resized := fitPhoto(rotated)
		img := photoDecode(t, out)
		if !resized || img.Bounds().Dx() != 800 || img.Bounds().Dy() != 1600 || !photoNear(img.At(400, 100), color.RGBA{R: 255}) || !photoNear(img.At(400, 1500), color.RGBA{B: 255}) {
			t.Fatalf("not upright: %v", img.Bounds())
		}
	}
	// 8: turned 90° counter-clockwise, so the stored right (blue) is on top.
	img := photoDecode(t, photoFitted(fitPhoto(photoWithOrientation(stored, 8, false))))
	if !photoNear(img.At(400, 100), color.RGBA{B: 255}) || !photoNear(img.At(400, 1500), color.RGBA{R: 255}) {
		t.Fatal("orientation 8 not applied")
	}
	if exifOrientation(stored) != 1 || exifOrientation([]byte("GIF89a")) != 1 || exifOrientation(photoWithOrientation(stored, 9, false)) != 1 {
		t.Fatal("unexpected orientation")
	}
}
func photoFitted(b []byte, _ bool) []byte { return b }
