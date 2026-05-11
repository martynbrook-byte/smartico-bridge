/**
 * code.js — Casino Game Assets Figma Plugin
 *
 * Runs in Figma's plugin sandbox (no DOM access).
 * Communicates with ui.html via figma.ui.postMessage / figma.ui.onmessage.
 */

figma.showUI(__html__, {
  width: 340,
  height: 560,
  title: "Casino Game Assets"
});

async function placeImage({
  bytes,
  name,
  width,
  height,
  x,
  y
}) {
  const image = figma.createImage(new Uint8Array(bytes));
  const rect = figma.createRectangle();
  rect.name = name || "Game Image";

  const imageSize = typeof image.getSizeAsync === "function"
    ? await image.getSizeAsync().catch(() => null)
    : null;
  const imageWidth = imageSize && imageSize.width ? imageSize.width : 200;
  const imageHeight = imageSize && imageSize.height ? imageSize.height : 200;
  const w = Math.max(1, Math.round(width || imageWidth));
  const h = Math.max(1, Math.round(height || imageHeight));
  rect.resize(w, h);

  rect.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
  rect.strokes = [];

  const selection = figma.currentPage.selection;
  let parent = figma.currentPage;
  let cx = figma.viewport.center.x;
  let cy = figma.viewport.center.y;

  if (selection.length === 1) {
    const sel = selection[0];
    if (sel.type === "FRAME" || sel.type === "GROUP" || sel.type === "COMPONENT") {
      parent = sel;
      cx = sel.x + sel.width / 2;
      cy = sel.y + sel.height / 2;
    }
  }

  parent.appendChild(rect);
  rect.x = Number.isFinite(x) ? x - w / 2 : cx - w / 2;
  rect.y = Number.isFinite(y) ? y - h / 2 : cy - h / 2;

  figma.currentPage.selection = [rect];
  return rect;
}

function parseDropPayload(event) {
  const candidates = [];
  if (event && event.dropMetadata) {
    if (typeof event.dropMetadata === "string") {
      candidates.push(event.dropMetadata);
    } else if (typeof event.dropMetadata === "object") {
      return event.dropMetadata;
    }
  }

  const items = Array.isArray(event && event.items ? event.items : null) ? event.items : [];
  for (const item of items) {
    if (item && typeof item.data === "string") candidates.push(item.data);
  }

  for (const raw of candidates) {
    if (!raw) continue;
    if (typeof raw === "string" && /^https?:\/\//i.test(raw)) {
      return {
        type: "casino-game-image",
        proxyUrl: raw,
        name: "Game Image"
      };
    }
    const normalized = raw.startsWith("__CASINO_GAME__")
      ? raw.slice("__CASINO_GAME__".length)
      : raw;
    try {
      const parsed = JSON.parse(normalized);
      if (parsed && parsed.type === "casino-game-image") return parsed;
    } catch (e) {
      // ignore invalid payloads
    }
  }
  return null;
}

try {
  figma.on("drop", async (event) => {
    const payload = parseDropPayload(event);
    if (!payload) return true;

    try {
      let bytes = null;
      if (payload && Array.isArray(payload.bytes) && payload.bytes.length > 0) {
        bytes = payload.bytes;
      } else {
        const sourceUrl = payload.proxyUrl || payload.imageUrl;
        if (!sourceUrl) return true;
        const res = await fetch(sourceUrl);
        if (!res.ok) throw new Error(`Drop fetch failed: HTTP ${res.status}`);
        bytes = Array.from(new Uint8Array(await res.arrayBuffer()));
      }

      await placeImage({
        bytes,
        name: payload.name || "Game Image",
        width: payload.width,
        height: payload.height,
        x: Number(event && event.absoluteX != null ? event.absoluteX : event.x),
        y: Number(event && event.absoluteY != null ? event.absoluteY : event.y),
      });

      figma.ui.postMessage({ type: "drop-insert-success", name: payload.name || "Game Image" });
      figma.ui.postMessage({ type: "insert-success", name: payload.name || "Game Image" });
      return false;
    } catch (err) {
      figma.ui.postMessage({
        type: "insert-error",
        message: err.message || "Failed to insert dropped image"
      });
      return true;
    }
  });
} catch (err) {
  console.warn("Drop event unavailable in this Figma runtime:", err.message);
}

// ── Message handler ──────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg) => {
  // ── Insert a single game image ─────────────────────────────────────────────
  if (msg.type === "insert-image") {
    const { bytes, width, height, name, dropClientX, dropClientY } = msg;

    try {
      // If drag-drop coordinates are usable canvas coords, place at drop point.
      // Otherwise, fall back to viewport/selection center.
      const bounds = figma.viewport.bounds;
      const hasDropCoords =
        Number.isFinite(dropClientX) &&
        Number.isFinite(dropClientY) &&
        dropClientX >= bounds.x &&
        dropClientX <= bounds.x + bounds.width &&
        dropClientY >= bounds.y &&
        dropClientY <= bounds.y + bounds.height;

      await placeImage({
        bytes,
        name,
        width,
        height,
        x: hasDropCoords ? dropClientX : undefined,
        y: hasDropCoords ? dropClientY : undefined,
      });

      figma.ui.postMessage({ type: "insert-success", name });

    } catch (err) {
      figma.ui.postMessage({
        type: "insert-error",
        message: err.message || "Failed to insert image"
      });
    }
    return;
  }

  // ── Insert multiple games as a grid ─────────────────────────────────────────
  if (msg.type === "insert-grid") {
    const { items, columns, gap, cellWidth, cellHeight } = msg;

    const nodes = [];

    for (let i = 0; i < items.length; i++) {
      const { bytes, name } = items[i];
      const image = figma.createImage(new Uint8Array(bytes));
      const rect = figma.createRectangle();
      rect.name = name || `Game ${i + 1}`;
      rect.resize(cellWidth, cellHeight);
      rect.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
      rect.strokes = [];

      const col = i % columns;
      const row = Math.floor(i / columns);

      figma.currentPage.appendChild(rect);
      rect.x = figma.viewport.center.x - ((columns * (cellWidth + gap)) / 2) + col * (cellWidth + gap);
      rect.y = figma.viewport.center.y - (Math.ceil(items.length / columns) * (cellHeight + gap) / 2) + row * (cellHeight + gap);

      nodes.push(rect);
    }

    figma.currentPage.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);

    figma.ui.postMessage({ type: "insert-success", name: `${items.length} games` });
    return;
  }

  // ── Close plugin ──────────────────────────────────────────────────────────
  if (msg.type === "close") {
    figma.closePlugin();
    return;
  }
};
