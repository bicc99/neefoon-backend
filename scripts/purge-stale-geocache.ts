import fs from "fs/promises";
import path from "path";

type GeocodeResult = {
  country: string | null;
  country_code: string | null;
  city: string | null;
};

const CACHE_FILE = path.join(process.cwd(), "data", "geocode-cache.json");

// Sub-province indicators — entries matching these will be purged and re-geocoded
const STALE_PATTERNS = [
  /Subdistrict/i,
  /\bDistrict\b/i,
  /Municipality/i,
  /Tambon/i,
  /Amphoe/i,
  /\bBan\s/,       // Thai village prefix "Ban ..."
  /[^\x00-\x7F]/,  // non-ASCII (Thai script)
];

function isStale(city: string | null): boolean {
  if (!city) return false;
  return STALE_PATTERNS.some((re) => re.test(city));
}

async function main() {
  const raw = await fs.readFile(CACHE_FILE, "utf-8");
  const cache = JSON.parse(raw) as Record<string, GeocodeResult>;

  let purged = 0;

  for (const [key, entry] of Object.entries(cache)) {
    if (entry.country_code === "th" && isStale(entry.city)) {
      console.log(`Purging ${key}: "${entry.city}"`);
      delete cache[key];
      purged++;
    }
  }

  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  console.log(`\nDone. Purged ${purged} stale entries. Run build-geocode-cache.ts to re-geocode them.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
