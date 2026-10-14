const Crumb = require("../models/Crumb");
const { widgetModels, MAX_WIDGETS_PER_ROW } = require("../models/Widget");
const { imageFromUpload } = require("../models/Image");
const HttpError = require("../utils/httpError");
const { findAccessibleCollection } = require("./access");
const { refreshCollectionSummary } = require("./collectionSummary");

// Files an upload to a collection produces. An image widget must exist before
// a picture goes in, so one is created first and the picture set on it.
async function attachImageWidget(collection, userId, file) {
  const rowId = collection.rows[0]?._id;
  if (!rowId) {
    throw new HttpError(400, "This collection has no rows to add the picture to");
  }

  const existing = await widgetModels.image
    .find({ collectionId: collection._id, row: rowId })
    .select("order")
    .lean();
  if (existing.length >= MAX_WIDGETS_PER_ROW) {
    throw new HttpError(
      400,
      `A row can hold at most ${MAX_WIDGETS_PER_ROW} widgets`,
    );
  }

  const order = existing.length
    ? Math.max(...existing.map((w) => w.order)) + 1
    : 0;

  const widget = new widgetModels.image({
    collectionId: collection._id,
    row: rowId,
    createdBy: userId,
    order,
    image: imageFromUpload(file),
  });
  await widget.save();
  return widget;
}

// Saves a crumb, and optionally files the same picture into a collection as an
// image widget on its first row.
//
// The same bytes are held by two records here — the crumb and the widget — which
// used to mean the same file on disk backed both, and deleting either had to check
// the other still needed it. Each record now carries its own copy of the picture,
// so each is simply deleted on its own and nothing is left behind to check for.
//
// If the collection copy fails the crumb is still saved on its own, because losing
// the user's photo to a bad collection id would be worse.
async function createCrumb(user, file, { caption, collectionId }) {
  const crumb = await Crumb.create({
    user: user._id,
    image: imageFromUpload(file),
    caption,
  });

  if (!collectionId) return { crumb, widget: null };

  let widget;
  try {
    const collection = await findAccessibleCollection(collectionId, user._id);
    widget = await attachImageWidget(collection, user._id, file);
  } catch (err) {
    // Keep the crumb; only the collection copy failed. The collection's summary
    // can still need refreshing if the widget went in before the error.
    if (widget) await refreshCollectionSummary(widget.collectionId);
    crumb.collectionId = null;
    await crumb.save();
    return { crumb, widget: null, copyError: err };
  }

  crumb.collectionId = widget.collectionId;
  await crumb.save();

  await refreshCollectionSummary(widget.collectionId);
  return { crumb, widget };
}

module.exports = { createCrumb, attachImageWidget };
