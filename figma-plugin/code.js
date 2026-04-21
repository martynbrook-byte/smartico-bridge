// code.js — Smartico Bridge Figma Plugin (sandbox)
// Runs inside Figma's sandboxed JS environment — no fetch, no modern syntax (no ??, no ?.)
//
// Injection convention:
//   Layer name: #columnname.rowindex   (1-based, case-insensitive column match)
//   Examples:   #prize.1   #avatar.2   #profile_name.3   #phone.1
//
// Text nodes   → value written as characters
// Any node with fills → image fill set (if imageMap has bytes for that ref)

figma.showUI(__html__, { width: 440, height: 580, title: 'Smartico Bridge' });

// ── Helpers ──────────────────────────────────────────────────────────────────

var REF_PATTERN = /^#([a-zA-Z0-9_]+)\.(\d+)$/;

function walk(node, visitor) {
  visitor(node);
  if ('children' in node) {
    for (var i = 0; i < node.children.length; i++) {
      walk(node.children[i], visitor);
    }
  }
}

function createImageFill(bytes) {
  var img = figma.createImage(new Uint8Array(bytes));
  return { type: 'IMAGE', scaleMode: 'FILL', imageHash: img.hash };
}

async function loadNodeFont(node) {
  try {
    var len = node.characters ? node.characters.length : 0;
    var font = len > 0 ? node.getRangeFontName(0, len) : null;
    if (font && typeof font === 'object' && font.family) {
      await figma.loadFontAsync({ family: font.family, style: font.style });
    } else {
      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    }
  } catch (e) {
    try { await figma.loadFontAsync({ family: 'Roboto', style: 'Regular' }); } catch (_) {}
  }
}

// ── Message handler ──────────────────────────────────────────────────────────
figma.ui.onmessage = async function(msg) {

  // ── scan-refs: walk selection, collect all #name.index layer names ────────
  if (msg.type === 'scan-refs') {
    var sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'scan-result', ok: false, error: 'Nothing selected in Figma. Select a frame or group first.' });
      return;
    }
    var refsFound = {};
    for (var s = 0; s < sel.length; s++) {
      walk(sel[s], function(n) {
        var m = n.name.match(REF_PATTERN);
        if (m) {
          var key = m[1].toLowerCase() + '.' + m[2]; // "prize.1"
          refsFound[key] = true;
        }
      });
    }
    figma.ui.postMessage({ type: 'scan-result', ok: true, refs: Object.keys(refsFound) });
    return;
  }

  // ── inject-refs: write resolved values into matching #name.index nodes ────
  // msg.values:   { 'prize.1': 'Free Flight 20MT', 'profile_name.1': 'João', ... }
  // msg.imageMap: { 'avatar.1': [/* byte array */], ... }
  if (msg.type === 'inject-refs') {
    var values   = msg.values   || {};
    var imageMap = msg.imageMap || {};
    var sel2     = figma.currentPage.selection;

    if (!sel2.length) {
      figma.ui.postMessage({ type: 'inject-result', ok: false, error: 'Nothing selected in Figma.' });
      return;
    }

    var errors  = [];
    var count   = 0;
    var pending = [];

    // Collect all matching nodes synchronously, then process async
    for (var s2 = 0; s2 < sel2.length; s2++) {
      walk(sel2[s2], function(n) {
        var m2 = n.name.match(REF_PATTERN);
        if (!m2) return;
        var key = m2[1].toLowerCase() + '.' + m2[2]; // normalised key

        if (n.type === 'TEXT' && (key in values)) {
          pending.push({ node: n, key: key, type: 'text' });
          return;
        }
        if ('fills' in n && (key in imageMap)) {
          pending.push({ node: n, key: key, type: 'image' });
        }
      });
    }

    for (var p = 0; p < pending.length; p++) {
      var item = pending[p];
      try {
        if (item.type === 'text') {
          await loadNodeFont(item.node);
          item.node.characters = String(values[item.key] !== null && values[item.key] !== undefined ? values[item.key] : '');
          count++;
        } else if (item.type === 'image') {
          item.node.fills = [createImageFill(imageMap[item.key])];
          count++;
        }
      } catch (err) {
        errors.push(item.node.name + ': ' + err.message);
      }
    }

    figma.ui.postMessage({
      type:   'inject-result',
      ok:     true,
      count:  count,
      total:  pending.length,
      errors: errors,
    });
    return;
  }

  // ── get-selection: report current selection to the UI ─────────────────────
  if (msg.type === 'get-selection') {
    var sel3 = figma.currentPage.selection;
    figma.ui.postMessage({
      type:  'selection',
      nodes: sel3.map(function(n) {
        return {
          id:         n.id,
          name:       n.name,
          type:       n.type,
          childCount: 'children' in n ? n.children.length : 0,
        };
      }),
    });
    return;
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};
