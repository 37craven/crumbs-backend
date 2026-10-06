const Crumb = require("../models/Crumb");
const { widgetModels, MAX_WIDGETS_PER_ROW } = require("../models/Widget");
const HttpError = require("../utils/httpError");
const { findAccessibleCollection } = require("./access");
const { refreshCollectionSummary } = require("./collectionSummary");
const { removeStoredFiles, publicUrl } = require("./imageFiles");

// A crumb and a collection's image widget are separate records that can point
// at ONE file on disk (see the copy helper below). Deleting either one must
// not pull the file out from under the other, so before unlinking anything we
// check whether any widget still refers to that name.
async function fileStillReferenced(filename) {
  const widget = await widgetModels.image
    .exists({ "image.filename": filename });
  return Boolean(widget);
}

// Deletes a stored file, unless a collection's image widget still needs it.
async function removeFileUnlessShared(filename) {
  if (!filename) return;
  if (await fileStillReferenced(filename)) return;
  await removeStoredFiles([filename]);
}

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
    image: {
      filename: file.filename,
      originalName: file.originalname.slice(0, 255),
      url: publicUrl(file.filename),
      mimeType: file.mimetype,
      size: file.size,
      uploadedAt: new Date(),
    },
  });
  await widget.save();
  return widget;
}

// Saves a crumb, and optionally files the same picture into a collection as an
// image widget on its first row.
//
// The file is already on disk (multer put it there before the handler ran), so
// any failure has to clean up: the file, the widget and the crumb. If the
// collection copy fails the crumb is still saved on its own, because losing the
// user's photo to a bad collection id would be worse.
async function createCrumb(user, file, { caption, collectionId }) {
  const crumb = await Crumb.create({
    user: user._id,
    filename: file.filename,
    originalName: file.originalname.slice(0, 255),
    url: publicUrl(file.filename),
    mimeType: file.mimetype,
    size: file.size,
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

module.exports = {
  createCrumb,
  removeFileUnlessShared,
  fileStillReferenced,
};
