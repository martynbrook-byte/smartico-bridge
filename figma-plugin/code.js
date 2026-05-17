// code.js — Smartico Bridge Figma Plugin (sandbox)
// Runs inside Figma's sandboxed JS environment — no fetch, no modern syntax (no ??, no ?.)
//
// Injection convention:
//   Layer name: #columnname.rowindex   (1-based, case-insensitive column match)
//   Examples:   #prize.1   #avatar.2   #profile_name.3   #phone.1
//
// Behaviour by node type:
//   TEXT                     → value written as characters
//                              EXCEPTION: if the cell value is an image URL the
//                              plugin UI auto-detects it, fetches bytes, and the
//                              TEXT node receives an image fill instead of text.
//   INSTANCE (component)     → if a variant property matches the column name
//                              (case-insensitive) and the row value is a valid
//                              option, set that variant. Otherwise falls through
//                              to image fill (if applicable).
//   Any node with `fills`    → image fill set (if imageMap has bytes for that ref)
//
// Image URL auto-detection (in ui.html):
//   Any cell value starting with "http" whose URL path ends in a known image
//   extension (.jpg .png .gif .webp .svg .bmp .ico .avif .tiff) is treated as
//   an image URL. Columns whose name contains "image", "img", "photo", "pic",
//   "avatar", "logo", "banner", "thumb", or "icon" are also auto-detected even
//   for CDN/signed URLs that lack file extensions.
//
// Component swap: prefix the layer name with `##` instead of `#`
//   Layer name: ##column.rowindex   (on an INSTANCE)
//   The row value is matched against local component names (case-insensitive,
//   with and without "Variant=…" suffix). If a component matches, the instance
//   is swapped to point at it.

figma.showUI(__html__, { width: 440, height: 640, title: 'Smartico Bridge' });

// ── Selection broadcast ───────────────────────────────────────────────────────
// expandSections: when a SECTION node is selected, substitute its direct frame
// children so panels (Optimiser, Artworker, Animator) see the frames inside.
function expandSections(nodes) {
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.type === 'SECTION' && 'children' in n && n.children.length) {
      for (var j = 0; j < n.children.length; j++) {
        out.push({ node: n.children[j], sectionName: n.name });
      }
    } else {
      out.push({ node: n, sectionName: null });
    }
  }
  return out;
}

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

figma.on('selectionchange', postSelection);

// ── Helpers ──────────────────────────────────────────────────────────────────

var REF_PATTERN = /^#{1,2}([a-zA-Z0-9_]+)\.(\d+)$/;
// ## prefix = component swap, single # = text/image/variant (default behaviour)
var FRAMEY_TYPES = { FRAME: 1, COMPONENT: 1, COMPONENT_SET: 1, INSTANCE: 1, SECTION: 1, GROUP: 1 };

// ── Component index cache ────────────────────────────────────────────────────
// Two caches: one per-page ('page' scope) and one for the full document.
// Each is invalidated when the active page changes.
var _compCachePage = null; // { pageId, index }
var _compCacheDoc  = null; // { pageId, index } — keyed on page too so stale on page switch

// ── Image injection batched state ────────────────────────────────────────────
// Images are fetched in batches of IMG_BATCH_SIZE to avoid postMessage size
// limits. code.js sends need-images for each batch, UI fetches and replies
// with inject-images, code.js applies fills and requests the next batch.
var IMG_BATCH_SIZE    = 25; // fetched concurrently in UI so larger batches are fine
var _imgPendingItems  = null; // ALL image items [{node, key, type:'image'}]
var _imgBatchedRefs   = null; // deduplicated [{key, url}] for all images
var _imgBatchOffset   = 0;    // index into _imgBatchedRefs of current batch start
var _imgApplied       = null; // {key: true} — keys already written (multi-node dedup)
var _imgPartialCount  = 0;
var _imgPartialErrors = [];
var _imgTotalItems    = 0;

function buildComponentIndex(scope) {
  // scope: 'page' (default, fast) | 'document' (full doc, slower)
  var useDoc = (scope === 'document');
  var pageId = figma.currentPage.id;

  // Return cached index if the page hasn't changed
  if (useDoc) {
    if (_compCacheDoc && _compCacheDoc.pageId === pageId) return _compCacheDoc.index;
  } else {
    if (_compCachePage && _compCachePage.pageId === pageId) return _compCachePage.index;
  }

  var index = { byLowerName: {}, byLastSegment: {} };
  try {
    var root  = useDoc ? figma.root : figma.currentPage;
    var comps = root.findAllWithCriteria({ types: ['COMPONENT'] });
    for (var i = 0; i < comps.length; i++) {
      var c   = comps[i];
      var nm  = String(c.name || '');
      var low = nm.toLowerCase();
      index.byLowerName[low] = c;
      var eqIdx = nm.indexOf('=');
      if (eqIdx !== -1) {
        var tail = nm.slice(eqIdx + 1).trim().toLowerCase();
        if (tail && !index.byLastSegment[tail]) index.byLastSegment[tail] = c;
      }
    }
  } catch (e) { /* older APIs — leave empty */ }

  if (useDoc) { _compCacheDoc  = { pageId: pageId, index: index }; }
  else        { _compCachePage = { pageId: pageId, index: index }; }
  return index;
}

// Check whether any variant property VALUE in a Figma component name matches
// targetLower. Figma separates multi-property names with ", " (comma-space),
// so values containing commas (e.g. "50,000 Cash") are never split incorrectly.
function variantValueMatches(compName, targetLower) {
  if (String(compName).toLowerCase() === targetLower) return true;
  var remaining = String(compName);
  while (remaining.length) {
    var eqIdx = remaining.indexOf('=');
    if (eqIdx === -1) break;
    var afterEq = remaining.slice(eqIdx + 1);
    // Next property segment starts at ", Letter" — the Figma convention
    var nextSep = afterEq.search(/, [A-Za-z_]/);
    var val = (nextSep !== -1 ? afterEq.slice(0, nextSep) : afterEq).trim();
    if (val.toLowerCase() === targetLower) return true;
    remaining = nextSep !== -1 ? afterEq.slice(nextSep + 2) : '';
  }
  return false;
}

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

