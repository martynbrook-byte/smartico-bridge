// code.js — Smartico Bridge Figma Plugin (sandbox)
// Runs inside Figma's sandboxed JS environment — no fetch, no modern syntax (no ??, no ?.)
//
// Injection convention:
//   Layer name: #columnname.rowindex   (1-based, case-insensitive column match)
//   Examples:   #prize.1   #avatar.2   #profile_name.3   #phone.1
//
// Behaviour by node type:
//   TEXT                     → value written as characters
//   INSTANCE (component)     → if a variant property matches the column name
//                              (case-insensitive) and the row value is a valid
//                              option, set that variant. Otherwise falls through
//                              to image fill (if applicable).
//   Any node with `fills`    → image fill set (if imageMap has bytes for that ref)
//
// Component swap: prefix the layer name with `##` instead of `#`
//   Layer name: ##column.rowindex   (on an INSTANCE)
//   The row value is matched against local component names (case-insensitive,
//   with and without "Variant=…" suffix). If a component matches, the instance
//   is swapped to point at it.

figma.showUI(__html__, { width: 440, height: 580, title: 'Smartico Bridge' });

// ── Selection broadcast ──────────────────────────────────────────────────────
// Push the current selection up to the UI. The UI uses this both to render the
// "Figma selection" box and as a trigger to auto-scan refs whenever the user
// changes selection — no manual "↻ Scan" click needed.
function snapshotSelection() {
  var sel = figma.currentPage.selection;
  return sel.map(function(n) {
    return {
      id:         n.id,
      name:       n.name,
      type:       n.type,
      childCount: 'children' in n ? n.children.length : 0,
    };
  });
}

function postSelection() {
  figma.ui.postMessage({ type: 'selection', nodes: snapshotSelection() });
}

// Fire whenever the user picks a different layer/frame. The UI debounces these
// and turns them into auto-scans.
figma.on('selectionchange', postSelection);

// ── Helpers ──────────────────────────────────────────────────────────────────

var REF_PATTERN = /^#{1,2}([a-zA-Z0-9_]+)\.(\d+)$/;
// ## prefix = component swap, single # = text/image/variant (default behaviour)
var FRAMEY_TYPES = { FRAME: 1, COMPONENT: 1, COMPONENT_SET: 1, INSTANCE: 1, SECTION: 1, GROUP: 1 };

function walk(node, visitor) {
  visitor(node);
  if ('children' in node) {
    for (var i = 0; i < node.children.length; i++) {
      walk(node.children[i], visitor);
    }
  }
}

