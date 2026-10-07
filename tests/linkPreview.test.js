const test = require("node:test");
const assert = require("node:assert/strict");
const { isPrivateIp, assertPublicHttpUrl, getEmbedUrl, parseMetadata } = require("../services/linkPreview");

test("private and reserved addresses are blocked", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "::ffff:127.0.0.1", "fd00::1", "fe80::1"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
});

test("public addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("bad or dangerous links are rejected before any request is made", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com", "javascript:alert(1)", "not a url", "http://127.0.0.1:3000", "http://localhost/admin", "http://[::1]/", "http://user:pass@example.com"]) {
    await assert.rejects(assertPublicHttpUrl(url), (e) => e.status === 400, url);
  }
});

test("YouTube and Vimeo links become embed URLs", () => {
  const embed = (u) => getEmbedUrl(new URL(u));
  assert.equal(embed("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "https://www.youtube.com/embed/dQw4w9WgXcQ");
  assert.equal(embed("https://youtu.be/dQw4w9WgXcQ?t=10"), "https://www.youtube.com/embed/dQw4w9WgXcQ");
  assert.equal(embed("https://www.youtube.com/shorts/abcdef12345"), "https://www.youtube.com/embed/abcdef12345");
  assert.equal(embed("https://vimeo.com/76979871"), "https://player.vimeo.com/video/76979871");
  assert.equal(embed("https://example.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(embed("https://www.youtube.com/watch?v=<script>"), null); // junk ids are refused
});

test("parseMetadata reads Open Graph tags, whatever the attribute order", () => {
  const html = `<html><head>
    <title>Fallback title</title>
    <meta content="Real &amp; Good" property="og:title">
    <meta property="og:description" content="A short summary">
    <meta property="og:image" content="/img/cover.png">
    <meta property="og:site_name" content="Example Site">
    <link rel="shortcut icon" href="/fav.ico">
  </head></html>`;
  const meta = parseMetadata(html, new URL("https://example.com/post/1"));
  assert.equal(meta.title, "Real & Good");
  assert.equal(meta.description, "A short summary");
  assert.equal(meta.image, "https://example.com/img/cover.png"); // made absolute
  assert.equal(meta.siteName, "Example Site");
  assert.equal(meta.favicon, "https://example.com/fav.ico");
});

test("parseMetadata falls back to <title> and the hostname", () => {
  const meta = parseMetadata("<title> Plain page </title>", new URL("https://www.example.org/x"));
  assert.equal(meta.title, "Plain page");
  assert.equal(meta.siteName, "example.org");
  assert.equal(meta.image, null);
  assert.equal(meta.favicon, "https://www.example.org/favicon.ico");
});

test("parseMetadata ignores non-http images", () => {
  const meta = parseMetadata('<meta property="og:image" content="javascript:alert(1)">', new URL("https://example.com"));
  assert.equal(meta.image, null);
});
