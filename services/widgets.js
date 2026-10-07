const { Widget, widgetModels, MAX_WIDGETS_PER_ROW } = require("../models/Widget");
const HttpError = require("../utils/httpError");
const { buildLinkData } = require("./linkPreview");

// Copies validated request data onto a widget document. Used both when a widget
// is created and when it is edited, so the rules live in one place.
// It only sets what the request contained: leaving a field out leaves it alone.
async function applyWidgetData(widget, data) {
  switch (widget.type) {
    case "notes":
      if (data.body !== undefined) widget.body = data.body;
      if (data.checklist !== undefined) {
        // Items sent back with their id keep that id; new items get a fresh one.
        widget.checklist = data.checklist.map((item) => ({
          ...(item.id && { _id: item.id }),
          text: item.text,
          done: item.done,
        }));
      }
      break;

    case "date":
      if (data.date !== undefined) widget.date = data.date; // null clears it
      if (data.label !== undefined) widget.label = data.label;
      break;

    case "link": {
      if (data.url === undefined) break;

      if (!data.url) {
        // "" or null: remove the link.
        widget.url = null;
        widget.embedUrl = null;
        widget.preview = null;
      } else {
        const link = await buildLinkData(data.url);
        // The fetch is slow, so skip storing again when the address did not change.
        if (link.url !== widget.url || !widget.preview) {
          widget.url = link.url;
          widget.embedUrl = link.embedUrl;
          widget.preview = link.preview;
        }
      }
      break;
    }

    default:
      break; // image widgets change through the /image endpoints
  }
}

// Adds a widget to the end of a row. `data` is the optional starting content.
async function addWidget(collection, userId, rowId, type, data = {}) {
  if (!collection.rows.some((row) => String(row._id) === String(rowId))) {
    throw new HttpError(404, "Row not found");
  }

  const existing = await Widget.find({ collectionId: collection._id, row: rowId }).select("order").lean();
  if (existing.length >= MAX_WIDGETS_PER_ROW) {
    throw new HttpError(400, `A row can hold at most ${MAX_WIDGETS_PER_ROW} widgets`);
  }

  const order = existing.length ? Math.max(...existing.map((w) => w.order)) + 1 : 0;
  const widget = new widgetModels[type]({ collectionId: collection._id, row: rowId, createdBy: userId, order });

  await applyWidgetData(widget, data);
  await widget.save();
  return widget;
}

module.exports = { applyWidgetData, addWidget };
