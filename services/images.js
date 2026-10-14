const { imageSchema, imagePathFor } = require("../models/Image");

// Serves the bytes of a stored picture.
//
// Caching needs care here. The old address contained a random file name, so a picture
// that was replaced also changed address and could be cached forever. These addresses
// are stable, so an immutable cache would keep showing the picture a user replaced.
// An ETag over the subdocument's id and upload time gives the browser a cheap 304 when
// nothing changed, and a fresh 200 with the new bytes when it did.
const CACHE_CONTROL = "private, no-cache";

function sendImage(req, res, image) {
  if (!image?.data) return res.status(404).end();

  const etag = `"${image._id}-${new Date(image.uploadedAt ?? 0).getTime()}"`;

  res.set({
    "Content-Type": image.mimeType || "application/octet-stream",
    "Content-Length": String(image.data.length),
    "Cache-Control": CACHE_CONTROL,
    ETag: etag,
    // Stored pictures are only ever the four types config/uploads.js allows, and this
    // stops a browser from trying to sniff something else out of the bytes.
    "X-Content-Type-Options": "nosniff",
  });

  // A fresh request gets the whole picture; one that revalidates a match gets 304
  // with no body. If-None-Match is a REQUEST header, so it is read off the request.
  if (req.get("If-None-Match") === etag) return res.status(304).end();

  return res.send(image.data);
}

module.exports = { sendImage, imageSchema, imagePathFor };
