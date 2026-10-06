const fs = require("node:fs/promises");
const path = require("node:path");
const { UPLOAD_DIR } = require("../config/uploads");

// Deletes uploaded files from disk. Missing files are fine (already gone);
// any other failure is logged but never breaks the request.
// path.basename() makes sure a stored name can never point outside UPLOAD_DIR.
async function removeStoredFiles(filenames) {
  await Promise.all(
    filenames.map(async (name) => {
      try {
        await fs.unlink(path.join(UPLOAD_DIR, path.basename(name)));
      } catch (err) {
        if (err.code !== "ENOENT") {
          console.error(`Could not delete upload ${name}: ${err.message}`);
        }
      }
    }),
  );
}

module.exports = { removeStoredFiles };
