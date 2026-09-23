/**
 * Generate the fixture images.
 *
 * Run with `node tests/fixtures/generate-media.mjs`. The output is committed,
 * so this only needs running when the fixtures themselves change.
 *
 * The images are deterministic — same inputs, same bytes — because the fixture
 * frontmatter embeds each file's SHA-256 as its media path. A change here means
 * the fixture content must be regenerated with the new digests, which
 * `tests/fixtures/digests.json` records.
 *
 * They are patterns rather than flat colour fields on purpose: a flat image is
 * exactly what the cover pipeline is supposed to reject as a placeholder, and
 * fixtures for the happy path must not look like the thing that fails.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = path.join(here, "media");

/** A deterministic geometric pattern, used so no image is a flat field. */
function pattern({ width, height, hue, seed }) {
  const bars = [];
  const count = 9;
  for (let index = 0; index < count; index += 1) {
    const x = Math.round((index * width) / count);
    const barWidth = Math.max(2, Math.round(width / (count * 2)));
    const barHeight =
      Math.round(((index * seed) % count) / count) * height + height / count;
    bars.push(
      `<rect x="${x}" y="${Math.round(height - barHeight)}" width="${barWidth}" height="${Math.round(barHeight)}" fill="hsl(${(hue + index * 12) % 360} 62% 46%)" />`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="hsl(${hue} 38% 88%)" />
    ${bars.join("\n    ")}
    <circle cx="${Math.round(width * 0.72)}" cy="${Math.round(height * 0.34)}" r="${Math.round(Math.min(width, height) * 0.18)}" fill="hsl(${(hue + 180) % 360} 55% 52%)" />
    <rect x="${Math.round(width * 0.08)}" y="${Math.round(height * 0.12)}" width="${Math.round(width * 0.34)}" height="${Math.round(height * 0.1)}" fill="#172125" />
  </svg>`;
}

const fixtures = [
  { file: "cover-alpha.png", width: 1600, height: 900, hue: 190, seed: 3 },
  { file: "cover-beta.png", width: 1600, height: 900, hue: 28, seed: 5 },
  { file: "figure-wide.png", width: 1200, height: 675, hue: 268, seed: 7 },
  { file: "figure-narrow.png", width: 640, height: 360, hue: 96, seed: 2 },
];

await mkdir(mediaDir, { recursive: true });

const digests = {};

for (const fixture of fixtures) {
  const svg = pattern(fixture);
  const png = await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(mediaDir, fixture.file), png);

  const sha = createHash("sha256").update(png).digest("hex");
  digests[fixture.file] = {
    sha256: sha,
    bytes: png.byteLength,
    width: fixture.width,
    height: fixture.height,
  };
  console.log(`${fixture.file.padEnd(20)} ${sha}`);
}

await writeFile(
  path.join(here, "digests.json"),
  `${JSON.stringify(digests, null, 2)}\n`,
  "utf8",
);
console.log("\nwrote tests/fixtures/digests.json");
