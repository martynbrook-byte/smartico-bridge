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

        // INSTANCE with a single # prefix: smart component/variant replacement.
        //
        // Strategy (in priority order):
        //  1. Find a sibling variant in the same COMPONENT_SET whose name or
        //     variant value matches the cell value → swapComponent (most reliable).
        //  2. Find any local component whose name matches the cell value →
        //     swapComponent (cross-set replacement).
        //  3. Fall back to setProperties if a matching variant property exists
        //     (legacy behaviour — kept for backward compatibility).
        //
        // This replaces the old "setProperties only" approach which failed when
        // the variant value string didn't match a property option exactly.
        if (n.type === 'INSTANCE' && (key in values)) {
          pending.push({ node: n, key: key, type: 'smart-instance', column: colName });
          return;
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
        } else if (item.type === 'smart-instance') {
          // Smart instance replacement: try sibling variant → global component →
          // variant property setProperties (legacy).
          var rawVal2 = String(values[item.key] !== null && values[item.key] !== undefined ? values[item.key] : '');
          if (!rawVal2) { count++; continue; } // empty value — leave as-is
          var lowerVal = rawVal2.toLowerCase();
          var swapped = false;

          // 1. Sibling variant in the same COMPONENT_SET
          try {
            var mainComp = item.node.mainComponent;
            if (mainComp && mainComp.parent && mainComp.parent.type === 'COMPONENT_SET') {
              var siblings = mainComp.parent.children;
              for (var si = 0; si < siblings.length; si++) {
                var sib = siblings[si];
                if (sib.type !== 'COMPONENT') continue;
                var sibName = String(sib.name || '').toLowerCase();
                // Full name match
                if (sibName === lowerVal) { item.node.swapComponent(sib); swapped = true; break; }
                // Match the value side of "Property=Value" pairs (handles multi-property names too)
                var parts2 = sib.name.split(',');
                for (var pi = 0; pi < parts2.length; pi++) {
                  var eq = parts2[pi].indexOf('=');
                  if (eq !== -1) {
                    var segVal = parts2[pi].slice(eq + 1).trim().toLowerCase();
                    if (segVal === lowerVal) { item.node.swapComponent(sib); swapped = true; break; }
                  }
                }
                if (swapped) break;
              }
            }
          } catch (_sibErr) { /* ignore — fall through */ }

          // 2. Global component lookup by name
          if (!swapped) {
            try {
              var cidx = buildComponentIndex();
              var gComp = cidx.byLowerName[lowerVal] || cidx.byLastSegment[lowerVal] || null;
              if (gComp) { item.node.swapComponent(gComp); swapped = true; }
            } catch (_gErr) { /* ignore */ }
          }

          // 3. Fallback: variant property setProperties (legacy)
          if (!swapped) {
            try {
              var vp2 = item.node.variantProperties || null;
              if (vp2) {
                var matchedProp2 = null;
                for (var pk2 in vp2) {
                  if (Object.prototype.hasOwnProperty.call(vp2, pk2) && pk2.toLowerCase() === item.column.toLowerCase()) {
                    matchedProp2 = pk2; break;
                  }
                }
                if (matchedProp2) {
                  var props2 = {};
                  props2[matchedProp2] = rawVal2;
                  item.node.setProperties(props2);
                  swapped = true;
                }
              }
            } catch (_vpErr) {
              errors.push(item.node.name + ': setProperties failed — ' + _vpErr.message);
            }
          }

          if (swapped) { count++; }
          else { errors.push(item.node.name + ': no variant or component matched "' + rawVal2 + '"'); }

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

  // ── rename-node: rename a layer to a #col.row binding ref ────────────────
  // msg.nodeId:  Figma node ID (string)
  // msg.newName: the new layer name, e.g. '#prize.1'
  if (msg.type === 'rename-node') {
    try {
      var target = figma.getNodeById(msg.nodeId);
      if (!target) {
        figma.ui.postMessage({ type: 'rename-result', ok: false, error: 'Layer not found — was it deleted?' });
        return;
      }
      if (!('name' in target)) {
        figma.ui.postMessage({ type: 'rename-result', ok: false, error: 'This node type cannot be renamed.' });
        return;
      }
      target.name = msg.newName;
      figma.ui.postMessage({ type: 'rename-result', ok: true, newName: msg.newName });
    } catch (renameErr) {
      figma.ui.postMessage({ type: 'rename-result', ok: false, error: renameErr.message });
    }
    return;
  }

  // ── create-row-elements: build a frame of named text/image nodes ──────────
  // msg.columns:  [{ name, value, isImage }]
  // msg.imageMap: { 'colname.rowindex': [byte array] }
  // msg.rowIndex: number (1-based)
  // msg.label:    string — used as the container frame name
  if (msg.type === 'create-row-elements') {
    var columns  = msg.columns  || [];
    var imageMap = msg.imageMap || {};
    var rowIndex = msg.rowIndex || 1;
    var label    = msg.label    || ('Row ' + rowIndex);

    if (!columns.length) {
      figma.ui.postMessage({ type: 'create-elements-result', ok: false, error: 'No columns to create.' });
      return;
    }

    // Pre-load a reliable font so all text nodes render correctly.
    var fontOk = false;
    var fontRef = { family: 'Inter', style: 'Regular' };
    try {
      await figma.loadFontAsync(fontRef);
      fontOk = true;
    } catch (_fe) {
      try { fontRef = { family: 'Roboto', style: 'Regular' }; await figma.loadFontAsync(fontRef); fontOk = true; } catch (_) {}
    }

    // Container: horizontal auto-layout frame — columns flow left-to-right.
    var frame = figma.createFrame();
    frame.name                    = label;
    frame.layoutMode              = 'HORIZONTAL';
    frame.primaryAxisSizingMode   = 'AUTO';   // width:  hug children
    frame.counterAxisSizingMode   = 'AUTO';   // height: hug children
    frame.counterAxisAlignItems   = 'CENTER'; // vertically centre images & text
    frame.primaryAxisAlignItems   = 'MIN';
    frame.itemSpacing             = 16;
    frame.paddingTop = frame.paddingBottom = 16;
    frame.paddingLeft = frame.paddingRight = 20;
    frame.fills                   = [];       // transparent background

    var created = 0;
    var errors  = [];

    for (var ci = 0; ci < columns.length; ci++) {
      var col      = columns[ci];
      var safeName = String(col.name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
      var nodeKey  = safeName + '.' + rowIndex;
      var imgBytes = imageMap[nodeKey] || null;
      var nodeCreated = false;

      // ── Image ──
      if (imgBytes) {
        try {
          var imgNode = figma.createImage(new Uint8Array(imgBytes));
          var rect    = figma.createRectangle();
          rect.name   = '#' + nodeKey;
          rect.resize(80, 80);
          rect.fills  = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: imgNode.hash }];
          // Circular clip for avatar columns
          if (col.name.toLowerCase().indexOf('avatar') !== -1) {
            rect.cornerRadius = 40;
          }
          frame.appendChild(rect);
          nodeCreated = true;
          created++;
        } catch (imgErr) {
          errors.push(nodeKey + ': image failed – ' + imgErr.message);
          imgBytes = null; // fall through to text
        }
      }

      // ── Text (or fallback when image creation failed) ──
      if (!nodeCreated) {
        try {
          var txt = figma.createText();
          txt.name = '#' + nodeKey;
          if (fontOk) {
            txt.fontName   = fontRef;
            txt.fontSize   = 14;
            txt.characters = String(col.value !== null && col.value !== undefined ? col.value : '');
          }
          frame.appendChild(txt);
          created++;
        } catch (txtErr) {
          errors.push(nodeKey + ': text failed – ' + txtErr.message);
        }
      }
    }

    // Place the frame at the centre of the visible viewport.
    figma.currentPage.appendChild(frame);
    var vc = figma.viewport.center;
    frame.x = Math.round(vc.x - frame.width  / 2);
    frame.y = Math.round(vc.y - frame.height / 2);

    figma.currentPage.selection = [frame];
    figma.viewport.scrollAndZoomIntoView([frame]);

    figma.ui.postMessage({
      type:   'create-elements-result',
      ok:     true,
      count:  created,
      errors: errors,
    });
    return;
  }

  // ── save-asset: serialise the current selection into a portable tree ─────
  if (msg.type === 'save-asset') {
    var sel = figma.currentPage.selection;
    if (!sel.length) {
      figma.ui.postMessage({ type: 'save-asset-result', ok: false, error: 'Nothing selected' });
      return;
    }

    function safeJson(v) { try { return JSON.parse(JSON.stringify(v)); } catch(_) { return null; } }

    function serializeNode(node) {
      var out = { type: node.type, name: node.name };

      // ── Geometry ──────────────────────────────────────────────────────────
      try { out.x = node.x; out.y = node.y; } catch(_) {}
      try { out.width  = node.width;  } catch(_) {}
      try { out.height = node.height; } catch(_) {}
      try { out.rotation = node.rotation; } catch(_) {}

      // ── Visibility & blend ────────────────────────────────────────────────
      try { out.visible   = node.visible;   } catch(_) {}
      try { out.opacity   = node.opacity;   } catch(_) {}
      try { out.blendMode = node.blendMode; } catch(_) {}
      try { out.locked    = node.locked;    } catch(_) {}

      // ── Fills, strokes, effects ───────────────────────────────────────────
      try { out.fills = safeJson(node.fills) || []; } catch(_) {}
      try { out.strokes = safeJson(node.strokes) || []; } catch(_) {}
      try { out.strokeWeight = node.strokeWeight; } catch(_) {}
      try { out.strokeAlign  = node.strokeAlign;  } catch(_) {}
      try { out.strokeCap    = node.strokeCap;    } catch(_) {}
      try { out.strokeJoin   = node.strokeJoin;   } catch(_) {}
      try { out.dashPattern  = safeJson(node.dashPattern); } catch(_) {}
      try { out.effects = safeJson(node.effects) || []; } catch(_) {}

      // ── Corner radius ─────────────────────────────────────────────────────
      try {
        if (typeof node.cornerRadius === 'number') {
          out.cornerRadius = node.cornerRadius;
        } else {
          // Mixed — store all four corners
          out.topLeftRadius     = node.topLeftRadius;
          out.topRightRadius    = node.topRightRadius;
          out.bottomLeftRadius  = node.bottomLeftRadius;
          out.bottomRightRadius = node.bottomRightRadius;
        }
      } catch(_) {}

      // ── Constraints ───────────────────────────────────────────────────────
      try { out.constraints = { horizontal: node.constraints.horizontal, vertical: node.constraints.vertical }; } catch(_) {}

      // ── Auto-layout (frames) ──────────────────────────────────────────────
      if ('layoutMode' in node) {
        try {
          out.layoutMode             = node.layoutMode;
          out.itemSpacing            = node.itemSpacing;
          out.paddingTop             = node.paddingTop;
          out.paddingBottom          = node.paddingBottom;
          out.paddingLeft            = node.paddingLeft;
          out.paddingRight           = node.paddingRight;
          out.primaryAxisSizingMode  = node.primaryAxisSizingMode;
          out.counterAxisSizingMode  = node.counterAxisSizingMode;
          out.primaryAxisAlignItems  = node.primaryAxisAlignItems;
          out.counterAxisAlignItems  = node.counterAxisAlignItems;
          out.layoutWrap             = node.layoutWrap;
          out.clipsContent           = node.clipsContent;
        } catch(_) {}
      }

      // ── Shape-specific ────────────────────────────────────────────────────
      if (node.type === 'POLYGON' || node.type === 'STAR') {
        try { out.pointCount = node.pointCount; } catch(_) {}
      }
      if (node.type === 'STAR') {
        try { out.innerRadius = node.innerRadius; } catch(_) {}
      }
      if (node.type === 'VECTOR') {
        try { out.vectorPaths = safeJson(node.vectorPaths); } catch(_) {}
        try { out.vectorNetwork = safeJson(node.vectorNetwork); } catch(_) {}
      }
      if (node.type === 'BOOLEAN_OPERATION') {
        try { out.booleanOperation = node.booleanOperation; } catch(_) {}
      }

      // ── Component instance ────────────────────────────────────────────────
      // Store the component ID so restore can find and instantiate it if
      // the component still exists in this file.
      if (node.type === 'INSTANCE') {
        try {
          var mc = node.mainComponent;
          out.componentId   = mc ? mc.id   : null;
          out.componentName = mc ? mc.name : null;
        } catch(_) {}
      }

      // ── Text — full styled-segment capture ────────────────────────────────
      if (node.type === 'TEXT') {
        try { out.characters = node.characters || ''; } catch(_) {}
        try { out.textAlignHorizontal = node.textAlignHorizontal; } catch(_) {}
        try { out.textAlignVertical   = node.textAlignVertical;   } catch(_) {}
        try { out.textAutoResize      = node.textAutoResize;      } catch(_) {}
        try { out.paragraphSpacing    = node.paragraphSpacing;    } catch(_) {}

        // Capture styled segments — this preserves per-character font, size,
        // weight, colour, decoration, letter-spacing and line-height even when
        // they differ across the text node.
        try {
          var segs = node.getStyledTextSegments([
            'fontName', 'fontSize', 'fontWeight', 'fills',
            'textDecoration', 'textCase', 'letterSpacing', 'lineHeight',
          ]);
          out.textSegments = segs.map(function(s) {
            return {
              start:         s.start,
              end:           s.end,
              characters:    s.characters,
              fontName:      s.fontName  ? { family: s.fontName.family, style: s.fontName.style } : null,
              fontSize:      s.fontSize,
              fontWeight:    s.fontWeight,
              fills:         safeJson(s.fills) || [],
              textDecoration:s.textDecoration,
              textCase:      s.textCase,
              letterSpacing: safeJson(s.letterSpacing),
              lineHeight:    safeJson(s.lineHeight),
            };
          });
          // Also store the primary font/size for use as the node-level default
          if (segs.length > 0 && segs[0].fontName) {
            out.fontName = { family: segs[0].fontName.family, style: segs[0].fontName.style };
            out.fontSize = segs[0].fontSize;
          }
        } catch(_) {
          // Fallback: try reading the whole-node properties
          try {
            var fn = node.fontName;
            if (fn && typeof fn === 'object' && fn.family) {
              out.fontName = { family: fn.family, style: fn.style };
            }
          } catch(_) {}
          try {
            var fs = node.fontSize;
            if (typeof fs === 'number') out.fontSize = fs;
          } catch(_) {}
        }
      }

      // ── Children ──────────────────────────────────────────────────────────
      // Don't descend into INSTANCE children — we'll handle those at restore
      // time by creating a real instance from the component.
      if ('children' in node && node.type !== 'INSTANCE') {
        try {
          if (node.children.length) {
            out.children = [];
            for (var ci = 0; ci < node.children.length; ci++) {
              try { out.children.push(serializeNode(node.children[ci])); } catch(_) {}
            }
          }
        } catch(_) {}
      }

      return out;
    }

    var nodes = [];
    var serErrors = [];
    for (var si = 0; si < sel.length; si++) {
      try { nodes.push(serializeNode(sel[si])); } catch(se) { serErrors.push(se.message); }
    }

    if (!nodes.length) {
      figma.ui.postMessage({ type: 'save-asset-result', ok: false,
        error: 'Could not serialise any node' + (serErrors.length ? ': ' + serErrors[0] : '') });
      return;
    }

    var assetName = sel.length === 1 ? sel[0].name : 'Selection (' + sel.length + ' nodes)';
    try {
      figma.ui.postMessage({ type: 'save-asset-result', ok: true,
        name: assetName, assetType: sel.length === 1 ? sel[0].type : 'GROUP',
        nodeCount: nodes.length, nodes: nodes });
    } catch (pmErr) {
      figma.ui.postMessage({ type: 'save-asset-result', ok: false,
        error: 'Payload too large for postMessage — select fewer/simpler nodes (' + pmErr.message + ')' });
    }
    return;
  }

  // ── restore-asset: rebuild a serialised node tree onto the canvas ──────────
  if (msg.type === 'restore-asset') {
    var tree = msg.nodes || [];
    if (!tree.length) {
      figma.ui.postMessage({ type: 'restore-asset-result', ok: false, error: 'No node data' });
      return;
    }

    // Collect every unique font referenced in the tree (including segments)
    // so we can pre-load them all before touching any text node.
    var fontMap = {};
    function collectFonts(nodes) {
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.type === 'TEXT') {
          if (n.textSegments) {
            for (var si2 = 0; si2 < n.textSegments.length; si2++) {
              var sf = n.textSegments[si2].fontName;
              if (sf && sf.family) fontMap[sf.family + '::' + sf.style] = sf;
            }
          }
          if (n.fontName && n.fontName.family) fontMap[n.fontName.family + '::' + n.fontName.style] = n.fontName;
        }
        if (n.children) collectFonts(n.children);
      }
    }
    collectFonts(tree);

    // Always pre-load a fallback font
    var fallbackFont = { family: 'Inter', style: 'Regular' };
    try { await figma.loadFontAsync(fallbackFont); } catch(_) {
      try { fallbackFont = { family: 'Roboto', style: 'Regular' }; await figma.loadFontAsync(fallbackFont); } catch(_) {}
    }
    var fontKeys = Object.keys(fontMap);
    for (var fki = 0; fki < fontKeys.length; fki++) {
      try { await figma.loadFontAsync(fontMap[fontKeys[fki]]); } catch(_) {}
    }

    var restoreErrors = [];

    async function restoreNode(def, parent) {
      var node;
      try {
        // ── Create the right node type ────────────────────────────────────
        if (def.type === 'INSTANCE' && def.componentId) {
          try {
            var master = figma.getNodeById(def.componentId);
            if (master && master.type === 'COMPONENT') {
              node = master.createInstance();
            }
          } catch(_) {}
        }
        if (!node) {
          if (def.type === 'FRAME' || def.type === 'COMPONENT' || def.type === 'COMPONENT_SET' || def.type === 'INSTANCE') {
            node = figma.createFrame();
          } else if (def.type === 'GROUP') {
            // Groups need at least one child; create a frame as a stand-in
            node = figma.createFrame();
          } else if (def.type === 'TEXT') {
            node = figma.createText();
          } else if (def.type === 'RECTANGLE') {
            node = figma.createRectangle();
          } else if (def.type === 'ELLIPSE') {
            node = figma.createEllipse();
          } else if (def.type === 'POLYGON') {
            node = figma.createPolygon();
          } else if (def.type === 'STAR') {
            node = figma.createStar();
          } else if (def.type === 'LINE') {
            node = figma.createLine();
          } else if (def.type === 'VECTOR') {
            node = figma.createVector();
          } else if (def.type === 'BOOLEAN_OPERATION') {
            node = figma.createFrame(); // visual approximation
          } else {
            node = figma.createFrame();
          }
        }

        node.name = def.name || 'Restored';

        // ── Append early so geometry/layout resolve relative to parent ─────
        if (parent) { parent.appendChild(node); } else { figma.currentPage.appendChild(node); }

        // ── Size (before layout so children can fill correctly) ───────────
        if (def.type !== 'TEXT' && def.type !== 'LINE' && def.width > 0 && def.height > 0) {
          try { node.resize(def.width, def.height); } catch(_) {}
        }

        // ── Visual ────────────────────────────────────────────────────────
        if (def.fills   != null && 'fills'   in node) { try { node.fills   = def.fills;   } catch(_) {} }
        if (def.strokes != null && 'strokes' in node) { try { node.strokes = def.strokes; } catch(_) {} }
        if (def.strokeWeight != null && 'strokeWeight' in node) { try { node.strokeWeight = def.strokeWeight; } catch(_) {} }
        if (def.strokeAlign  != null && 'strokeAlign'  in node) { try { node.strokeAlign  = def.strokeAlign;  } catch(_) {} }
        if (def.effects != null && 'effects' in node && def.effects.length) { try { node.effects = def.effects; } catch(_) {} }
        if (typeof def.opacity   === 'number' && 'opacity'   in node) { try { node.opacity   = def.opacity;   } catch(_) {} }
        if (typeof def.blendMode === 'string' && 'blendMode' in node) { try { node.blendMode = def.blendMode; } catch(_) {} }
        if (def.visible === false && 'visible' in node)                { try { node.visible   = false;         } catch(_) {} }

        // ── Corner radius ─────────────────────────────────────────────────
        if (typeof def.cornerRadius === 'number' && 'cornerRadius' in node) {
          try { node.cornerRadius = def.cornerRadius; } catch(_) {}
        } else if (def.topLeftRadius != null && 'topLeftRadius' in node) {
          try {
            node.topLeftRadius     = def.topLeftRadius     || 0;
            node.topRightRadius    = def.topRightRadius    || 0;
            node.bottomLeftRadius  = def.bottomLeftRadius  || 0;
            node.bottomRightRadius = def.bottomRightRadius || 0;
          } catch(_) {}
        }

        // ── Auto-layout ───────────────────────────────────────────────────
        if (def.layoutMode && def.layoutMode !== 'NONE' && 'layoutMode' in node) {
          try {
            node.layoutMode = def.layoutMode;
            if (def.itemSpacing    != null) node.itemSpacing    = def.itemSpacing;
            if (def.paddingTop     != null) node.paddingTop     = def.paddingTop;
            if (def.paddingBottom  != null) node.paddingBottom  = def.paddingBottom;
            if (def.paddingLeft    != null) node.paddingLeft    = def.paddingLeft;
            if (def.paddingRight   != null) node.paddingRight   = def.paddingRight;
            if (def.primaryAxisSizingMode)  node.primaryAxisSizingMode  = def.primaryAxisSizingMode;
            if (def.counterAxisSizingMode)  node.counterAxisSizingMode  = def.counterAxisSizingMode;
            if (def.primaryAxisAlignItems)  node.primaryAxisAlignItems  = def.primaryAxisAlignItems;
            if (def.counterAxisAlignItems)  node.counterAxisAlignItems  = def.counterAxisAlignItems;
          } catch(_) {}
        }

        // ── Shape-specific ────────────────────────────────────────────────
        if ((def.type === 'POLYGON' || def.type === 'STAR') && def.pointCount) {
          try { node.pointCount = def.pointCount; } catch(_) {}
        }
        if (def.type === 'STAR' && def.innerRadius != null) {
          try { node.innerRadius = def.innerRadius; } catch(_) {}
        }
        if (def.type === 'VECTOR' && def.vectorPaths && def.vectorPaths.length) {
          try { node.vectorPaths = def.vectorPaths; } catch(_) {}
        }

        // ── Text ──────────────────────────────────────────────────────────
        if (def.type === 'TEXT') {
          // Determine the primary font (first segment's or node-level fallback)
          var primaryFont = (def.fontName && def.fontName.family) ? def.fontName : fallbackFont;
          var primarySize = (typeof def.fontSize === 'number' && def.fontSize > 0) ? def.fontSize : 14;

          // Must set font BEFORE characters
          try { node.fontName = primaryFont; } catch(_) { try { node.fontName = fallbackFont; } catch(_) {} }
          try { node.fontSize = primarySize; } catch(_) {}
          try { node.characters = def.characters || ''; } catch(_) {}

          // Apply per-segment styling when the text has mixed fonts/sizes
          if (def.textSegments && def.textSegments.length > 1) {
            for (var sgi = 0; sgi < def.textSegments.length; sgi++) {
              var seg = def.textSegments[sgi];
              if (seg.start >= seg.end) continue;
              try {
                if (seg.fontName && seg.fontName.family) {
                  node.setRangeFontName(seg.start, seg.end, seg.fontName);
                }
              } catch(_) {}
              try {
                if (typeof seg.fontSize === 'number' && seg.fontSize > 0) {
                  node.setRangeFontSize(seg.start, seg.end, seg.fontSize);
                }
              } catch(_) {}
              try {
                if (seg.fills && seg.fills.length) {
                  node.setRangeFills(seg.start, seg.end, seg.fills);
                }
              } catch(_) {}
              try {
                if (seg.letterSpacing) node.setRangeLetterSpacing(seg.start, seg.end, seg.letterSpacing);
              } catch(_) {}
              try {
                if (seg.lineHeight) node.setRangeLineHeight(seg.start, seg.end, seg.lineHeight);
              } catch(_) {}
              try {
                if (seg.textDecoration) node.setRangeTextDecoration(seg.start, seg.end, seg.textDecoration);
              } catch(_) {}
              try {
                if (seg.textCase) node.setRangeTextCase(seg.start, seg.end, seg.textCase);
              } catch(_) {}
            }
          }

          try { if (def.textAlignHorizontal) node.textAlignHorizontal = def.textAlignHorizontal; } catch(_) {}
          try { if (def.textAlignVertical)   node.textAlignVertical   = def.textAlignVertical;   } catch(_) {}
          try { if (def.textAutoResize)      node.textAutoResize      = def.textAutoResize;      } catch(_) {}
        }

        // ── Children (skip for INSTANCE — the component handles its own children) ──
        if (def.children && def.children.length && 'children' in node && node.type !== 'INSTANCE') {
          for (var ci = 0; ci < def.children.length; ci++) {
            await restoreNode(def.children[ci], node);
          }
        }

        // ── Position (after children so auto-layout has sized the frame) ──
        try { if (typeof def.x === 'number') node.x = def.x; } catch(_) {}
        try { if (typeof def.y === 'number') node.y = def.y; } catch(_) {}

      } catch (re) {
        restoreErrors.push((def.name || '?') + ': ' + re.message);
      }
      return node;
    }

    var restored = [];
    var vc = figma.viewport.center;
    for (var ri = 0; ri < tree.length; ri++) {
      var rn = await restoreNode(tree[ri], null);
      if (rn) {
        try { rn.x = Math.round(vc.x) + ri * 24; rn.y = Math.round(vc.y) + ri * 24; } catch(_) {}
        restored.push(rn);
      }
    }

    if (restored.length) {
      figma.currentPage.selection = restored;
      figma.viewport.scrollAndZoomIntoView(restored);
    }

    figma.ui.postMessage({ type: 'restore-asset-result', ok: true,
      count: restored.length, errors: restoreErrors });
    return;
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};