var IMAGE_URL_RE = /\.(jpe?g|png|gif|webp|svg|bmp|ico|avif|tiff?)(\?[^)]*)?$/i;
var IMG_COL_RE   = /image|img|photo|pic|avatar|logo|banner|thumb|icon/i;
// key is optional: 'colname.rowindex' — column name is extracted and checked
// against IMG_COL_RE so CDN/signed URLs without extensions are still detected.
function looksLikeImageUrl(val, key) {
  if (typeof val !== 'string' || val.indexOf('http') !== 0) return false;
  // Check URL extension first
  try { if (IMAGE_URL_RE.test(new URL(val).pathname)) return true; } catch (_) {}
  // Fall back: check if the column name (prefix of key) is image-related
  if (key) {
    var dotIdx = String(key).lastIndexOf('.');
    var colPart = dotIdx > -1 ? key.slice(0, dotIdx) : key;
    if (IMG_COL_RE.test(colPart)) return true;
  }
  return false;
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

  // ── scan-refs / scan-page: find #name.index nodes ────────────────────────
  if (msg.type === 'scan-refs' || msg.type === 'scan-page') {
    var scanScope = msg.scope || 'page';
    var sel = figma.currentPage.selection;

    var groupsById = {};
    var frameOrder = [];
    var refsFound  = {};

    try {
      var candidates;

      if (msg.type === 'scan-refs' && sel.length) {
        // Selection provided — scan only selected nodes (fast path)
        candidates = [];
        for (var si = 0; si < sel.length; si++) {
          var selNode = sel[si];
          // Include the node itself if it matches
          if (REF_PATTERN.test(selNode.name)) candidates.push(selNode);
          // Then all TEXT + INSTANCE descendants only (the two types we actually write to)
          if ('findAllWithCriteria' in selNode) {
            var sub = selNode.findAllWithCriteria({ types: ['TEXT', 'INSTANCE'] });
            for (var sj = 0; sj < sub.length; sj++) candidates.push(sub[sj]);
          }
        }
      } else {
        // No selection — scan whole page/doc for TEXT + INSTANCE only
        // FRAME/RECT/ELLIPSE are included only when they have a direct REF name,
        // so we check top-level children names separately (cheap).
        var scanRoot = (scanScope === 'document') ? figma.root : figma.currentPage;
        candidates = scanRoot.findAllWithCriteria({ types: ['TEXT', 'INSTANCE'] });
        // Also check direct children of pages for named frames/rects
        var pageChildren = (scanScope === 'document')
          ? figma.root.children.reduce(function(a, pg) { return a.concat(Array.from(pg.children)); }, [])
          : Array.from(figma.currentPage.children);
        for (var pc = 0; pc < pageChildren.length; pc++) {
          if (REF_PATTERN.test(pageChildren[pc].name)) candidates.push(pageChildren[pc]);
        }
      }

      for (var ci = 0; ci < candidates.length; ci++) {
        var n = candidates[ci];
        var m = n.name.match(REF_PATTERN);
        if (!m) continue;
        var key = m[1].toLowerCase() + '.' + m[2];
        refsFound[key] = true;
        // Walk up to find the nearest top-level frame for grouping
        var frame = n;
        var p = n.parent;
        while (p && p.type !== 'PAGE' && p.type !== 'DOCUMENT') { frame = p; p = p.parent; }
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
      }
    } catch (scanErr) {
      figma.ui.postMessage({ type: 'scan-result', ok: false, error: 'Scan failed: ' + scanErr.message });
      return;
    }

    var groups = [];
    for (var g = 0; g < frameOrder.length; g++) groups.push(groupsById[frameOrder[g]]);

    figma.ui.postMessage({
      type:        'scan-result',
      ok:          true,
      refs:        Object.keys(refsFound),
      groups:      groups,
      autoScanned: msg.type === 'scan-page',
      scope:       scanScope,
    });
    return;
  }

  // ── inject-refs: write resolved values into matching #name.index nodes ────
  // msg.values:   { 'prize.1': 'Free Flight 20MT', 'profile_name.1': 'João', ... }
  // msg.imageMap: { 'avatar.1': [/* byte array */], ... }
  if (msg.type === 'inject-refs') {
   try {
    var values      = msg.values      || {};
    var imageMap    = msg.imageMap    || {};
    var searchScope = msg.searchScope || 'page'; // 'selection' | 'page' | 'document'
    var sel2        = figma.currentPage.selection;

    // Build inject roots based on explicit scope (not just whether selection exists)
    var injectRoots;
    if (searchScope === 'selection') {
      injectRoots = sel2.length ? Array.from(sel2) : Array.from(figma.currentPage.children);
    } else if (searchScope === 'document') {
      injectRoots = [];
      for (var pi = 0; pi < figma.root.children.length; pi++) {
        var pg = figma.root.children[pi];
        injectRoots = injectRoots.concat(Array.from(pg.children));
      }
    } else {
      // 'page' scope
      injectRoots = Array.from(figma.currentPage.children);
    }

    var errors    = [];
    var count     = 0;
    var pending   = [];

    // ── Collect matching nodes ─────────────────────────────────────────────
    // Use a SINGLE findAllWithCriteria call on the appropriate root whenever
    // possible. This is the biggest speed win: calling findAll once on
    // figma.currentPage is far faster than calling it once per top-level frame
    // (which can be 20+ calls on a busy page).
    //
    // RECTANGLE and ELLIPSE are included so designers can name a shape #avatar.1
    // and have it receive an image fill without needing a TEXT sibling.
    var INJECTABLE_TYPES2 = ['TEXT', 'INSTANCE', 'RECTANGLE', 'ELLIPSE'];
    var matchNodes = [];
    try {
      if (searchScope === 'selection' && sel2.length) {
        // Selection scope: one call per selected node (usually 1-3 items)
        for (var s2 = 0; s2 < injectRoots.length; s2++) {
          if ('findAllWithCriteria' in injectRoots[s2]) {
            var _sub = injectRoots[s2].findAllWithCriteria({ types: INJECTABLE_TYPES2 });
            for (var _si = 0; _si < _sub.length; _si++) {
              if (REF_PATTERN.test(_sub[_si].name)) matchNodes.push(_sub[_si]);
            }
          }
          // Include the root itself if it matches
          if (REF_PATTERN.test(injectRoots[s2].name)) matchNodes.push(injectRoots[s2]);
        }
      } else if (searchScope === 'document') {
        // Document scope: one call per page (still much fewer than per-frame)
        for (var _pi = 0; _pi < figma.root.children.length; _pi++) {
          var _pg = figma.root.children[_pi];
          var _sub2 = _pg.findAllWithCriteria({ types: INJECTABLE_TYPES2 });
          for (var _si2 = 0; _si2 < _sub2.length; _si2++) {
            if (REF_PATTERN.test(_sub2[_si2].name)) matchNodes.push(_sub2[_si2]);
          }
        }
      } else {
        // Page scope: single call — fastest path
        var _sub3 = figma.currentPage.findAllWithCriteria({ types: INJECTABLE_TYPES2 });
        for (var _si3 = 0; _si3 < _sub3.length; _si3++) {
          if (REF_PATTERN.test(_sub3[_si3].name)) matchNodes.push(_sub3[_si3]);
        }
      }
    } catch (_findErr) {
      // Fallback: manual walk if findAllWithCriteria is unavailable
      for (var _fr = 0; _fr < injectRoots.length; _fr++) {
        walk(injectRoots[_fr], function(n) {
          if (INJECTABLE_TYPES2.indexOf(n.type) !== -1 && REF_PATTERN.test(n.name)) matchNodes.push(n);
        });
      }
    }

    for (var ni = 0; ni < matchNodes.length; ni++) {
      var n = matchNodes[ni];
      var m2 = n.name.match(REF_PATTERN);
      if (!m2) continue;
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
        continue;
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
        continue;
      }

      // TEXT node: if the value is an image URL, find the best visual target
      // for the image fill. Applying a fill directly to a TEXT node clips the
      // image to the glyph shapes — not what anyone wants for an avatar.
      //
      // Detection rules (in priority order):
      //   1. If a sibling RECTANGLE or ELLIPSE exists AND value starts with "http"
      //      → route fill to the sibling regardless of URL format. The sibling
      //      is clearly the image container; the TEXT node is just the naming hook.
      //   2. No sibling shape but looksLikeImageUrl (extension OR image column name)
      //      → try parent frame, then fall back to the TEXT node itself.
      //   3. Otherwise → write as plain text.
      if (n.type === 'TEXT' && (key in values)) {
        var valStr = values[key] !== null && values[key] !== undefined ? String(values[key]) : '';
        var isUrl  = valStr.indexOf('http') === 0;
        var par    = n.parent;

        // Find sibling shape (RECTANGLE or ELLIPSE) in the same parent.
        // Also searches one level inside sibling FRAME/GROUP nodes to handle
        // the common "clip frame → nested rectangle" avatar pattern.
        var sibShape = null;
        if (isUrl && par && par.children) {
          for (var si = 0; si < par.children.length; si++) {
            var sib = par.children[si];
            if (sib === n) continue;
            // Direct RECTANGLE/ELLIPSE sibling
            if ((sib.type === 'RECTANGLE' || sib.type === 'ELLIPSE') && 'fills' in sib) {
              sibShape = sib;
              break;
            }
            // Sibling FRAME or GROUP — look one level inside for a shape
            if ((sib.type === 'FRAME' || sib.type === 'GROUP' || sib.type === 'COMPONENT' || sib.type === 'INSTANCE') && sib.children) {
              for (var si2 = 0; si2 < sib.children.length; si2++) {
                var inner = sib.children[si2];
                if ((inner.type === 'RECTANGLE' || inner.type === 'ELLIPSE') && 'fills' in inner) {
                  sibShape = inner;
                  break;
                }
              }
              if (sibShape) break;
            }
          }
        }

        var needsImage = (key in imageMap) || (isUrl && sibShape !== null) || looksLikeImageUrl(valStr, key);
        if (needsImage) {
          var imageTarget = null;
          if (sibShape) {
            // Sibling shape → always the preferred image target
            imageTarget = sibShape;
          } else if (par && 'fills' in par && par.type !== 'DOCUMENT' && par.type !== 'PAGE') {
            // Parent frame/component
            imageTarget = par;
          } else {
            // Last resort: the TEXT node itself
            imageTarget = n;
          }
          pending.push({ node: imageTarget, key: key, type: 'image' });
        } else {
          pending.push({ node: n, key: key, type: 'text' });
        }
        continue;
      }

      // RECTANGLE or ELLIPSE named with a ref pattern:
      // If the value is any HTTP URL → always treat as image fill.
      // A shape node has no meaningful use for URL text, so any http value
      // from the data is unambiguously an image reference.
      if ((n.type === 'RECTANGLE' || n.type === 'ELLIPSE') && 'fills' in n && (key in values)) {
        var valStr2 = values[key] !== null && values[key] !== undefined ? String(values[key]) : '';
        if ((key in imageMap) || valStr2.indexOf('http') === 0) {
          pending.push({ node: n, key: key, type: 'image' });
        }
      }
    } // end matchNodes loop

    // ── Pre-load all unique fonts in parallel ──────────────────────────────
    // Collecting fonts up front and awaiting them together is dramatically
    // faster than calling loadNodeFont() (one await per node) in the main loop.
    var fontSet = {};
    for (var fp = 0; fp < pending.length; fp++) {
      if (pending[fp].type !== 'text') continue;
      try {
        var tn   = pending[fp].node;
        var tlen = tn.characters ? tn.characters.length : 0;
        var font = tlen > 0 ? tn.getRangeFontName(0, tlen) : null;
        if (font && typeof font === 'object' && font.family) {
          fontSet[font.family + '::' + font.style] = { family: font.family, style: font.style };
        } else {
          fontSet['Inter::Regular'] = { family: 'Inter', style: 'Regular' };
        }
      } catch (_fe) {
        fontSet['Inter::Regular'] = { family: 'Inter', style: 'Regular' };
      }
    }
    var fontKeys = Object.keys(fontSet);
    if (fontKeys.length) {
      await Promise.all(fontKeys.map(function(fk) {
        return figma.loadFontAsync(fontSet[fk]).catch(function() {
          return figma.loadFontAsync({ family: 'Inter', style: 'Regular' }).catch(function() {});
        });
      }));
    }

    // ── Split: image items that need URL fetching vs everything else ──────────
    var imageItems = []; // nodes needing image fills (no bytes yet in imageMap)
    var otherItems = []; // text / instance / variant / swap / pre-loaded image
    for (var sp = 0; sp < pending.length; sp++) {
      if (pending[sp].type === 'image' && !(pending[sp].key in imageMap)) {
        imageItems.push(pending[sp]);
      } else {
        otherItems.push(pending[sp]);
      }
    }
    // Diagnostic — send counts + target node types back to UI
    figma.ui.postMessage({
      type: 'inject-debug',
      imageCount: imageItems.length,
      textCount:  otherItems.filter(function(i) { return i.type === 'text'; }).length,
      otherCount: otherItems.filter(function(i) { return i.type !== 'text'; }).length,
      imageKeys:  imageItems.slice(0, 5).map(function(i) {
        return i.key + ' → [' + i.node.type + ' "' + i.node.name + '"] ' + (values[i.key] || '').slice(0, 30);
      })
    });

    figma.ui.postMessage({ type: 'inject-progress', phase: 'inject', done: 0, total: pending.length });

    // Start timeout AFTER setup (scan + font loading can be slow on large files)
    var startTime  = Date.now();
    var TIMEOUT_MS = 30000; // 30 seconds covers actual write work

    for (var p = 0; p < otherItems.length; p++) {
      // Timeout guard — checked every 50 items to reduce Date.now() overhead
      if (p % 50 === 0 && Date.now() - startTime > TIMEOUT_MS) {
        errors.push('Timed out after 30s — ' + (otherItems.length - p) + ' item(s) skipped');
        break;
      }
      // Progress update every 25 items (fewer IPC round-trips)
      if (p % 25 === 0) {
        figma.ui.postMessage({ type: 'inject-progress', phase: 'inject', done: p, total: pending.length });
      }
      var item = otherItems[p];
      try {
        if (item.type === 'text') {
          // Font already loaded in the parallel pre-load step above
          item.node.characters = String(values[item.key] !== null && values[item.key] !== undefined ? values[item.key] : '');
          count++;
        } else if (item.type === 'image') {
          // imageMap already has bytes (pre-loaded path)
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
                if (variantValueMatches(sib.name, lowerVal)) {
                  item.node.swapComponent(sib);
                  swapped = true;
                  break;
                }
              }
            }
          } catch (_sibErr) { /* ignore — fall through */ }

          // 2. Global component lookup by name
          if (!swapped) {
            try {
              // Search chosen scope first, then always fall back to full document
              // so components on other pages (library pages etc.) are always found.
              var cidx = buildComponentIndex(searchScope);
              var gComp = cidx.byLowerName[lowerVal] || cidx.byLastSegment[lowerVal] || null;
              if (!gComp && searchScope !== 'document') {
                var cidxDoc = buildComponentIndex('document');
                gComp = cidxDoc.byLowerName[lowerVal] || cidxDoc.byLastSegment[lowerVal] || null;
              }
              if (gComp) { item.node.swapComponent(gComp); swapped = true; }
            } catch (_gErr) { /* ignore */ }
          }

          // 3. Fallback: variant property setProperties
          // Try the column-matched property first, then try every property.
          if (!swapped) {
            try {
              var vp2 = item.node.variantProperties || null;
              if (vp2) {
                // Find best matching property — column name match preferred
                var matchedProp2 = null;
                var anyProp2 = null;
                for (var pk2 in vp2) {
                  if (!Object.prototype.hasOwnProperty.call(vp2, pk2)) continue;
                  if (pk2.toLowerCase() === item.column.toLowerCase()) { matchedProp2 = pk2; break; }
                  if (!anyProp2) anyProp2 = pk2; // keep first as fallback
                }
                var useProp = matchedProp2 || anyProp2;
                if (useProp) {
                  var props2 = {};
                  props2[useProp] = rawVal2;
                  item.node.setProperties(props2);
                  swapped = true;
                }
              }
            } catch (_vpErr) { /* fall through to text-child fallback */ }
          }

          // 4. Text child fallback — value is probably a number/string that should
          //    be displayed as text inside the instance (e.g. #totals.5 = "9319").
          //    Find the first accessible TEXT descendant and set its characters.
          if (!swapped) {
            try {
              var textChild = null;
              walk(item.node, function(tn) {
                if (!textChild && tn.type === 'TEXT') textChild = tn;
              });
              if (textChild) {
                await loadNodeFont(textChild);
                textChild.characters = rawVal2;
                swapped = true;
              }
            } catch (_tcErr) { /* leave swapped false */ }
          }

          if (swapped) { count++; }
          else { errors.push(item.node.name + ': no variant or component matched "' + rawVal2 + '"'); }

        } else if (item.type === 'swap') {
          var target = String(values[item.key] === null || values[item.key] === undefined ? '' : values[item.key]);
          if (!target) {
            errors.push(item.node.name + ': swap value is empty');
            continue;
          }
          var idx = buildComponentIndex(searchScope);
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

    // ── Phase 2: ask UI to fetch image bytes for image nodes ─────────────────
    if (imageItems.length > 0) {
      // Deduplicate refs by key (multiple nodes can share the same image key)
      var seenImgKeys = {};
      var imageRefs   = [];
      for (var ir = 0; ir < imageItems.length; ir++) {
        var ik = imageItems[ir].key;
        if (!seenImgKeys[ik] && values[ik]) {
          seenImgKeys[ik] = true;
          imageRefs.push({ key: ik, url: values[ik] });
        }
      }
      // Store batched state
      _imgPendingItems  = imageItems;
      _imgBatchedRefs   = imageRefs;
      _imgBatchOffset   = 0;
      _imgApplied       = {};
      _imgPartialCount  = count;
      _imgPartialErrors = errors.slice();
      _imgTotalItems    = pending.length;
      // Send first batch only
      figma.ui.postMessage({
        type:       'need-images',
        refs:       imageRefs.slice(0, IMG_BATCH_SIZE),
        batchDone:  0,
        batchTotal: imageRefs.length,
        total:      pending.length
      });
      return; // inject-images handler drives remaining batches
    }

    figma.ui.postMessage({
      type:   'inject-result',
      ok:     true,
      count:  count,
      total:  pending.length,
      errors: errors,
    });
    return;
   } catch (_injectErr) {
     figma.ui.postMessage({ type: 'inject-result', ok: false, error: String(_injectErr && _injectErr.message ? _injectErr.message : _injectErr) });
     return;
   }
  }

  // ── inject-images: apply one batch of image fills, request next if needed ───
  if (msg.type === 'inject-images') {
    if (!_imgPendingItems) {
      figma.ui.postMessage({ type: 'inject-result', ok: false, error: 'No pending image state' });
      return;
    }
    var imageMap3 = msg.imageMap || {};

    // Apply fills for any node whose key is in this batch's imageMap.
    // Dedup by NODE ID (not key) so that multiple nodes sharing the same key
    // (e.g. duplicate leaderboard frames on the same page) all receive the fill.
    var _batchApplied = 0;
    for (var ii = 0; ii < _imgPendingItems.length; ii++) {
      var iitem = _imgPendingItems[ii];
      var _nodeId = iitem.node.id;
      if (_imgApplied[_nodeId]) continue; // already processed this exact node
      if (!(iitem.key in imageMap3)) continue; // not in this batch — will be handled by a later batch
      try {
        var _fillNode = iitem.node;
        // Safety: TEXT nodes cannot meaningfully show image fills (fill clips to glyph).
        if (_fillNode.type === 'TEXT') {
          _imgPartialErrors.push(iitem.key + ': no image container found near "' + _fillNode.name + '" — add a RECTANGLE or ELLIPSE sibling');
          _imgApplied[_nodeId] = true;
          continue;
        }
        _fillNode.fills = [createImageFill(imageMap3[iitem.key])];
        _batchApplied++;
        _imgPartialCount++;
        _imgApplied[_nodeId] = true;
      } catch (imgErr) {
        _imgPartialErrors.push(iitem.node.name + ' (' + iitem.key + '): ' + imgErr.message);
        _imgApplied[_nodeId] = true; // mark so we don't retry
      }
    }
    // Send diagnostic so UI console shows how many fills were applied this batch
    figma.ui.postMessage({ type: 'inject-img-applied', count: _batchApplied });

    // Advance batch cursor
    _imgBatchOffset += IMG_BATCH_SIZE;

    if (_imgBatchOffset < _imgBatchedRefs.length) {
      // More batches to go — request next slice
      var nextBatch = _imgBatchedRefs.slice(_imgBatchOffset, _imgBatchOffset + IMG_BATCH_SIZE);
      figma.ui.postMessage({
        type:       'need-images',
        refs:       nextBatch,
        batchDone:  _imgBatchOffset,
        batchTotal: _imgBatchedRefs.length,
        total:      _imgTotalItems
      });
      return;
    }

    // All batches done — report nodes that never received a fill.
    // _imgApplied is keyed by node ID (not by key) since the node-ID dedup fix.
    for (var im = 0; im < _imgPendingItems.length; im++) {
      var _imItem = _imgPendingItems[im];
      if (!_imgApplied[_imItem.node.id]) {
        _imgPartialErrors.push(_imItem.node.name + ' (' + _imItem.key + '): image not fetched');
      }
    }

    var finalCount  = _imgPartialCount;
    var finalErrors = _imgPartialErrors.slice();
    var finalTotal  = _imgTotalItems;

    _imgPendingItems  = null;
    _imgBatchedRefs   = null;
    _imgBatchOffset   = 0;
    _imgApplied       = null;
    _imgPartialCount  = 0;
    _imgPartialErrors = [];
    _imgTotalItems    = 0;

    figma.ui.postMessage({
      type:   'inject-result',
      ok:     true,
      count:  finalCount,
      total:  finalTotal,
      errors: finalErrors,
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

  if (msg.type === 'get-pages') {
    var pages = figma.root.children.map(function(p) { return { id: p.id, name: p.name }; });
    figma.ui.postMessage({ type: 'pages-result', pages: pages, currentPageId: figma.currentPage.id });
    return;
  }

  // ── clientStorage bridge: persist UI state across plugin sessions ──────────
  // Figma's clientStorage lives in the sandbox (code.js) — the UI iframe cannot
  // call it directly. These two message types bridge the gap.
  if (msg.type === 'storage-get') {
    figma.clientStorage.getAsync(msg.key).then(function(val) {
      figma.ui.postMessage({ type: 'storage-value', key: msg.key, value: val, reqId: msg.reqId });
    }).catch(function() {
      figma.ui.postMessage({ type: 'storage-value', key: msg.key, value: undefined, reqId: msg.reqId });
    });
    return;
  }
  if (msg.type === 'storage-set') {
    figma.clientStorage.setAsync(msg.key, msg.value).catch(function() {});
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
    frame.fills                   = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }]; // white background

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

    function serializeNode(node, _depth) {
      if (_depth === undefined) _depth = 0;
      var out = { type: node.type, name: node.name };

      // Store the node's own ID so that restore can find and clone the original
      // node if it still exists in this document (same-file save/restore workflow).
      try { out.id = node.id; } catch(_) {}

      // ── Geometry ──────────────────────────────────────────────────────────
      try { out.x = node.x; out.y = node.y; } catch(_) {}
      try { out.width  = node.width;  } catch(_) {}
      try { out.height = node.height; } catch(_) {}
      try { out.rotation = node.rotation; } catch(_) {}
      // Full 2×3 affine matrix — the only way to capture flip (negative scale)
      // alongside rotation. We use this at restore time to recover both.
      try { out.relativeTransform = safeJson(node.relativeTransform); } catch(_) {}
      // Page-space transform — used at restore time to place root nodes correctly
      // even when they were originally inside a section or nested frame
      // (relativeTransform is parent-relative, absoluteTransform is page-relative).
      try { out.absoluteTransform = safeJson(node.absoluteTransform); } catch(_) {}

      // ── Visibility & blend ────────────────────────────────────────────────
      try { out.visible   = node.visible;   } catch(_) {}
      try { out.opacity   = node.opacity;   } catch(_) {}
      try { out.blendMode = node.blendMode; } catch(_) {}
      try { out.locked    = node.locked;    } catch(_) {}
      try { out.isMask    = node.isMask;    } catch(_) {}

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

      // ── Auto-layout child properties ──────────────────────────────────────
      // layoutPositioning = 'ABSOLUTE' means this child is manually placed inside
      // an auto-layout parent. Without restoring it, absolute children land in the
      // auto-layout flow and get wrong positions/sizes.
      try { if ('layoutPositioning' in node) out.layoutPositioning = node.layoutPositioning; } catch(_) {}
      try { if ('layoutAlign'       in node) out.layoutAlign       = node.layoutAlign;       } catch(_) {}
      try { if ('layoutGrow'        in node) out.layoutGrow        = node.layoutGrow;        } catch(_) {}

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
        // vectorNetwork omitted — it can be many MB on complex paths and isn't
        // needed for asset restore (vectorPaths is sufficient for recreation).
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
        try { out.characters          = node.characters || '';       } catch(_) {}
        try { out.textAlignHorizontal = node.textAlignHorizontal;   } catch(_) {}
        try { out.textAlignVertical   = node.textAlignVertical;     } catch(_) {}
        try { out.textAutoResize      = node.textAutoResize;        } catch(_) {}
        try { out.paragraphSpacing    = node.paragraphSpacing;      } catch(_) {}
        try { out.paragraphIndent     = node.paragraphIndent;       } catch(_) {}
        // Node-level text style — used as the whole-node default AND as a
        // fallback when getStyledTextSegments is unavailable.
        try {
          var ntc = node.textCase;
          if (ntc && ntc !== figma.mixed) out.textCase = ntc;
        } catch(_) {}
        try {
          var nls = node.letterSpacing;
          if (nls && nls !== figma.mixed) out.letterSpacing = safeJson(nls);
        } catch(_) {}
        try {
          var nlh = node.lineHeight;
          if (nlh && nlh !== figma.mixed) out.lineHeight = safeJson(nlh);
        } catch(_) {}

        // Per-character segments — preserves mixed fonts, sizes, colours,
        // textCase (all-caps etc.), letter-spacing and line-height.
        try {
          var segs = node.getStyledTextSegments([
            'fontName', 'fontSize', 'fontWeight', 'fills',
            'textDecoration', 'textCase', 'letterSpacing', 'lineHeight',
          ]);
          out.textSegments = segs.map(function(s) {
            return {
              start:          s.start,
              end:            s.end,
              characters:     s.characters,
              fontName:       s.fontName  ? { family: s.fontName.family, style: s.fontName.style } : null,
              fontSize:       s.fontSize,
              fontWeight:     s.fontWeight,
              fills:          safeJson(s.fills) || [],
              textDecoration: s.textDecoration,
              textCase:       s.textCase,
              letterSpacing:  safeJson(s.letterSpacing),
              lineHeight:     safeJson(s.lineHeight),
            };
          });
          // Primary font/size → node-level defaults
          if (segs.length > 0 && segs[0].fontName) {
            out.fontName = { family: segs[0].fontName.family, style: segs[0].fontName.style };
            out.fontSize = segs[0].fontSize;
          }
        } catch(_) {
          // Fallback if getStyledTextSegments unavailable
          try {
            var fn = node.fontName;
            if (fn && typeof fn === 'object' && fn.family) out.fontName = { family: fn.family, style: fn.style };
          } catch(_) {}
          try { var fs = node.fontSize; if (typeof fs === 'number') out.fontSize = fs; } catch(_) {}
        }
      }

      // ── Children ──────────────────────────────────────────────────────────
      // For INSTANCE nodes we still capture children so that text/fill/size
      // overrides on component children are preserved.  At restore time we
      // do NOT create new child nodes; instead we walk the instance's existing
      // children by name and apply the stored overrides.
      // Depth is capped at 6 to prevent memory exhaustion on deep/complex frames.
      if ('children' in node && _depth < 6) {
        try {
          if (node.children.length) {
            out.children = [];
            for (var ci = 0; ci < node.children.length; ci++) {
              try { out.children.push(serializeNode(node.children[ci], _depth + 1)); } catch(_) {}
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

    // ── Build a human-readable type summary e.g. "1 section + 4 frames" ──
    var typeCounts = {};
    for (var ti = 0; ti < sel.length; ti++) {
      var nt = sel[ti].type;
      typeCounts[nt] = (typeCounts[nt] || 0) + 1;
    }
    var typeLabels = {
      FRAME: 'frame', SECTION: 'section', GROUP: 'group',
      COMPONENT: 'component', INSTANCE: 'instance',
      TEXT: 'text layer', VECTOR: 'vector', ELLIPSE: 'ellipse',
      RECTANGLE: 'rectangle', LINE: 'line', POLYGON: 'polygon',
      STAR: 'star', BOOLEAN_OPERATION: 'boolean group',
      COMPONENT_SET: 'component set', SLICE: 'slice'
    };
    var typeParts = [];
    for (var tt in typeCounts) {
      var tnc = typeCounts[tt];
      var tlabel = (typeLabels[tt] || tt.toLowerCase()) + (tnc > 1 ? 's' : '');
      typeParts.push(tnc + ' ' + tlabel);
    }
    var typeSummary = typeParts.join(' + ') || (nodes.length + ' node' + (nodes.length !== 1 ? 's' : ''));

    // ── Guard payload size before sending ────────────────────────────────
    // postMessage has a ~50 MB hard limit in Figma's sandbox; serialising large
    // frames can exceed it and trigger a memory-leak crash.  Reject early with
    // a helpful message rather than letting the plugin OOM.
    var _payloadJson;
    try { _payloadJson = JSON.stringify(nodes); } catch (_jsonErr) {
      figma.ui.postMessage({ type: 'save-asset-result', ok: false,
        error: 'Selection too complex to serialise — try selecting fewer layers.' });
      return;
    }
    var _payloadMB = (_payloadJson.length * 2) / (1024 * 1024); // rough bytes → MB
    if (_payloadMB > 8) {
      figma.ui.postMessage({ type: 'save-asset-result', ok: false,
        error: 'Selection is too large (' + _payloadMB.toFixed(1) + ' MB) — select fewer or simpler layers.' });
      return;
    }

    // ── Send nodes ────────────────────────────────────────────────────────
    try {
      figma.ui.postMessage({ type: 'save-asset-result', ok: true,
        name: assetName, assetType: sel.length === 1 ? sel[0].type : 'GROUP',
        nodeCount: nodes.length, typeSummary: typeSummary, nodes: nodes });
    } catch (pmErr) {
      figma.ui.postMessage({ type: 'save-asset-result', ok: false,
        error: 'Payload too large for postMessage — select fewer/simpler nodes (' + pmErr.message + ')' });
      return;
    }

    // ── Export a preview thumbnail ─────────────────────────────────────────
    // code.js (Figma sandbox) does NOT have btoa — so we just send the raw
    // Uint8Array bytes. The UI iframe (full browser context) converts to
    // base64 and upgrades the canvas-swatch preview to a real PNG render.
    // SECTION nodes are not directly exportable — copy children into a
    // temporary frame, export that, then immediately remove it.
    var previewNode = sel[0];
    var tempWrapper = null;
    try {
      if (previewNode.type === 'SECTION') {
        tempWrapper = figma.createFrame();
        tempWrapper.name = '__preview_tmp__';
        tempWrapper.clipsContent = true;
        tempWrapper.fills = [{ type: 'SOLID', color: { r:1, g:1, b:1 } }];
        var pw = Math.max(previewNode.width  || 100, 1);
        var ph = Math.max(previewNode.height || 100, 1);
        tempWrapper.resize(pw, ph);
        figma.currentPage.appendChild(tempWrapper);
        var sectionKids = Array.from(previewNode.children || []);
        for (var ki = 0; ki < sectionKids.length; ki++) {
          try { tempWrapper.appendChild(sectionKids[ki].clone()); } catch(_) {}
        }
        previewNode = tempWrapper;
      }

      // Export at 0.1× — keeps PNG tiny (typically < 20 KB)
      var pngBytes = await previewNode.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 0.1 }
      });
      // Pure-JS base64 encoder — no btoa needed (unavailable in Figma sandbox).
      // Sends a plain string data URL; strings always transfer correctly via postMessage.
      var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      var b64 = '';
      var bl = pngBytes.length;
      for (var b64i = 0; b64i < bl; b64i += 3) {
        var b0 = pngBytes[b64i];
        var b1 = (b64i + 1 < bl) ? pngBytes[b64i + 1] : 0;
        var b2 = (b64i + 2 < bl) ? pngBytes[b64i + 2] : 0;
        b64 += B64[b0 >> 2];
        b64 += B64[((b0 & 3) << 4) | (b1 >> 4)];
        b64 += B64[((b1 & 15) << 2) | (b2 >> 6)];
        b64 += B64[b2 & 63];
      }
      if (bl % 3 === 1) b64 = b64.slice(0, -2) + '==';
      else if (bl % 3 === 2) b64 = b64.slice(0, -1) + '=';

      figma.ui.postMessage({
        type: 'save-asset-preview',
        dataUrl: 'data:image/png;base64,' + b64
      });
    } catch(thumbErr) {
      figma.ui.postMessage({ type: 'save-asset-preview', error: thumbErr.message });
    } finally {
      if (tempWrapper) { try { tempWrapper.remove(); } catch(_) {} }
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
        // Descend into all children — including instance children (now serialised)
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

    // Helper: apply position + rotation/flip to a node using the stored transform.
    // For rotated/flipped nodes we must use the stored pivot (rt[0][2], rt[1][2])
    // not def.x/def.y — def.x is the bounding-box origin, which differs from
    // the transform pivot when the node is rotated.
    function applyPositionAndTransform(node, def) {
      if (def.relativeTransform) {
        var rt = def.relativeTransform;
        var a = rt[0][0], b = rt[0][1], tx = rt[0][2];
        var c = rt[1][0], d = rt[1][1], ty = rt[1][2];

        // INSTANCE: check whether scale is baked into the stored transform.
        //
        // • Scale baked in (scale-tool was used on the original):
        //     Apply the FULL matrix — scale + rotation + translation.
        //     resizeWithoutConstraints was intentionally skipped above, so the
        //     matrix is the only thing that defines the visual size.
        //
        // • No scale in matrix (instance was resized normally):
        //     resizeWithoutConstraints already set the correct size above.
        //     Strip scale (≈ identity anyway) and apply rotation + translation only
        //     so we don't accidentally fight the override size.
        if (node.type === 'INSTANCE') {
          var iSx = Math.sqrt(a * a + c * c);
          var iSy = Math.sqrt(b * b + d * d);
          var iHasScale = Math.abs(iSx - 1) > 0.01 || Math.abs(iSy - 1) > 0.01;

          if (iHasScale) {
            // Apply full matrix — scale encodes the visual size.
            try {
              node.relativeTransform = [[a, b, tx], [c, d, ty]];
              return;
            } catch(_) {}
            // Fallback: position only (scale lost, but at least no double-scale)
            try { node.x = tx; node.y = ty; } catch(_) {}
            return;
          } else {
            // No scale — strip the (identity) scale to be safe, keep rotation + translation.
            var angle = Math.atan2(c, a);
            var cos = Math.cos(angle), sin = Math.sin(angle);
            try {
              node.relativeTransform = [[cos, -sin, tx], [sin, cos, ty]];
              return;
            } catch(_) {}
            try { node.x = tx; node.y = ty; } catch(_) {}
            try { if (angle !== 0) node.rotation = -(angle * 180 / Math.PI); } catch(_) {}
            return;
          }
        }

        // All other node types: apply the full stored matrix.
        try {
          node.relativeTransform = [[a, b, tx], [c, d, ty]];
          return;
        } catch(_) {
          // Setter unavailable (auto-layout child in flow) — fall through
          try { if (typeof def.rotation === 'number' && def.rotation !== 0) node.rotation = def.rotation; } catch(_) {}
        }
      } else if (typeof def.rotation === 'number' && def.rotation !== 0) {
        try { node.rotation = def.rotation; } catch(_) {}
      }
      // Fallback: plain x/y
      try { if (typeof def.x === 'number') node.x = def.x; } catch(_) {}
      try { if (typeof def.y === 'number') node.y = def.y; } catch(_) {}
    }

    // applyInstanceChildOverrides — walk an instance's live children and apply
    // property overrides stored in defChildren, matched by name recursively.
    // Conservative: only text content, fills, visibility — never position or
    // size (the component controls layout; fighting it breaks things).
    async function applyInstanceChildOverrides(liveChildren, defChildren) {
      for (var di = 0; di < defChildren.length; di++) {
        var childDef = defChildren[di];
        var match = null;
        for (var li = 0; li < liveChildren.length; li++) {
          if (liveChildren[li].name === childDef.name) { match = liveChildren[li]; break; }
        }
        if (!match) continue;

        // Visibility + opacity
        if (childDef.visible === false && 'visible' in match) { try { match.visible = false; } catch(_) {} }
        if (typeof childDef.opacity === 'number' && 'opacity' in match) { try { match.opacity = childDef.opacity; } catch(_) {} }

        // Fills + effects (colour overrides)
        if (childDef.fills != null && 'fills' in match) { try { match.fills = childDef.fills; } catch(_) {} }
        if (childDef.effects != null && 'effects' in match && childDef.effects.length) { try { match.effects = childDef.effects; } catch(_) {} }

        // Text content overrides — font, size, characters, segments
        if (match.type === 'TEXT' && childDef.type === 'TEXT') {
          var pFont = (childDef.fontName && childDef.fontName.family) ? childDef.fontName : fallbackFont;
          var pSize = (typeof childDef.fontSize === 'number' && childDef.fontSize > 0) ? childDef.fontSize : 14;
          try { match.fontName = pFont; } catch(_) {}
          try { match.fontSize = pSize; } catch(_) {}
          try { match.characters = childDef.characters || ''; } catch(_) {}
          try { if (childDef.textCase)      match.textCase      = childDef.textCase;      } catch(_) {}
          try { if (childDef.letterSpacing) match.letterSpacing = childDef.letterSpacing; } catch(_) {}
          try { if (childDef.lineHeight)    match.lineHeight    = childDef.lineHeight;    } catch(_) {}
          if (childDef.textSegments && childDef.textSegments.length >= 1) {
            for (var tsgi = 0; tsgi < childDef.textSegments.length; tsgi++) {
              var tseg = childDef.textSegments[tsgi];
              if (tseg.start >= tseg.end) continue;
              try { if (tseg.fontName && tseg.fontName.family) match.setRangeFontName(tseg.start, tseg.end, tseg.fontName); } catch(_) {}
              try { if (typeof tseg.fontSize === 'number') match.setRangeFontSize(tseg.start, tseg.end, tseg.fontSize); } catch(_) {}
              try { if (tseg.fills && tseg.fills.length) match.setRangeFills(tseg.start, tseg.end, tseg.fills); } catch(_) {}
              try { if (tseg.textCase      != null) match.setRangeTextCase(tseg.start, tseg.end, tseg.textCase); } catch(_) {}
              try { if (tseg.letterSpacing != null) match.setRangeLetterSpacing(tseg.start, tseg.end, tseg.letterSpacing); } catch(_) {}
              try { if (tseg.lineHeight    != null) match.setRangeLineHeight(tseg.start, tseg.end, tseg.lineHeight); } catch(_) {}
              try { if (tseg.textDecoration) match.setRangeTextDecoration(tseg.start, tseg.end, tseg.textDecoration); } catch(_) {}
            }
          }
          try { if (childDef.textAlignHorizontal) match.textAlignHorizontal = childDef.textAlignHorizontal; } catch(_) {}
          try { if (childDef.textAlignVertical)   match.textAlignVertical   = childDef.textAlignVertical;   } catch(_) {}
        }

        // Recurse into nested children
        if (childDef.children && childDef.children.length && 'children' in match) {
          await applyInstanceChildOverrides(match.children, childDef.children);
        }
      }
    }

    // restoreNode(def, parent, skipPosition)
    //   skipPosition — when true the caller will position this node after grouping;
    //   we must NOT call applyPositionAndTransform here so the group can place
    //   children without any pre-applied offset causing double-counting.
    async function restoreNode(def, parent, skipPosition) {
      var node;
      try {

        // ── CLONE-FIRST SHORTCUT ──────────────────────────────────────────────
        // When restoring within the same Figma file, the original node usually
        // still exists (user saves a template, then restores a copy next to it).
        // Cloning is vastly more reliable than JSON-based recreation: it perfectly
        // preserves component scale, variant selection, fills, effects — anything
        // we may have failed to capture in the serialised snapshot.
        //
        // We clone for ALL node types, not just INSTANCE, so that frame children,
        // vectors, groups, etc. are also perfectly preserved.
        //
        // If the original no longer exists (deleted, or cross-file restore), we
        // fall through to the normal JSON-based recreation path below.
        if (def.id) {
          try {
            var origNode = figma.getNodeById(def.id);
            // Only use the clone if the type still matches (guard against ID
            // reuse after delete+recreate in the same session, which is unlikely
            // but possible).
            if (origNode && origNode.type === def.type) {
              var cloneNode = origNode.clone();
              cloneNode.name = def.name || 'Restored';

              // Append to parent (or page if no parent / SECTION type).
              if (def.type === 'SECTION' || !parent) {
                figma.currentPage.appendChild(cloneNode);
              } else {
                parent.appendChild(cloneNode);
              }

              // Restore auto-layout child role before position so the engine
              // does not override our relativeTransform assignment below.
              if (def.layoutPositioning != null && 'layoutPositioning' in cloneNode) {
                try { cloneNode.layoutPositioning = def.layoutPositioning; } catch(_) {}
              }

              if (!skipPosition) applyPositionAndTransform(cloneNode, def);
              return cloneNode;
            }
          } catch(_) {}
          // Clone failed — fall through to JSON-based recreation.
        }

        // ── GROUP: special-case — figma.group() needs pre-existing nodes ─────
        //
        // The double-counting trap:
        //   1. restoreNode(child, gParent) places child at childDef.x/y in gParent
        //   2. figma.group() absorbs min(children bbox) → becomes the group's x/y,
        //      child position within group resets to 0
        //   3. Re-apply childDef.x/y now adds the offset AGAIN → 2× error
        //
        // Fix: create children with skipPosition=true (no position applied).
        // All children land at Figma's default (0,0-ish) in gParent.
        // After figma.group(), children are inside the group still near (0,0).
        // THEN apply each child's stored position once — correctly in group space.
        if (def.type === 'GROUP') {
          var gParent = parent || figma.currentPage;
          var gChildNodes = [];
          var gChildDefs  = [];
          if (def.children && def.children.length) {
            for (var gci = 0; gci < def.children.length; gci++) {
              try {
                // skipPosition=true: children are created but NOT yet positioned.
                //
                // Why: the stored relativeTransform/x/y values for each child are
                // in GROUP-LOCAL coordinate space.  If we applied them while the
                // child is still in gParent (before figma.group()), we would be
                // interpreting group-local coordinates in gParent's coordinate
                // system — wrong when the group is rotated or the parent is not
                // the page.
                //
                // After figma.group() the children live inside the group's own
                // (possibly rotated) coordinate system, so applyPositionAndTransform
                // below will place each one correctly.
                var gch = await restoreNode(def.children[gci], gParent, true);
                if (gch) { gChildNodes.push(gch); gChildDefs.push(def.children[gci]); }
              } catch(_) {}
            }
          }
          var grpNode;
          if (gChildNodes.length > 0) {
            grpNode = figma.group(gChildNodes, gParent);
            // Children are now inside grpNode's local coordinate system.
            // Apply their stored group-relative positions in two passes:
            // the first pass positions everything; the second pass corrects
            // any bounding-box drift that Figma may have introduced while
            // repositioning children one-by-one in pass 1.
            for (var gpass = 0; gpass < 2; gpass++) {
              for (var gpi = 0; gpi < gChildNodes.length; gpi++) {
                try { applyPositionAndTransform(gChildNodes[gpi], gChildDefs[gpi]); } catch(_) {}
              }
            }
          } else {
            // No children — fall back to a transparent frame
            grpNode = figma.createFrame();
            grpNode.fills = [];
            gParent.appendChild(grpNode);
          }
          grpNode.name = def.name || 'Group';
          if (typeof def.opacity   === 'number') { try { grpNode.opacity   = def.opacity;   } catch(_) {} }
          if (typeof def.blendMode === 'string') { try { grpNode.blendMode = def.blendMode; } catch(_) {} }
          if (def.visible === false)              { try { grpNode.visible   = false;          } catch(_) {} }
          if (!skipPosition) applyPositionAndTransform(grpNode, def);
          return grpNode; // early return — children already handled
        }

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
          } else if (def.type === 'SECTION') {
            // Sections are page-level only; createSection() places on current page
            node = figma.createSection();
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
        // SectionNodes are always page-level — they cannot be children of frames.
        if (def.type === 'SECTION' || !parent) {
          figma.currentPage.appendChild(node);
        } else {
          parent.appendChild(node);
        }

        // ── Auto-layout child role — set IMMEDIATELY after append ──────────
        // This MUST happen before resize/position.  If the parent has auto-layout
        // and this child is 'ABSOLUTE', the auto-layout engine will otherwise
        // override our resize() and relativeTransform calls made below.
        // Setting ABSOLUTE first opts the child out of flow management so all
        // subsequent size and position calls land correctly.
        if (def.layoutPositioning != null && 'layoutPositioning' in node) {
          try { node.layoutPositioning = def.layoutPositioning; } catch(_) {}
        }
        if (def.layoutAlign != null && 'layoutAlign' in node) {
          try { node.layoutAlign = def.layoutAlign; } catch(_) {}
        }
        if (def.layoutGrow != null && 'layoutGrow' in node) {
          try { node.layoutGrow = def.layoutGrow; } catch(_) {}
        }

        // ── Size ─────────────────────────────────────────────────────────
        // Node is now in the document tree (appended above) and layoutPositioning
        // is set, so resize calls will take effect correctly.
        if (def.type === 'VECTOR') {
          if (def.vectorPaths && def.vectorPaths.length) {
            try { node.vectorPaths = def.vectorPaths; } catch(_) {}
          }
          if (def.width > 0 && def.height > 0) {
            try { node.resize(def.width, def.height); } catch(_) {
              try { node.resizeWithoutConstraints(def.width, def.height); } catch(_) {}
            }
          }
        } else if (def.type !== 'TEXT' && def.type !== 'LINE' && def.width > 0 && def.height > 0) {
          if (def.type === 'INSTANCE') {
            // Detect whether scale was baked into the relativeTransform (scale tool).
            // When scale IS baked in, the matrix itself encodes the visual size —
            // calling resizeWithoutConstraints would set an OVERRIDE size that then
            // conflicts with the transform scale, causing double-scaling.
            // When there is NO scale in the matrix (instance was resized with the
            // resize handle), we must resize explicitly because the matrix is identity
            // and the override width/height is the only record of the intended size.
            var defRt = def.relativeTransform;
            var instanceHasScale = false;
            if (defRt && defRt[0] && defRt[1]) {
              var rta = defRt[0][0], rtc = defRt[1][0];
              var rtb = defRt[0][1], rtd = defRt[1][1];
              var rtSx = Math.sqrt(rta * rta + rtc * rtc);
              var rtSy = Math.sqrt(rtb * rtb + rtd * rtd);
              instanceHasScale = Math.abs(rtSx - 1) > 0.01 || Math.abs(rtSy - 1) > 0.01;
            }
            if (!instanceHasScale) {
              // No scale in matrix — the override size must be applied explicitly.
              try { node.resizeWithoutConstraints(def.width, def.height); } catch(_) {
                try { node.resize(def.width, def.height); } catch(_) {}
              }
            }
            // If instanceHasScale: skip resize — applyPositionAndTransform will
            // apply the full matrix (including scale) which defines the visual size.
          } else {
            try { node.resize(def.width, def.height); } catch(_) {
              try { node.resizeWithoutConstraints(def.width, def.height); } catch(_) {}
            }
          }
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
        if (def.isMask  === true  && 'isMask'  in node)                { try { node.isMask    = true;          } catch(_) {} }

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

        // ── Auto-layout (frame-level) ─────────────────────────────────────
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
        // clipsContent applies to all frames regardless of layoutMode
        if (def.clipsContent != null && 'clipsContent' in node) {
          try { node.clipsContent = def.clipsContent; } catch(_) {}
        }

        // ── Shape-specific ────────────────────────────────────────────────
        if ((def.type === 'POLYGON' || def.type === 'STAR') && def.pointCount) {
          try { node.pointCount = def.pointCount; } catch(_) {}
        }
        if (def.type === 'STAR' && def.innerRadius != null) {
          try { node.innerRadius = def.innerRadius; } catch(_) {}
        }
        // VECTOR paths were already applied in the size block above.

        // ── Text ──────────────────────────────────────────────────────────
        if (def.type === 'TEXT') {
          // Safe order:
          //   1. font + size
          //   2. characters (node defaults to HEIGHT auto-resize, box expands to fit)
          //   3. per-segment overrides
          //   4. alignment + paragraph props
          //   5. textAutoResize — set AFTER characters so the box has already grown
          //   6. if mode is NONE, force exact stored dimensions (box is now fixed)
          var primaryFont = (def.fontName && def.fontName.family) ? def.fontName : fallbackFont;
          var primarySize = (typeof def.fontSize === 'number' && def.fontSize > 0) ? def.fontSize : 14;
          try { node.fontName = primaryFont; } catch(_) { try { node.fontName = fallbackFont; } catch(_) {} }
          try { node.fontSize = primarySize; } catch(_) {}
          try { node.characters = def.characters || ''; } catch(_) {}

          // Node-level text style
          try { if (def.textCase)       node.textCase       = def.textCase;       } catch(_) {}
          try { if (def.letterSpacing)  node.letterSpacing  = def.letterSpacing;  } catch(_) {}
          try { if (def.lineHeight)     node.lineHeight     = def.lineHeight;     } catch(_) {}
          try { if (def.paragraphSpacing != null) node.paragraphSpacing = def.paragraphSpacing; } catch(_) {}
          try { if (def.paragraphIndent  != null) node.paragraphIndent  = def.paragraphIndent;  } catch(_) {}

          // Per-segment overrides
          if (def.textSegments && def.textSegments.length >= 1) {
            for (var sgi = 0; sgi < def.textSegments.length; sgi++) {
              var seg = def.textSegments[sgi];
              if (seg.start >= seg.end) continue;
              try { if (seg.fontName && seg.fontName.family) node.setRangeFontName(seg.start, seg.end, seg.fontName); } catch(_) {}
              try { if (typeof seg.fontSize === 'number' && seg.fontSize > 0) node.setRangeFontSize(seg.start, seg.end, seg.fontSize); } catch(_) {}
              try { if (seg.fills && seg.fills.length) node.setRangeFills(seg.start, seg.end, seg.fills); } catch(_) {}
              try { if (seg.textCase      != null) node.setRangeTextCase(seg.start, seg.end, seg.textCase); } catch(_) {}
              try { if (seg.letterSpacing != null) node.setRangeLetterSpacing(seg.start, seg.end, seg.letterSpacing); } catch(_) {}
              try { if (seg.lineHeight    != null) node.setRangeLineHeight(seg.start, seg.end, seg.lineHeight); } catch(_) {}
              try { if (seg.textDecoration)        node.setRangeTextDecoration(seg.start, seg.end, seg.textDecoration); } catch(_) {}
            }
          }

          try { if (def.textAlignHorizontal) node.textAlignHorizontal = def.textAlignHorizontal; } catch(_) {}
          try { if (def.textAlignVertical)   node.textAlignVertical   = def.textAlignVertical;   } catch(_) {}

          // Apply resize mode last — after content is set so the box has correct dimensions.
          // For NONE (fixed box), also force the stored width × height.
          try { if (def.textAutoResize) node.textAutoResize = def.textAutoResize; } catch(_) {}
          if (def.textAutoResize === 'NONE' && def.width > 0 && def.height > 0) {
            try { node.resize(def.width, def.height); } catch(_) {
              try { node.resizeWithoutConstraints(def.width, def.height); } catch(_) {}
            }
          }
        }

        // ── Children ──────────────────────────────────────────────────────────
        if (def.children && def.children.length && 'children' in node) {
          if (node.type === 'INSTANCE') {
            // INSTANCE: children already exist (created by the component).
            // We cannot add/remove them, but we CAN apply overrides by matching
            // stored child defs to live children by name, recursively.
            await applyInstanceChildOverrides(node.children, def.children);
          } else {
            for (var ci = 0; ci < def.children.length; ci++) {
              await restoreNode(def.children[ci], node);
            }
          }
        }

        // ── Position + rotation + flip ─────────────────────────────────────
        // Skip when called from a GROUP parent — it will apply position after
        // figma.group() so children land correctly in the group's coordinate space.
        if (!skipPosition) applyPositionAndTransform(node, def);

      } catch (re) {
        restoreErrors.push((def.name || '?') + ': ' + re.message);
      }
      return node;
    }

    var restored = [];
    var vc = figma.viewport.center;

    // Compute centroid of all root nodes using their saved absoluteTransform
    // pivots (tx = col[2]). This correctly handles nodes that were inside
    // sections or frames — their relativeTransform is parent-relative, but
    // absoluteTransform is always page-space.
    var sumAX = 0, sumAY = 0, countA = 0;
    for (var pi = 0; pi < tree.length; pi++) {
      var pat = tree[pi].absoluteTransform;
      if (pat && pat[0] && pat[1]) {
        sumAX += pat[0][2];
        sumAY += pat[1][2];
        countA++;
      }
    }
    var anchorX = countA ? sumAX / countA : Math.round(vc.x);
    var anchorY = countA ? sumAY / countA : Math.round(vc.y);
    // Shift centroid to viewport centre so the whole group lands in view.
    var layoutOffsetX = Math.round(vc.x) - anchorX;
    var layoutOffsetY = Math.round(vc.y) - anchorY;

    for (var ri = 0; ri < tree.length; ri++) {
      var rn = await restoreNode(tree[ri], null);
      if (rn) {
        var srcAt = tree[ri].absoluteTransform;
        if (srcAt && srcAt[0] && srcAt[1]) {
          // Place using page-space pivot + layout offset so relative positions
          // between nodes are fully preserved and rotation/flip matrices are kept.
          var vtx = srcAt[0][2] + layoutOffsetX;
          var vty = srcAt[1][2] + layoutOffsetY;
          try {
            rn.relativeTransform = [[srcAt[0][0], srcAt[0][1], vtx], [srcAt[1][0], srcAt[1][1], vty]];
          } catch(_) {
            try { rn.x = vtx; rn.y = vty; } catch(_) {}
          }
        } else {
          // Fallback — no absoluteTransform data, stagger from viewport centre.
          var vtx2 = Math.round(vc.x) + ri * 24;
          var vty2 = Math.round(vc.y) + ri * 24;
          try {
            var curRt = rn.relativeTransform;
            rn.relativeTransform = [[curRt[0][0], curRt[0][1], vtx2], [curRt[1][0], curRt[1][1], vty2]];
          } catch(_) {
            try { rn.x = vtx2; rn.y = vty2; } catch(_) {}
          }
        }
        // ── Section child safety-pass ────────────────────────────────────
        // SectionNode does not always propagate its own position change to
        // children in the Figma plugin API (behaviour differs by API version).
        // After moving the section above, verify each direct child frame
        // reached the expected absolute position.  If it hasn't (i.e. the
        // section is not a proper coordinate container for this API version),
        // apply the layout offset to the child explicitly.
        //
        // This is a no-op when sections DO auto-move children because the
        // position check will match and the branch is skipped.
        if (rn.type === 'SECTION') {
          var scDefs = tree[ri].children || [];
          var scNodes = rn.children;
          for (var sci2 = 0; sci2 < scNodes.length; sci2++) {
            var scNode = scNodes[sci2];
            var scDef  = scDefs[sci2];
            if (!scNode || !scDef || !scDef.absoluteTransform) continue;
            var scAt = scDef.absoluteTransform;
            var expAbsX = scAt[0][2] + layoutOffsetX;
            var expAbsY = scAt[1][2] + layoutOffsetY;
            var curAt;
            try { curAt = scNode.absoluteTransform; } catch(_) { continue; }
            if (!curAt) continue;
            // Tolerance of 2px — sub-pixel rounding is expected.
            if (Math.abs(curAt[0][2] - expAbsX) > 2 || Math.abs(curAt[1][2] - expAbsY) > 2) {
              // Child did NOT auto-move with the section.  Push it to the
              // correct page-space position by offsetting its current
              // relativeTransform translation components.
              try {
                var scRt = scNode.relativeTransform;
                scNode.relativeTransform = [
                  [scRt[0][0], scRt[0][1], scRt[0][2] + layoutOffsetX],
                  [scRt[1][0], scRt[1][1], scRt[1][2] + layoutOffsetY]
                ];
              } catch(_) {
                try { scNode.x += layoutOffsetX; scNode.y += layoutOffsetY; } catch(_) {}
              }
            }
          }
        }

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

  // ── Casino Game Library: insert a game image into the canvas ────────────
  if (msg.type === 'casino-insert-image') {
    try {
      var cImg = figma.createImage(new Uint8Array(msg.bytes));
      var cRect = figma.createRectangle();
      cRect.name = msg.name || 'Game Image';
      var cW = Math.max(1, Math.round(msg.width  || 200));
      var cH = Math.max(1, Math.round(msg.height || 200));
      cRect.resize(cW, cH);
      cRect.fills = [{ type: 'IMAGE', imageHash: cImg.hash, scaleMode: 'FILL' }];
      cRect.strokes = [];

      // Place into selected frame/group if one is selected, else onto the page.
      var cSel = figma.currentPage.selection;
      var cParent = figma.currentPage;
      var cCx = figma.viewport.center.x;
      var cCy = figma.viewport.center.y;
      if (cSel.length === 1) {
        var cNode = cSel[0];
        if (cNode.type === 'FRAME' || cNode.type === 'GROUP' || cNode.type === 'COMPONENT') {
          cParent = cNode;
          cCx = cNode.x + cNode.width  / 2;
          cCy = cNode.y + cNode.height / 2;
        }
      }
      cParent.appendChild(cRect);
      cRect.x = cCx - cW / 2;
      cRect.y = cCy - cH / 2;
      figma.currentPage.selection = [cRect];
      figma.viewport.scrollAndZoomIntoView([cRect]);
      figma.ui.postMessage({ type: 'casino-insert-success', name: msg.name });
    } catch (ce) {
      figma.ui.postMessage({ type: 'casino-insert-error', message: ce.message });
    }
    return;
  }


  // ── Image Tools: export a layer ──────────────────────────────────
  if (msg.type === 'export') {
    var icNode = figma.getNodeById(msg.nodeId);
    if (!icNode || !('exportAsync' in icNode)) {
      figma.ui.postMessage({ type: 'export-error', exportId: msg.exportId,
        error: 'Layer not found (id: ' + msg.nodeId + ')' });
      return;
    }
    try {
      var icBytes = await icNode.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: msg.scale || 1 }
      });
      figma.ui.postMessage({ type: 'export-result', exportId: msg.exportId,
        bytes: Array.from(icBytes) });
    } catch (icErr) {
      figma.ui.postMessage({ type: 'export-error', exportId: msg.exportId,
        error: 'exportAsync threw: ' + String(icErr) });
    }
    return;
  }

  // ── Image Tools: export PDFs ─────────────────────────────────────
  if (msg.type === 'export-pdf') {
    var pdfResults = [];
    for (var pi = 0; pi < (msg.nodeIds || []).length; pi++) {
      var pdfNode = figma.getNodeById(msg.nodeIds[pi]);
      if (!pdfNode || !('exportAsync' in pdfNode)) continue;
      try {
        var pdfBytes = await pdfNode.exportAsync({ format: 'PDF' });
        pdfResults.push({ nodeId: msg.nodeIds[pi], name: pdfNode.name, bytes: Array.from(pdfBytes) });
      } catch (pe) {
        pdfResults.push({ nodeId: msg.nodeIds[pi], name: pdfNode.name, error: String(pe) });
      }
    }
    figma.ui.postMessage({ type: 'pdf-results', results: pdfResults });
    return;
  }

  // ── Image Tools: refresh layer list ──────────────────────────────
  if (msg.type === 'refresh') {
    await ic_refreshLayers();
    return;
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};


// ════════════════════════════════════════════════════════════════════
// IMAGE TOOLS — code.js helpers
// ════════════════════════════════════════════════════════════════════

function ic_resolveScale(constraint, nodeWidth) {
  if (!constraint) return 1;
  switch (constraint.type) {
    case 'SCALE':  return constraint.value;
    case 'WIDTH':  return nodeWidth > 0 ? constraint.value / nodeWidth : 1;
    default:       return 1;
  }
}

function ic_buildLayerList() {
  var layers = [];
  // Expand sections to their direct children so Optimiser/Artworker/Animator
  // display the frames inside a section rather than the section itself
  // (SectionNode has no exportAsync and would otherwise produce an empty list).
  var entries = expandSections(Array.from(figma.currentPage.selection));
  for (var ni = 0; ni < entries.length; ni++) {
    var entry = entries[ni];
    var node = entry.node;
    var sectionName = entry.sectionName;
    if (!('exportAsync' in node)) continue;
    var nodeWidth  = 'width'  in node ? node.width  : 100;
    var nodeHeight = 'height' in node ? node.height : 100;
    var settings   = node.exportSettings;
    if (settings && settings.length > 0) {
      for (var si = 0; si < settings.length; si++) {
        var s = settings[si];
        var scale = ic_resolveScale(s.constraint, nodeWidth);
        layers.push({
          id: node.id, settingIndex: si,
          name: node.name + (s.suffix || ''),
          format: s.format, scale: scale,
          width:  Math.round(nodeWidth  * scale),
          height: Math.round(nodeHeight * scale),
          sectionName: sectionName,
        });
      }
    } else {
      layers.push({
        id: node.id, settingIndex: -1,
        name: node.name, format: 'PNG', scale: 1,
        width: Math.round(nodeWidth), height: Math.round(nodeHeight),
        sectionName: sectionName,
      });
    }
  }
  return layers;
}

function ic_sendThumbnail(nodeId) {
  var node = figma.getNodeById(nodeId);
  if (!node || !('exportAsync' in node)) return;
  var w = 'width'  in node ? node.width  : 100;
  var h = 'height' in node ? node.height : 100;
  var maxDim = Math.max(w, h, 1);
  var thumbScale = Math.min(48 / maxDim, 2);
  node.exportAsync({
    format: 'PNG',
    constraint: { type: 'SCALE', value: Math.max(thumbScale, 0.05) }
  }).then(function(bytes) {
    figma.ui.postMessage({ type: 'thumbnail', nodeId: nodeId, bytes: Array.from(bytes) });
  }).catch(function() { /* non-fatal */ });
}

async function ic_refreshLayers() {
  var layers = ic_buildLayerList();
  figma.ui.postMessage({ type: 'layers', layers: layers });
  var seen = {};
  for (var i = 0; i < layers.length; i++) {
    if (!seen[layers[i].id]) {
      seen[layers[i].id] = true;
      ic_sendThumbnail(layers[i].id);
    }
  }
}

// Also fire when selection changes
figma.on('selectionchange', function() { ic_refreshLayers(); });

// Kick off on load — deferred for the same reason as postSelection above.
ic_refreshLayers();
setTimeout(ic_refreshLayers, 400);
