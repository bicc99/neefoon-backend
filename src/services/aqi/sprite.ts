import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { SpriteIndexEntry } from "../../types/aqi.js";

const MARKER_ASSETS_DIR =
  process.env.MARKER_ASSETS_DIR ??
  (() => {
    throw new Error("MARKER_ASSETS_DIR env var is required");
  })();

const SPRITE_MAX_WIDTH = 2048;
const SPRITE_PADDING = 2;
// 64×64 PNGs render at 32 logical pixels but are crisp on high-DPI screens.
// Check generate-aqi-markers.mjs for the corresponding PIXEL_RATIO used when generating the PNGs.
const SPRITE_PIXEL_RATIO = 2;

type SpriteCache = {
  key: string;
  png: Buffer;
  json: Record<string, SpriteIndexEntry>;
};

let spriteCache: SpriteCache | null = null;

export async function buildCurrentSprite(markerKeys: string[]): Promise<{
  png: Buffer;
  json: Record<string, SpriteIndexEntry>;
}> {
  const cacheKey = markerKeys.join("|");

  if (spriteCache && spriteCache.key === cacheKey) {
    return { png: spriteCache.png, json: spriteCache.json };
  }

  const files = await Promise.all(
    markerKeys.map(async (key) => {
      const filePath = path.join(MARKER_ASSETS_DIR, `${key}.png`);

      try {
        await fs.access(filePath);
      } catch {
        throw new Error(`Marker PNG not found: ${filePath}`);
      }

      const meta = await sharp(filePath).metadata();

      if (!meta.width || !meta.height) {
        throw new Error(`Could not read size for marker PNG: ${filePath}`);
      }

      return { key, filePath, width: meta.width, height: meta.height };
    })
  );

  let x = 0;
  let y = 0;
  let rowHeight = 0;

  const layout = files.map((file) => {
    if (x > 0 && x + file.width > SPRITE_MAX_WIDTH) {
      x = 0;
      y += rowHeight + SPRITE_PADDING;
      rowHeight = 0;
    }

    const placed = { ...file, x, y };
    x += file.width + SPRITE_PADDING;
    rowHeight = Math.max(rowHeight, file.height);
    return placed;
  });

  const atlasWidth  = Math.max(1, layout.reduce((max, item) => Math.max(max, item.x + item.width), 0));
  const atlasHeight = Math.max(1, layout.reduce((max, item) => Math.max(max, item.y + item.height), 0));

  const composite = layout.map((item) => ({ input: item.filePath, left: item.x, top: item.y }));

  const png = await sharp({
    create: {
      width: atlasWidth,
      height: atlasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composite)
    .png()
    .toBuffer();

  const json: Record<string, SpriteIndexEntry> = {};
  for (const item of layout) {
    json[item.key] = {
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      pixelRatio: SPRITE_PIXEL_RATIO,
    };
  }

  spriteCache = { key: cacheKey, png, json };

  console.log('sprite keys:', markerKeys.length);
  console.log('sprite png bytes:', png.length);
  console.log('sprite json bytes:', Buffer.byteLength(JSON.stringify(json), 'utf8'));

  return { png, json };
}
