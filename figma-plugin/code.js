// code.js — Smartico Bridge Figma Plugin (sandbox)
// Runs inside Figma's JS sandbox. Has access to figma.* API but no fetch.
// All network calls are made by ui.html, which messages data here.

figma.showUI(__html__, { width: 440, height: 640, title: 'Smartico Bridge' });

// ── Helpers ──────────────────────────────────────────────────────────────────

// Normalise a layer/column name for matching:
// "Profile Name" === "profile_name" === "PROFILE NAME"
function normalise(s) {
  return String(s || '').toLowerCase().replace(/[\s_-]+/g, '_').trim();
}

// Walk a node tree depth-first, calling visitor(node) on every node.
function walk(node, visitor) {
  visitor(node);
  if ('children' in node) {
    for (const child of node.children) walk(child, visitor);
  }
}

// Load an image from bytes (Uint8Array) sent from the UI and return a
// Figma ImageHash that can be used as an image fill.
function createImageFill(bytes) {
  const img = figma.createImage(bytes);
  return {
    type: 'IMAGE',
    scaleMode: 'FILL',
    imageHash: img.hash,
  };
}

// ── Inject a single row into a node (and its descendants) ───────────────────
// columnMap: { [normalisedColumnName]: value }
// imageMap:  { [normalisedColumnName]: Uint8Array }   (pre-fetched by UI)
async function injectRowIntoNode(node, columnMap, imageMap) {
  const errors = [];

  walk(node, (n) => {
    const key = normalise(n.name);

    // ── Text nodes ───────────────────────────────────────────────────────────
    if (n.type === 'TEXT' && key in columnMap) {
      const value = String(columnMap[key] !== undefined && columnMap[key] !== null ? columnMap[key] : '');
      try {
        // Load every font used in the node before writing.
        const fonts = n.getRangeFontName(0, n.characters.length);
        // getRangeFontName may return a Symbol for mixed fonts — handle both.
        if (fonts && typeof fonts === 'object' && 'family' in fonts) {
          figma.loadFontAsync(fonts).then(() => {
            n.characters = value;
          }).catch(() => {
            // Fallback: try to load the first font style we know about
            figma.loadFontAsync({ family: fonts.family, style: fonts.style })
              .then(() => { n.characters = value; })
              .catch(err => errors.push(`Font load failed for "${n.name}": ${err.message}`));
          });
        } else {
          // Mixed fonts or unknown — load Arial as safe fallback
          figma.loadFontAsync({ family: 'Inter', style: 'Regular' })
            .then(() => { n.characters = value; })
            .catch(() => {
              figma.loadFontAsync({ family: 'Roboto', style: 'Regular' })
                .then(() => { n.characters = value; });
            });
        }
      } catch (err) {
        errors.push(`Text "${n.name}": ${err.message}`);
      }
      return;
    }

    // ── Image fills (avatar, avatar_image, etc.) ─────────────────────────────
    // Match any node whose name maps to a column that has image bytes.
    if (key in imageMap && 'fills' in n) {
      try {
        const fill = createImageFill(imageMap[key]);
        n.fills = [fill];
      } catch (err) {
        errors.push(`Image fill "${n.name}": ${err.message}`);
      }
      return;
    }

    // ── Component variants ───────────────────────────────────────────────────
    // If a component instance has a variant property name matching a column,
    // try to set that variant. Works for component sets exposed as instances.
    if (n.type === 'INSTANCE') {
      try {
        const props = n.componentProperties;
        if (props) {
          const updates = {};
          for (const [propName, propDef] of Object.entries(props)) {
            const normProp = normalise(propName);
            if (normProp in columnMap && propDef.type === 'VARIANT') {
              updates[propName] = String(columnMap[normProp]);
            }
          }
          if (Object.keys(updates).length) {
            n.setProperties(updates);
          }
        }
      } catch (_) {
        // Variant setting is best-effort — swallow silently
      }
    }
  });

  return errors;
}

// ── Message handler ──────────────────────────────────────────────────────────
figma.ui.onmessage = async (msg) => {
  // ── get-selection: tell the UI what's selected ──────────────────────────
  if (msg.type === 'get-selection') {
    const sel = figma.currentPage.selection;
    figma.ui.postMessage({
      type: 'selection',
      nodes: sel.map(n => ({
        id: n.id,
        name: n.name,
        type: n.type,
        childCount: 'children' in n ? n.children.length : 0,
      })),
    });
    return;
  }

  // ── inject-single: one row → selected node(s) ──────────────────────────
  if (msg.type === 'inject-single') {
    const { row, imageMap } = msg;
    const sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'inject-result', ok: false, error: 'Nothing selected in Figma. Please select a frame or component first.' });
      return;
    }
    // Build normalised column map
    const columnMap = {};
    for (const [k, v] of Object.entries(row || {})) {
      columnMap[normalise(k)] = v;
    }
    // Build normalised image map from bytes sent by UI
    const normImageMap = {};
    for (const [k, v] of Object.entries(imageMap || {})) {
      normImageMap[normalise(k)] = new Uint8Array(v);
    }

    const allErrors = [];
    for (const node of sel) {
      const errs = await injectRowIntoNode(node, columnMap, normImageMap);
      allErrors.push(...errs);
    }

    figma.ui.postMessage({
      type: 'inject-result',
      ok: true,
      errors: allErrors,
      injectedTo: sel.map(n => n.name),
    });
    return;
  }

  // ── inject-batch: N rows → N child nodes of the selected frame ─────────
  // Each child of the selected frame gets one row (in order).
  if (msg.type === 'inject-batch') {
    const { rows, imageMap } = msg;
    const sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'inject-result', ok: false, error: 'Nothing selected. Select a frame whose children are the repeating items.' });
      return;
    }
    const parent = sel[0];
    if (!('children' in parent)) {
      figma.ui.postMessage({ type: 'inject-result', ok: false, error: `"${parent.name}" has no children. Select a frame or group that contains the repeating items.` });
      return;
    }

    const children = parent.children;
    const count = Math.min(rows.length, children.length);
    const allErrors = [];

    for (let i = 0; i < count; i++) {
      const columnMap = {};
      for (const [k, v] of Object.entries(rows[i] || {})) {
        columnMap[normalise(k)] = v;
      }
      // Each row may have its own image bytes
      const normImageMap = {};
      const rowImages = (imageMap && imageMap[i]) || {};
      for (const [k, v] of Object.entries(rowImages)) {
        normImageMap[normalise(k)] = new Uint8Array(v);
      }
      const errs = await injectRowIntoNode(children[i], columnMap, normImageMap);
      allErrors.push(...errs);
    }

    figma.ui.postMessage({
      type: 'inject-result',
      ok: true,
      injectedCount: count,
      totalRows: rows.length,
      totalSlots: children.length,
      errors: allErrors,
    });
    return;
  }

  // ── close ────────────────────────────────────────────────────────────────
  if (msg.type === 'close') {
    figma.closePlugin();
  }
};
