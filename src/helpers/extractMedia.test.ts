import { describe, it, expect } from 'vitest';
import { extractMedia, splitGluedMediaUrls } from './extractMedia';

describe('splitGluedMediaUrls', () => {
  it('splits two glued image URLs (fanfares publishes them without a separator)', () => {
    const glued =
      'https://api.fanfares.live/cdn/6100536603bfa406717b1346969f7958051e2f070cb7650dc61c6e9ef2168848.jpghttps://api.fanfares.live/cdn/db1098741be620378e4ad2ceb3de4ba753359d9017a0f21b42314f93be5ef5ca.jpg';
    const split = splitGluedMediaUrls(glued);
    expect(split).toContain('\n');
    expect(split.split('\n')).toHaveLength(2);
    expect(split).toMatch(/\.jpg\nhttps:\/\//);
  });

  it('leaves already-separated URLs untouched', () => {
    const content = 'https://a.com/x.jpg\nhttps://b.com/y.jpg';
    expect(splitGluedMediaUrls(content)).toBe(content);
  });

  it('splits video and image extensions alike (mov, mp4, png, webp)', () => {
    expect(splitGluedMediaUrls('https://a.com/v.movhttps://b.com/i.png')).toBe(
      'https://a.com/v.mov\nhttps://b.com/i.png'
    );
    expect(splitGluedMediaUrls('https://a.com/v.mp4https://b.com/i.webp')).toBe(
      'https://a.com/v.mp4\nhttps://b.com/i.webp'
    );
  });

  it('plain text without media URLs is untouched', () => {
    const content = 'just words and https://example.com/page over here';
    expect(splitGluedMediaUrls(content)).toBe(content);
  });
});

describe('extractMedia — glued URL handling', () => {
  it('extracts TWO images from glued URLs (not one broken URL)', () => {
    const glued =
      'Teaser\nhttps://api.fanfares.live/cdn/6100536603bfa406717b1346969f7958051e2f070cb7650dc61c6e9ef2168848.jpghttps://api.fanfares.live/cdn/db1098741be620378e4ad2ceb3de4ba753359d9017a0f21b42314f93be5ef5ca.jpg';
    const media = extractMedia(glued);
    const images = media.filter(m => m.type === 'image');
    expect(images).toHaveLength(2);
    expect(images[0]!.url).toContain('6100536603bfa406');
    expect(images[1]!.url).toContain('db1098741be620378');
  });
});
