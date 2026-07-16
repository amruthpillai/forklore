import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const requireFromSite = createRequire(path.join(root, "site", "package.json"));
const yaml = requireFromSite("js-yaml");
const maintainersDir = path.join(root, "content", "maintainers");
const outputDir = path.join(root, "public", "og");
const maintainerOutputDir = path.join(outputDir, "maintainers");

// Native OG size (1200x630)
const OUTPUT_WIDTH = 1200;

const fontMonoB64 = (await readFile(
  path.join(root, "site", "assets", "fonts", "geist-mono-latin.woff2"),
)).toString("base64");
const fontSansB64 = (await readFile(
  path.join(root, "site", "assets", "fonts", "inter-latin.woff2"),
)).toString("base64");

const fontDefs = `
  <defs><style>
    @font-face {
      font-family: 'Geist Mono';
      src: url('data:font/woff2;base64,${fontMonoB64}') format('woff2');
      font-weight: 400 700;
    }
    @font-face {
      font-family: 'Inter';
      src: url('data:font/woff2;base64,${fontSansB64}') format('woff2');
      font-weight: 400 700;
    }
  </style></defs>`;

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(value, maxLength) {
  const text = String(value || "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function frontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  return match ? yaml.load(match[1]) : {};
}

function stripMarkdown(text) {
  return String(text || "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

// Mirror the site's shortLabel filter: last path segment of the repo URL,
// else the project name.
function shortLabel(project) {
  if (project?.project_link) {
    try {
      const parts = new URL(project.project_link).pathname
        .replace(/\/$/, "")
        .split("/")
        .filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    } catch {
      // fall through to name
    }
  }
  return project?.name || "";
}

async function loadImageBase64(filePath) {
  try {
    const abs = path.join(root, "public", filePath.replace(/^\//, ""));
    if (!existsSync(abs)) return null;
    const buf = await readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    if (ext === ".svg") {
      return `data:image/svg+xml;base64,${buf.toString("base64")}`;
    }
    const mime = ext === ".png" ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// Shared background: dashed frame, corner crosshairs, header band, branding.
function chrome() {
  return `
    <rect width="1200" height="630" fill="#18222A"/>

    <!-- Dashed border frame -->
    <path d="M100 1941L100 0" stroke="white" stroke-opacity="0.2" stroke-width="3" stroke-dasharray="8 8"/>
    <path d="M1100 1941V0" stroke="white" stroke-opacity="0.2" stroke-width="3" stroke-dasharray="8 8"/>
    <path d="M-370 80L1571 80" stroke="white" stroke-opacity="0.2" stroke-width="3" stroke-dasharray="8 8"/>
    <path d="M-370 550H1571" stroke="white" stroke-opacity="0.2" stroke-width="3" stroke-dasharray="8 8"/>

    <!-- Corner crosshairs -->
    <path d="M92 80H108" stroke="#CFF2DA" stroke-width="3"/>
    <path d="M100 88V72" stroke="#CFF2DA" stroke-width="3"/>
    <path d="M92 550H108" stroke="#CFF2DA" stroke-width="3"/>
    <path d="M100 558V542" stroke="#CFF2DA" stroke-width="3"/>
    <path d="M1092 550H1108" stroke="#CFF2DA" stroke-width="3"/>
    <path d="M1100 558V542" stroke="#CFF2DA" stroke-width="3"/>
    <path d="M1092 80H1108" stroke="#CFF2DA" stroke-width="3"/>
    <path d="M1100 88V72" stroke="#CFF2DA" stroke-width="3"/>

    <!-- Header band -->
    <rect x="100" y="80" width="1000" height="260" fill="#CFF2DA" fill-opacity="0.2"/>

    <!-- Bottom branding -->
    <text x="150" y="465" fill="#CFF2DA" font-family="Geist Mono, monospace" font-size="52" font-weight="700">forklore_</text>
    <text x="150" y="508" fill="#CFF2DA" font-family="Geist Mono, monospace" font-size="24">By FOSS United</text>`;
}

function svgWrap(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
  ${fontDefs}
  <clipPath id="clip"><rect width="1200" height="630"/></clipPath>
  <g clip-path="url(#clip)">
    ${chrome()}
    ${inner}
  </g>
</svg>`;
}

// Site-wide OG (homepage): left-aligned title + description in the band.
function renderIndexOg({ title, eyebrow, description }) {
  const safeTitle = escapeXml(truncate(title, 40));
  const safeEyebrow = escapeXml(truncate(eyebrow, 60));
  const safeDescription = escapeXml(truncate(description, 70));
  return svgWrap(`
    <text x="150" y="130" fill="#CFF2DA" font-family="Geist Mono, monospace" font-size="24" opacity="0.7">${safeEyebrow}</text>
    <text x="150" y="230" fill="#CFF2DA" font-family="Geist Mono, monospace" font-size="58" font-weight="700">${safeTitle}</text>
    <text x="150" y="295" fill="#CFF2DA" font-family="Inter, sans-serif" font-size="24">${safeDescription}</text>`);
}

// Maintainer OG: photo top-right, name + designation right-aligned beside it,
// project logo boxes along the bottom-right (contained, never cropped).
function renderMaintainerOg({ name, username, designation, photoDataUri, projects }) {
  const safeUser = escapeXml(truncate(username, 30));
  const safeDesignation = escapeXml(truncate(designation, 46));

  // Photo box: top-right inside the header band.
  const photoX = 890;
  const photoY = 115;
  const photoSize = 180;
  const photoSvg = photoDataUri
    ? `
    <clipPath id="photoClip"><rect x="${photoX}" y="${photoY}" width="${photoSize}" height="${photoSize}"/></clipPath>
    <rect x="${photoX}" y="${photoY}" width="${photoSize}" height="${photoSize}" fill="#eef0f1"/>
    <image href="${photoDataUri}" x="${photoX}" y="${photoY}" width="${photoSize}" height="${photoSize}" clip-path="url(#photoClip)" preserveAspectRatio="xMidYMid slice"/>
    <rect x="${photoX}" y="${photoY}" width="${photoSize}" height="${photoSize}" fill="none" stroke="#CFF2DA" stroke-width="3"/>`
    : "";

  // Name, right-aligned single line, ending just left of the photo. Fills the
  // full band width, then truncates with an ellipsis (Geist Mono ~0.6em/glyph).
  const textEndX = photoX - 30;
  const leftBound = 150;
  const nameSize = 52;
  const maxNameChars = Math.max(1, Math.floor((textEndX - leftBound) / (nameSize * 0.6)));
  const safeName = escapeXml(truncate(name, maxNameChars));
  const headerText = `
    <text x="${textEndX}" y="150" text-anchor="end" fill="#CFF2DA" font-family="Geist Mono, monospace" font-size="22" opacity="0.7">@${safeUser}</text>
    <text x="${textEndX}" y="215" text-anchor="end" fill="#CFF2DA" font-family="Geist Mono, monospace" font-size="${nameSize}" font-weight="700">${safeName}</text>
    <text x="${textEndX}" y="262" text-anchor="end" fill="#CFF2DA" font-family="Inter, sans-serif" font-size="26">${safeDesignation}</text>`;

  // Project logo boxes along the bottom of the right half (left half holds the
  // branding). Contained fit so logos are never cropped; max 4.
  const box = 90;
  const gap = 20;
  const pad = 12;
  const rowY = 400;
  const rightHalfCenterX = 850;

  const boxMarkup = (x, p) => {
    let inner;
    if (p.logoDataUri) {
      inner = `<image href="${p.logoDataUri}" x="${x + pad}" y="${rowY + pad}" width="${box - 2 * pad}" height="${box - 2 * pad}" preserveAspectRatio="xMidYMid meet"/>`;
    } else {
      // No logo: show the project's first word, fitted to the box.
      const word = String(p.name || p.label || "").trim().split(/\s+/)[0] || "";
      const wordSize = Math.max(
        9,
        Math.min(22, Math.floor((box - 2 * pad) / Math.max(1, word.length * 0.62))),
      );
      inner = `<text x="${x + box / 2}" y="${rowY + box / 2}" text-anchor="middle" dominant-baseline="central" fill="#18222A" font-family="Geist Mono, monospace" font-size="${wordSize}" font-weight="700">${escapeXml(word)}</text>`;
    }
    return `<rect x="${x}" y="${rowY}" width="${box}" height="${box}" fill="#eef0f1"/>${inner}<rect x="${x}" y="${rowY}" width="${box}" height="${box}" fill="none" stroke="#CFF2DA" stroke-width="2"/>`;
  };

  const shown = (projects || []).slice(0, 4);
  const n = shown.length;
  let projectsSvg = "";
  if (n === 1) {
    // Single project: show the name beside the lone box, the pair centered in
    // the right half.
    const p = shown[0];
    const label = truncate(p.name, 16);
    const labelSize = 28;
    const labelWidth = Math.ceil(label.length * labelSize * 0.6);
    const total = labelWidth + gap + box;
    const startX = rightHalfCenterX - total / 2;
    projectsSvg =
      `<text x="${startX}" y="${rowY + box / 2}" text-anchor="start" dominant-baseline="central" fill="#CFF2DA" font-family="Geist Mono, monospace" font-size="${labelSize}" font-weight="600">${escapeXml(label)}</text>` +
      boxMarkup(startX + labelWidth + gap, p);
  } else if (n > 1) {
    const startX = rightHalfCenterX - (n * box + (n - 1) * gap) / 2;
    projectsSvg = shown.map((p, i) => boxMarkup(startX + i * (box + gap), p)).join("");
  }

  return svgWrap(`${photoSvg}${headerText}${projectsSvg}`);
}

function svgToPng(svgString) {
  return execFileSync("rsvg-convert", [
    "--width", String(OUTPUT_WIDTH),
    "--format", "png",
  ], { input: svgString, maxBuffer: 20 * 1024 * 1024 });
}

await rm(outputDir, { force: true, recursive: true });
await mkdir(maintainerOutputDir, { recursive: true });

const indexSvg = renderIndexOg({
  title: "Forklore",
  eyebrow: "forklore.in",
  description: "Confessions, quirks, and occasional rants from India's open source keepers.",
});
await writeFile(path.join(outputDir, "index.png"), svgToPng(indexSvg));

const files = (await readdir(maintainersDir))
  .filter((file) => file.endsWith(".md"))
  .sort((a, b) => a.localeCompare(b));

for (const file of files) {
  const data = frontmatter(await readFile(path.join(maintainersDir, file), "utf8"));
  if (!data.username) continue;

  const photoDataUri = data.photo ? await loadImageBase64(data.photo) : null;
  const projects = [];
  for (const project of (data.projects || []).slice(0, 4)) {
    projects.push({
      name: project.name,
      label: shortLabel(project),
      logoDataUri: project.logo ? await loadImageBase64(project.logo) : null,
    });
  }

  const svg = renderMaintainerOg({
    name: data.full_name || data.username,
    username: data.username,
    designation: stripMarkdown(data.designation) || "Forklore maintainer profile",
    photoDataUri,
    projects,
  });
  await writeFile(path.join(maintainerOutputDir, `${data.username}.png`), svgToPng(svg));
}

console.log(`Generated ${files.length + 1} OG images (PNG) in public/og`);
