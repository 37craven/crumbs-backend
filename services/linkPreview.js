const dns = require("node:dns/promises");
const net = require("node:net");
const HttpError = require("../utils/httpError");

const TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024; // never download more than 512 KB of a page
const MAX_REDIRECTS = 3;

// ---------------------------------------------------------------------------
// Safety: only talk to public websites.
//
// The server fetches whatever link a user pastes. Without checks, someone
// could paste http://localhost:3000/... or an internal network address and use
// our server to reach things only the server can see (this is called SSRF).
// So we refuse any address that is private, local or reserved.
// Known limit: a DNS record that changes between our check and the fetch
// (DNS rebinding) is not covered. Fine for this project; note it if deploying.
// ---------------------------------------------------------------------------

function isPrivateIPv4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || // "this network"
    a === 10 || // private
    a === 127 || // loopback (localhost)
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, includes cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    a >= 224 // multicast and reserved
  );
}

function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);

  if (family === 6) {
    const address = ip.toLowerCase();
    if (address === "::" || address === "::1") return true;

    // IPv4 hidden inside IPv6, e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1
    const dotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateIPv4(dotted[1]);
    const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return isPrivateIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    if (address.startsWith("::ffff:")) return true; // unknown mapped form: be safe

    return (
      address.startsWith("fc") || // unique local fc00::/7
      address.startsWith("fd") ||
      /^fe[89ab]/.test(address) // link-local fe80::/10
    );
  }

  return true; // not a valid IP at all: treat as unsafe
}

// Throws a 400 unless `rawUrl` is a public http(s) address. Returns the URL.
async function assertPublicHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "That doesn't look like a valid link");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "Links must start with http:// or https://");
  }
  if (url.username || url.password) {
    throw new HttpError(400, "Links with a username or password are not allowed");
  }

  // IPv6 hostnames come wrapped in [brackets].
  const host = url.hostname.replace(/^\[|\]$/g, "");

  let addresses;
  if (net.isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await dns.lookup(host, { all: true });
    } catch {
      throw new HttpError(400, "Could not find that website. Check the link.");
    }
  }

  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
    throw new HttpError(400, "That link points to a private or local address");
  }

  return url;
}

// ---------------------------------------------------------------------------
// Embeds: YouTube and Vimeo links can be shown as a player.
// We rebuild the embed URL ourselves from a validated video id, so a page can
// never smuggle in an arbitrary iframe address.
// ---------------------------------------------------------------------------
function getEmbedUrl(url) {
  const host = url.hostname.replace(/^www\./, "");
  let videoId = null;

  if (host === "youtu.be") {
    videoId = url.pathname.slice(1).split("/")[0];
  } else if (host === "youtube.com" || host === "m.youtube.com") {
    if (url.pathname === "/watch") {
      videoId = url.searchParams.get("v");
    } else {
      videoId = url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/)?.[1];
    }
  } else if (host === "vimeo.com") {
    const vimeoId = url.pathname.match(/^\/(\d+)/)?.[1];
    return vimeoId ? `https://player.vimeo.com/video/${vimeoId}` : null;
  }

  return videoId && /^[\w-]{6,20}$/.test(videoId)
    ? `https://www.youtube.com/embed/${videoId}`
    : null;
}

// ---------------------------------------------------------------------------
// Reading a page's title, description, image and icon.
// ---------------------------------------------------------------------------
const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };

function decodeEntities(text) {
  return text
    .replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m])
    .replace(/&#(\d+);/g, (m, code) =>
      Number(code) <= 0x10ffff ? String.fromCodePoint(Number(code)) : m,
    );
}

function clip(text, max) {
  return text ? text.slice(0, max) : null;
}

// <meta property="og:title" content="Hello"> -> { property: "og:title", content: "Hello" }
function parseAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3];
  }
  return attributes;
}

// Resolves "/img/a.png" against the page address. Only http(s) results are kept,
// so a page cannot hand us a javascript: or data: address.
function toAbsoluteUrl(value, base) {
  if (!value) return null;
  try {
    const url = new URL(decodeEntities(value.trim()), base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function parseMetadata(html, pageUrl) {
  const meta = {};
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const attributes = parseAttributes(tag);
    const key = (attributes.property ?? attributes.name ?? "").toLowerCase();
    if (key && attributes.content && !(key in meta)) {
      meta[key] = decodeEntities(attributes.content.trim());
    }
  }

  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const iconTag = (html.match(/<link\s[^>]*>/gi) ?? [])
    .map(parseAttributes)
    .find((attributes) => /\bicon\b/i.test(attributes.rel ?? ""));

  return {
    title: clip(meta["og:title"] ?? meta["twitter:title"] ?? (titleTag ? decodeEntities(titleTag.trim()) : null), 200),
    description: clip(meta["og:description"] ?? meta["twitter:description"] ?? meta.description, 300),
    image: toAbsoluteUrl(meta["og:image"] ?? meta["twitter:image"], pageUrl),
    siteName: clip(meta["og:site_name"] ?? pageUrl.hostname.replace(/^www\./, ""), 100),
    favicon: toAbsoluteUrl(iconTag?.href ?? "/favicon.ico", pageUrl),
  };
}

// ---------------------------------------------------------------------------
// Downloading the page.
// ---------------------------------------------------------------------------
async function readLimited(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchHtml(startUrl) {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // redirect: "manual" so WE follow redirects and re-check every address.
    // Otherwise a public site could redirect us to a private one.
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "User-Agent": "CrumbsLinkPreview/1.0",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = await assertPublicHttpUrl(new URL(location, current).href);
      continue;
    }

    if (!response.ok) throw new Error(`Site answered with status ${response.status}`);
    if (!(response.headers.get("content-type") ?? "").includes("text/html")) {
      throw new Error("Not a web page");
    }

    return { html: await readLimited(response, MAX_BYTES), finalUrl: current };
  }

  throw new Error("Too many redirects");
}

// What the link widget stores for a pasted URL.
// An invalid or private address is the user's mistake -> 400.
// A site that is slow, down, or has no preview data is NOT an error: we still
// save the link and mark the preview "unavailable" so the page can fall back
// to showing the plain address.
async function buildLinkData(rawUrl) {
  const url = await assertPublicHttpUrl(rawUrl.trim());
  const embedUrl = getEmbedUrl(url);

  try {
    const { html, finalUrl } = await fetchHtml(url);
    return {
      url: url.href,
      embedUrl,
      preview: { status: "ok", ...parseMetadata(html, finalUrl), fetchedAt: new Date() },
    };
  } catch {
    return {
      url: url.href,
      embedUrl,
      preview: {
        status: "unavailable",
        title: null,
        description: null,
        image: null,
        siteName: url.hostname.replace(/^www\./, ""),
        favicon: null,
        fetchedAt: new Date(),
      },
    };
  }
}

module.exports = {
  buildLinkData,
  assertPublicHttpUrl,
  isPrivateIp,
  getEmbedUrl,
  parseMetadata,
};
