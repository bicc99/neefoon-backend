import { createCanvas } from 'canvas';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const OUT_DIR = path.resolve('assets/aqi-markers');

const LOGICAL_SIZE = 32;
const PIXEL_RATIO = 2; // Adjust as needed for higher/lower resolution. 2x is a common choice for crispness without excessive file size (32x2=64).
const SIZE = LOGICAL_SIZE * PIXEL_RATIO;
const CENTER = SIZE / 2;

// script that generates only the valid AQI markers, then runs a lossless/lossy optimization to reduce file sizes. 
// The no-data markers are generated as well.

// Optional: register a bundled font for consistent output.
// Replace with your actual font file if you want.
// registerFont(path.resolve('assets/fonts/NotoSans-Bold.ttf'), {
//   family: 'Noto Sans',
//   weight: 'bold',
// });

// pngquant for lossy palette compression and 
// oxipng for additional lossless optimization
// brew install pngquant oxipng 
// npm install canvas
// npm run generate:aqi-markers

// Vivid / split-text palette.
const CATEGORY_COLORS = {
  good: '#4FB477',
  moderate: '#F5C518',
  usg: '#F57C1F',
  unhealthy: '#E02828',
  very: '#9A3DB8',
  hazardous: '#8B1E3F',
  nodata: '#B8C0C5',
};

const CATEGORIES = [
  {
    key: 'c_good',
    selectedKey: 'c_good_s',
    normal: CATEGORY_COLORS.good,
    selected: darkenHex(CATEGORY_COLORS.good),
    textColor: '#111111',
    min: 0,
    max: 50,
  },
  {
    key: 'c_moderate',
    selectedKey: 'c_moderate_s',
    normal: CATEGORY_COLORS.moderate,
    selected: darkenHex(CATEGORY_COLORS.moderate),
    textColor: '#111111',
    min: 51,
    max: 100,
  },
  {
    key: 'c_usg',
    selectedKey: 'c_usg_s',
    normal: CATEGORY_COLORS.usg,
    selected: darkenHex(CATEGORY_COLORS.usg),
    textColor: '#111111',
    min: 101,
    max: 150,
  },
  {
    key: 'c_unhealthy',
    selectedKey: 'c_unhealthy_s',
    normal: CATEGORY_COLORS.unhealthy,
    selected: darkenHex(CATEGORY_COLORS.unhealthy),
    textColor: '#ffffff',
    min: 151,
    max: 200,
  },
  {
    key: 'c_very',
    selectedKey: 'c_very_s',
    normal: CATEGORY_COLORS.very,
    selected: darkenHex(CATEGORY_COLORS.very),
    textColor: '#ffffff',
    min: 201,
    max: 300,
  },
  {
    key: 'c_hazardous',
    selectedKey: 'c_hazardous_s',
    normal: CATEGORY_COLORS.hazardous,
    selected: darkenHex(CATEGORY_COLORS.hazardous),
    textColor: '#ffffff',
    min: 301,
    max: 500,
  },
  {
    key: 'c_nodata',
    selectedKey: 'c_nodata_s',
    normal: CATEGORY_COLORS.nodata,
    selected: darkenHex(CATEGORY_COLORS.nodata),
    stroke: '#ffffff',
    isNoData: true,
  },
];


function darkenHex(hex, factor = 0.72) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);

  const toHex = (v) =>
    Math.max(0, Math.min(255, Math.round(v * factor)))
      .toString(16)
      .padStart(2, '0');

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}


function markerGeometry(aqi) {
  const digits = String(aqi).length;
  return {
    radius: (digits >= 3 ? 12 : 10) * PIXEL_RATIO,
    fontSize: (digits >= 3 ? 11 : 13) * PIXEL_RATIO,
    strokeWidth: 0.5 * PIXEL_RATIO,
    textYOffset: (digits >= 3 ? 4.1 : 4.3) * PIXEL_RATIO,
  };
}

