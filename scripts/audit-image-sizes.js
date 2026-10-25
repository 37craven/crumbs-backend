const mongoose = require("mongoose");

process.loadEnvFile();

const { assertSafeDatabase } = require("../config/database");
const Crumb = require("../models/Crumb");
const { Widget } = require("../models/Widget");
const User = require("../models/User");

const RESPONSE_LIMIT = 4.5 * 1024 * 1024;

async function run() {
  assertSafeDatabase(process.env.MONGODB_URI);
  await mongoose.connect(process.env.MONGODB_URI);

  const [crumbs, widgets, avatars] = await Promise.all([
    Crumb.collection.countDocuments({ "image.size": { $gt: RESPONSE_LIMIT } }),
    Widget.collection.countDocuments({
      type: "image",
      "image.size": { $gt: RESPONSE_LIMIT },
    }),
    User.collection.countDocuments({ "avatar.size": { $gt: RESPONSE_LIMIT } }),
  ]);

  console.log(
    `Images over 4.5 MB: ${crumbs} crumb(s), ${widgets} widget(s), ${avatars} avatar(s).`,
  );

  await mongoose.disconnect();
  if (crumbs + widgets + avatars > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error("Could not audit image sizes: ", err.message);
  process.exit(1);
});
