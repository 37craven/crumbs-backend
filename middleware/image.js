const express = require("express");

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Trust the file's own bytes, not the Content-Type the client claims.
function sniffImageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length > 8 && buf.subarray(0, 8).equals(pngSignature)) {
    return "image/png";
  }
  if (
    buf.length > 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

// Reads an image sent as the raw request body into req.body (a Buffer).
function rawImage(limitBytes, tooLargeMessage) {
  const parse = express.raw({ type: IMAGE_TYPES, limit: limitBytes });

  return (req, res, next) => {
    parse(req, res, (error) => {
      if (error?.type === "entity.too.large") {
        return res.status(413).json({ message: tooLargeMessage });
      }
      next(error);
    });
  };
}

module.exports = { rawImage, sniffImageType };