function drawMarker({ bgColor, textColor, aqi }) {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');
  const { radius, fontSize, strokeWidth, textYOffset } = markerGeometry(aqi);

  ctx.clearRect(0, 0, SIZE, SIZE);

  ctx.beginPath();
  ctx.arc(CENTER, CENTER, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = bgColor;
  ctx.fill();

  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 ${fontSize}px "Noto Sans", "Arial", sans-serif`;
  ctx.fillText(String(aqi), CENTER, CENTER + textYOffset);

  return canvas.toBuffer('image/png');
}

function drawNoDataMarker({ bgColor, strokeColor }) {
  const canvas = createCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d');

  const radius = 4 * PIXEL_RATIO;
  const strokeWidth = 1 * PIXEL_RATIO;

  ctx.clearRect(0, 0, SIZE, SIZE);

  ctx.beginPath();
  ctx.arc(CENTER, CENTER, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = bgColor;
  ctx.fill();

  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = strokeColor;
  ctx.stroke();

  return canvas.toBuffer('image/png');
}

async function writeNoDataMarker(filePath, config) {
  const png = drawNoDataMarker(config);
  await fs.writeFile(filePath, png);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeMarker(filePath, config) {
  const png = drawMarker(config);
  await fs.writeFile(filePath, png);
}

async function generateAll() {
  await ensureDir(OUT_DIR);

  let count = 0;

  for (const cat of CATEGORIES) {
    if (cat.isNoData) {
      await writeNoDataMarker(path.join(OUT_DIR, `${cat.key}.png`), {
        bgColor: cat.normal,
        strokeColor: cat.stroke ?? '#ffffff',
      });

      await writeNoDataMarker(path.join(OUT_DIR, `${cat.selectedKey}.png`), {
        bgColor: cat.selected,
        strokeColor: cat.stroke ?? '#ffffff',
      });

      count += 2;
      continue;
    }

    for (let aqi = cat.min; aqi <= cat.max; aqi += 1) {
      const normalName = `${cat.key}_${aqi}.png`;
      const selectedName = `${cat.selectedKey}_${aqi}.png`;

      await writeMarker(path.join(OUT_DIR, normalName), {
        bgColor: cat.normal,
        textColor: cat.textColor,
        aqi,
      });

      await writeMarker(path.join(OUT_DIR, selectedName), {
        bgColor: cat.selected,
        textColor: cat.textColor,
        aqi,
      });

      count += 2;
    }
  }

  console.log(`Generated ${count} PNG files in ${OUT_DIR}`);
}

async function commandExists(cmd, args = ['--version']) {
  try {
    await execFileAsync(cmd, args);
    return true;
  } catch {
    return false;
  }
}

async function optimizeWithPngquant() {
  const ok = await commandExists('pngquant', ['--version']);
  if (!ok) {
    console.warn('pngquant not found. Skipping pngquant step.');
    return;
  }

  // pngquant is lossy and often cuts PNG sizes significantly while keeping alpha. 
  // Quality can be adjusted if needed.
  await execFileAsync('pngquant', [
    '--force',
    '--skip-if-larger',
    '--ext', '.png',
    '--quality', '70-95',
    '--speed', '1',
    path.join(OUT_DIR, '*.png'),
  ], { shell: true });

  console.log('pngquant optimization complete.');
}

async function optimizeWithOxipng() {
  const ok = await commandExists('oxipng', ['--version']);
  if (!ok) {
    console.warn('oxipng not found. Skipping oxipng step.');
    return;
  }

  // Lossless pass after pngquant.
  await execFileAsync('oxipng', [
    '-o', '4',
    '--strip', 'safe',
    '--alpha',
    path.join(OUT_DIR, '*.png'),
  ], { shell: true });

  console.log('oxipng optimization complete.');
}

async function writeManifest() {
  const manifest = {};

  for (const cat of CATEGORIES) {
    if (cat.isNoData) {
      manifest[cat.key] = `./${cat.key}.png`;
      manifest[cat.selectedKey] = `./${cat.selectedKey}.png`;
      continue;
    }

    for (let aqi = cat.min; aqi <= cat.max; aqi += 1) {
      manifest[`${cat.key}_${aqi}`] = `./${cat.key}_${aqi}.png`;
      manifest[`${cat.selectedKey}_${aqi}`] = `./${cat.selectedKey}_${aqi}.png`;
    }
  }

  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`Wrote manifest to ${manifestPath}`);
}

async function main() {
  await generateAll();
  await writeManifest();
  await optimizeWithPngquant();
  await optimizeWithOxipng();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});