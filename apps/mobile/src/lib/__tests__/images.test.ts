/// <reference types="jest" />
import { blurred, sized, variantWidth } from '../images';

const unsplash = 'https://images.unsplash.com/photo-1?w=1200&q=80';
const upload = 'https://media.savorly.cooking/uploads/cook/a.jpg';
// The build's setting, as EXPO_PUBLIC_IMAGE_RESIZE=cloudflare would give it.
const cloudflare = { resize: 'cloudflare' };

test('photos are asked for at a few fixed widths', () => {
  expect(variantWidth(1)).toBe(160);
  expect(variantWidth(152)).toBe(160);
  expect(variantWidth(161)).toBe(320);
  expect(variantWidth(860)).toBe(1200);
  expect(variantWidth(5000)).toBe(2048);
});

test('Unsplash photos resize and blur through their address, keeping other parameters', () => {
  expect(sized(unsplash, 300)).toBe('https://images.unsplash.com/photo-1?w=320&q=70&auto=format');
  expect(sized('https://images.unsplash.com/photo-1?auto=format&fit=crop&w=1200&q=85', 300)).toBe(
    'https://images.unsplash.com/photo-1?auto=format&fit=crop&w=320&q=70',
  );
  expect(sized('https://images.unsplash.com/photo-2', 700)).toBe(
    'https://images.unsplash.com/photo-2?w=800&auto=format&q=70',
  );
  expect(blurred(unsplash)).toBe(
    'https://images.unsplash.com/photo-1?w=32&q=30&auto=format&blur=200',
  );
});

test('uploads go through Cloudflare only when the build turns it on', () => {
  expect(sized(upload, 300)).toBe(upload);
  expect(blurred(upload)).toBe('');
  expect(sized(upload, 300, cloudflare)).toBe(
    'https://media.savorly.cooking/cdn-cgi/image/width=320,quality=75,format=auto/uploads/cook/a.jpg',
  );
  expect(blurred(upload, cloudflare)).toBe(
    'https://media.savorly.cooking/cdn-cgi/image/width=32,quality=30,blur=20,format=auto/uploads/cook/a.jpg',
  );
  // Already transformed, or on another host: left alone.
  const transformed = sized(upload, 300, cloudflare);
  expect(sized(transformed, 300, cloudflare)).toBe(transformed);
  expect(blurred('https://example.com/a.jpg', cloudflare)).toBe('');
  for (const other of [
    'https://cdn.example.com/cook/photo.jpg',
    'file:///data/photo.jpg',
    'data:image/png;base64,AAAA',
  ]) {
    expect(sized(other, 400, cloudflare)).toBe(other);
    expect(blurred(other, cloudflare)).toBe('');
  }
});

test('the media origin comes from the build', () => {
  const staging = { resize: 'cloudflare', media: 'https://media.staging.test/' };
  expect(blurred('https://media.staging.test/x.png', staging)).toBe(
    'https://media.staging.test/cdn-cgi/image/width=32,quality=30,blur=20,format=auto/x.png',
  );
  expect(blurred(upload, staging)).toBe('');
});

test('nothing to show makes nothing', () => {
  expect(blurred('')).toBe('');
  expect(sized('', 300)).toBe('');
  expect(sized(unsplash, 0)).toBe(unsplash);
});