// Find the nearest frame-like ancestor (or self) for a ref node. Walking stops
// at the rootNode so a ref lives in, at worst, the selection item it was found
// under. Gives designers a meaningful grouping when they select a big canvas
// with many frames of refs inside.
function findContainingFrame(node, rootNode) {
  var current = node;
  while (current) {
    if (FRAMEY_TYPES[current.type]) return current;
    if (rootNode && current.id === rootNode.id) return current;
    current = current.parent;
  }
  return rootNode || node;
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

  // ── scan-refs: walk selection, collect refs grouped by containing frame ───
  if (msg.type === 'scan-refs') {
    var sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'scan-result', ok: false, error: 'Nothing selected in Figma. Select a frame or group first.' });
      return;
    }

    // groupsById preserves insertion order; frameOrder keeps stable rendering.
    var groupsById = {};
    var frameOrder = [];
    var refsFound  = {};

    for (var s = 0; s < sel.length; s++) {
      var root = sel[s];
      (function(rootNode) {
        walk(rootNode, function(n) {
          var m = n.name.match(REF_PATTERN);
          if (!m) return;
          // The flat key stays as "col.idx" (no # prefix) — that's the form
          // the UI already indexes by and the inject-refs handler rebuilds.
          // Variant/swap kind is reconstructed per-node at inject time.
          var key = m[1].toLowerCase() + '.' + m[2];
          refsFound[key] = true;

          var frame = findContainingFrame(n, rootNode);
          var gid = frame.id;
          if (!groupsById[gid]) {
            groupsById[gid] = { frameId: gid, frameName: frame.name, frameType: frame.type, refs: [] };
            frameOrder.push(gid);
          }
          var alreadyInGroup = false;
          for (var r = 0; r < groupsById[gid].refs.length; r++) {
            if (groupsById[gid].refs[r] === key) { alreadyInGroup = true; break; }
          }
          if (!alreadyInGroup) groupsById[gid].refs.push(key);
        });
      })(root);
    }

    var groups = [];
    for (var g = 0; g < frameOrder.length; g++) groups.push(groupsById[frameOrder[g]]);

    figma.ui.postMessage({
      type:   'scan-result',
      ok:     true,
      refs:   Object.keys(refsFound),  // flat list retained for backwards compat
      groups: groups,                  // new per-frame grouping for the UI
    });
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
        // REF_PATTERN captures:  m2[1] = column name, m2[2] = 1-based row
        // Prefix is read directly from the node name: `##` → swap, else default.
        var isSwap = n.name.indexOf('##') === 0;
        var key    = m2[1].toLowerCase() + '.' + m2[2];
        var colName = m2[1];

        // Component swap: only valid on INSTANCE nodes. Swap resolved at inject
        // time (async) — we queue and run it below.
        if (isSwap) {
          if (n.type === 'INSTANCE' && (key in values)) {
            pending.push({ node: n, key: key, type: 'swap', column: colName });
          }
          return;
        }

        // Variant set on INSTANCE: if the instance exposes a variant property
        // whose name matches the column (case-insensitive), prefer that over
        // text/image behaviour.
        if (n.type === 'INSTANCE' && (key in values)) {
          var vp = n.variantProperties || null;
          if (vp) {
            var matchedProp = null;
            for (var pk in vp) {
              if (Object.prototype.hasOwnProperty.call(vp, pk) && pk.toLowerCase() === colName.toLowerCase()) {
                matchedProp = pk;
                break;
              }
            }
            if (matchedProp) {
              pending.push({ node: n, key: key, type: 'variant', propName: matchedProp });
              return;
            }
          }
        }

        if (n.type === 'TEXT' && (key in values)) {
          pending.push({ node: n, key: key, type: 'text' });
          return;
        }
        if ('fills' in n && (key in imageMap)) {
          pending.push({ node: n, key: key, type: 'image' });
        }
      });
    }

    // Build a local-component lookup once if any swap is queued. findAll can be
    // heavyish on very large documents, so we only do it when needed.
    var componentIndex = null;
    function buildComponentIndex() {
      if (componentIndex) return componentIndex;
      componentIndex = { byLowerName: {}, byLastSegment: {} };
      try {
        var comps = figma.root.findAllWithCriteria({ types: ['COMPONENT'] });
        for (var i = 0; i < comps.length; i++) {
          var c = comps[i];
          var nm = String(c.name || '');
          var low = nm.toLowerCase();
          componentIndex.byLowerName[low] = c;
          // Variant components tend to be named "Variant=Value"; also index by the value side.
          var eqIdx = nm.indexOf('=');
          if (eqIdx !== -1) {
            var tail = nm.slice(eqIdx + 1).trim().toLowerCase();
            if (tail && !componentIndex.byLastSegment[tail]) componentIndex.byLastSegment[tail] = c;
          }
        }
      } catch (e) { /* older doc APIs — leave index empty */ }
      return componentIndex;
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
        } else if (item.type === 'variant') {
          var raw = values[item.key];
          var asStr = (raw === null || raw === undefined) ? '' : String(raw);
          var props = {};
          props[item.propName] = asStr;
          try {
            item.node.setProperties(props);
            count++;
          } catch (setErr) {
            errors.push(item.node.name + ': variant "' + asStr + '" not available (' + setErr.message + ')');
          }
        } else if (item.type === 'swap') {
          var target = String(values[item.key] === null || values[item.key] === undefined ? '' : values[item.key]);
          if (!target) {
            errors.push(item.node.name + ': swap value is empty');
            continue;
          }
          var idx = buildComponentIndex();
          var lookup = target.toLowerCase();
          var comp = idx.byLowerName[lookup] || idx.byLastSegment[lookup] || null;
          if (!comp) {
            errors.push(item.node.name + ': no local component named "' + target + '"');
            continue;
          }
          item.node.swapComponent(comp);
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
  // Still supported for the initial UI load — the UI calls this once on
  // startup. After that the figma.on('selectionchange') hook above keeps the
  // UI in sync without polling.
  if (msg.type === 'get-selection') {
    postSelection();
    return;
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};
