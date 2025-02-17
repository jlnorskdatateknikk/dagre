"use strict";

var acyclic = require("./acyclic");
var normalize = require("./normalize");
var rank = require("./rank");
var normalizeRanks = require("./util").normalizeRanks;
var parentDummyChains = require("./parent-dummy-chains");
var removeEmptyRanks = require("./util").removeEmptyRanks;
var nestingGraph = require("./nesting-graph");
var addBorderSegments = require("./add-border-segments");
var coordinateSystem = require("./coordinate-system");
var order = require("./order");
var position = require("./position");
var util = require("./util");
var Graph = require("@dagrejs/graphlib").Graph;

module.exports = layout;

function layout(g, opts) {
  var time = opts && opts.debugTiming ? util.time : util.notime;
  time("layout", () => {
    var layoutGraph =
      time("  buildLayoutGraph", () => buildLayoutGraph(g));
    time("  runLayout",        () => runLayout(layoutGraph, time));
    time("  updateInputGraph", () => updateInputGraph(g, layoutGraph));
  });
}

function runLayout(g, time) {
  time("    makeSpaceForEdgeLabels", () => makeSpaceForEdgeLabels(g));
  time("    removeSelfEdges",        () => removeSelfEdges(g));
  time("    acyclic",                () => acyclic.run(g));
  time("    nestingGraph.run",       () => nestingGraph.run(g));
  time("    rank",                   () => rank(util.asNonCompoundGraph(g)));
  time("    injectEdgeLabelProxies", () => injectEdgeLabelProxies(g));
  time("    removeEmptyRanks",       () => removeEmptyRanks(g));
  time("    nestingGraph.cleanup",   () => nestingGraph.cleanup(g));
  time("    normalizeRanks",         () => normalizeRanks(g));
  time("    assignRankMinMax",       () => assignRankMinMax(g));
  time("    removeEdgeLabelProxies", () => removeEdgeLabelProxies(g));
  time("    normalize.run",          () => normalize.run(g));
  time("    parentDummyChains",      () => parentDummyChains(g));
  time("    addBorderSegments",      () => addBorderSegments(g));
  time("    order",                  () => order(g));
  time("    insertSelfEdges",        () => insertSelfEdges(g));
  time("    adjustCoordinateSystem", () => coordinateSystem.adjust(g));
  time("    position",               () => position(g));
  time("    positionSelfEdges",      () => positionSelfEdges(g));
  time("    removeBorderNodes",      () => removeBorderNodes(g));
  time("    normalize.undo",         () => normalize.undo(g));
  time("    fixupEdgeLabelCoords",   () => fixupEdgeLabelCoords(g));
  time("    undoCoordinateSystem",   () => coordinateSystem.undo(g));
  time("    translateGraph",         () => translateGraph(g));
  time("    assignNodeIntersects",   () => assignNodeIntersects(g));
  time("    reversePoints",          () => reversePointsForReversedEdges(g));
  time("    acyclic.undo",           () => acyclic.undo(g));
}

/*
 * Copies final layout information from the layout graph back to the input
 * graph. This process only copies whitelisted attributes from the layout graph
 * to the input graph, so it serves as a good place to determine what
 * attributes can influence layout.
 */
function updateInputGraph(inputGraph, layoutGraph) {
  inputGraph.nodes().forEach(v => {
    var inputLabel = inputGraph.node(v);
    var layoutLabel = layoutGraph.node(v);

    if (inputLabel) {
      inputLabel.x = layoutLabel.x;
      inputLabel.y = layoutLabel.y;
      inputLabel.rank = layoutLabel.rank;

      if (layoutGraph.children(v).length) {
        inputLabel.width = layoutLabel.width;
        inputLabel.height = layoutLabel.height;
      }
    }
  });

  inputGraph.edges().forEach(e => {
    var inputLabel = inputGraph.edge(e);
    var layoutLabel = layoutGraph.edge(e);

    inputLabel.points = layoutLabel.points;
    if (layoutLabel.hasOwnProperty("x")) {
      inputLabel.x = layoutLabel.x;
      inputLabel.y = layoutLabel.y;
    }
  });

  inputGraph.graph().width = layoutGraph.graph().width;
  inputGraph.graph().height = layoutGraph.graph().height;
}

var graphNumAttrs = ["nodesep", "edgesep", "ranksep", "marginx", "marginy"];
var graphDefaults = { ranksep: 50, edgesep: 20, nodesep: 50, rankdir: "tb" };
var graphAttrs = ["acyclicer", "ranker", "rankdir", "align"];
var nodeNumAttrs = ["width", "height"];
var nodeDefaults = { width: 0, height: 0 };
var edgeNumAttrs = ["minlen", "weight", "width", "height", "labeloffset"];
var edgeDefaults = {
  minlen: 1, weight: 1, width: 0, height: 0,
  labeloffset: 10, labelpos: "r"
};
var edgeAttrs = ["labelpos"];

/*
 * Constructs a new graph from the input graph, which can be used for layout.
 * This process copies only whitelisted attributes from the input graph to the
 * layout graph. Thus this function serves as a good place to determine what
 * attributes can influence layout.
 */
function buildLayoutGraph(inputGraph) {
  var g = new Graph({ multigraph: true, compound: true });
  var graph = canonicalize(inputGraph.graph());

  g.setGraph(Object.assign({},
    graphDefaults,
    selectNumberAttrs(graph, graphNumAttrs),
    util.pick(graph, graphAttrs)));

  inputGraph.nodes().forEach(v => {
    var node = canonicalize(inputGraph.node(v));
    const newNode = selectNumberAttrs(node, nodeNumAttrs);
    Object.keys(nodeDefaults).forEach(k => {
      if (newNode[k] === undefined) {
        newNode[k] = nodeDefaults[k];
      }
    });

    g.setNode(v, newNode);
    g.setParent(v, inputGraph.parent(v));
  });

  inputGraph.edges().forEach(e => {
    var edge = canonicalize(inputGraph.edge(e));
    g.setEdge(e, Object.assign({},
      edgeDefaults,
      selectNumberAttrs(edge, edgeNumAttrs),
      util.pick(edge, edgeAttrs)));
  });

  return g;
}

/*
 * This idea comes from the Gansner paper: to account for edge labels in our
 * layout we split each rank in half by doubling minlen and halving ranksep.
 * Then we can place labels at these mid-points between nodes.
 *
 * We also add some minimal padding to the width to push the label for the edge
 * away from the edge itself a bit.
 */
function makeSpaceForEdgeLabels(g) {
  var graph = g.graph();
  graph.ranksep /= 2;
  g.edges().forEach(e => {
    var edge = g.edge(e);
    edge.minlen *= 2;
    if (edge.labelpos.toLowerCase() !== "c") {
      if (graph.rankdir === "TB" || graph.rankdir === "BT") {
        edge.width += edge.labeloffset;
      } else {
        edge.height += edge.labeloffset;
      }
    }
  });
}

/*
 * Creates temporary dummy nodes that capture the rank in which each edge's
 * label is going to, if it has one of non-zero width and height. We do this
 * so that we can safely remove empty ranks while preserving balance for the
 * label's position.
 */
function injectEdgeLabelProxies(g) {
  g.edges().forEach(e => {
    var edge = g.edge(e);
    if (edge.width && edge.height) {
      var v = g.node(e.v);
      var w = g.node(e.w);
      var label = { rank: (w.rank - v.rank) / 2 + v.rank, e: e };
      util.addDummyNode(g, "edge-proxy", label, "_ep");
    }
  });
}

function assignRankMinMax(g) {
  var maxRank = 0;
  g.nodes().forEach(v => {
    var node = g.node(v);
    if (node.borderTop) {
      node.minRank = g.node(node.borderTop).rank;
      node.maxRank = g.node(node.borderBottom).rank;
      maxRank = Math.max(maxRank, node.maxRank);
    }
  });
  g.graph().maxRank = maxRank;
}

function removeEdgeLabelProxies(g) {
  g.nodes().forEach(v => {
    var node = g.node(v);
    if (node.dummy === "edge-proxy") {
      g.edge(node.e).labelRank = node.rank;
      g.removeNode(v);
    }
  });
}

function translateGraph(g) {
  var minX = Number.POSITIVE_INFINITY;
  var maxX = 0;
  var minY = Number.POSITIVE_INFINITY;
  var maxY = 0;
  var graphLabel = g.graph();
  var marginX = graphLabel.marginx || 0;
  var marginY = graphLabel.marginy || 0;

  function getExtremes(attrs) {
    var x = attrs.x;
    var y = attrs.y;
    var w = attrs.width;
    var h = attrs.height;
    minX = Math.min(minX, x - w / 2);
    maxX = Math.max(maxX, x + w / 2);
    minY = Math.min(minY, y - h / 2);
    maxY = Math.max(maxY, y + h / 2);
  }

  g.nodes().forEach(v => getExtremes(g.node(v)));
  g.edges().forEach(e => {
    var edge = g.edge(e);
    if (edge.hasOwnProperty("x")) {
      getExtremes(edge);
    }
  });

  minX -= marginX;
  minY -= marginY;

  g.nodes().forEach(v => {
    var node = g.node(v);
    node.x -= minX;
    node.y -= minY;
  });

  g.edges().forEach(e => {
    var edge = g.edge(e);
    edge.points.forEach(p => {
      p.x -= minX;
      p.y -= minY;
    });
    if (edge.hasOwnProperty("x")) { edge.x -= minX; }
    if (edge.hasOwnProperty("y")) { edge.y -= minY; }
  });

  graphLabel.width = maxX - minX + marginX;
  graphLabel.height = maxY - minY + marginY;
}

function assignNodeIntersects(g) {
  g.edges().forEach(e => {
    var edge = g.edge(e);
    var nodeV = g.node(e.v);
    var nodeW = g.node(e.w);
    var p1, p2;
    if (!edge.points) {
      edge.points = [];
      p1 = nodeW;
      p2 = nodeV;
    } else {
      p1 = edge.points[0];
      p2 = edge.points[edge.points.length - 1];
    }
    edge.points.unshift(util.intersectRect(nodeV, p1));
    edge.points.push(util.intersectRect(nodeW, p2));
  });
}

function fixupEdgeLabelCoords(g) {
  g.edges().forEach(e => {
    var edge = g.edge(e);
    if (edge.hasOwnProperty("x")) {
      if (edge.labelpos === "l" || edge.labelpos === "r") {
        edge.width -= edge.labeloffset;
      }
      switch (edge.labelpos) {
      case "l": edge.x -= edge.width / 2 + edge.labeloffset; break;
      case "r": edge.x += edge.width / 2 + edge.labeloffset; break;
      }
    }
  });
}

function reversePointsForReversedEdges(g) {
  g.edges().forEach(e => {
    var edge = g.edge(e);
    if (edge.reversed) {
      edge.points.reverse();
    }
  });
}

function removeBorderNodes(g) {
  g.nodes().forEach(v => {
    if (g.children(v).length) {
      var node = g.node(v);
      var t = g.node(node.borderTop);
      var b = g.node(node.borderBottom);
      var l = g.node(node.borderLeft[node.borderLeft.length - 1]);
      var r = g.node(node.borderRight[node.borderRight.length - 1]);

      node.width = Math.abs(r.x - l.x);
      node.height = Math.abs(b.y - t.y);
      node.x = l.x + node.width / 2;
      node.y = t.y + node.height / 2;
    }
  });

  g.nodes().forEach(v => {
    if (g.node(v).dummy === "border") {
      g.removeNode(v);
    }
  });
}

function removeSelfEdges(g) {
  g.edges().forEach(e => {
    if (e.v === e.w) {
      var node = g.node(e.v);
      if (!node.selfEdges) {
        node.selfEdges = [];
      }
      node.selfEdges.push({ e: e, label: g.edge(e) });
      g.removeEdge(e);
    }
  });
}

function insertSelfEdges(g) {
  var layers = util.buildLayerMatrix(g);
  layers.forEach(layer => {
    var orderShift = 0;
    layer.forEach((v, i) => {
      var node = g.node(v);
      node.order = i + orderShift;
      (node.selfEdges || []).forEach(selfEdge => {
        util.addDummyNode(g, "selfedge", {
          width: selfEdge.label.width,
          height: selfEdge.label.height,
          rank: node.rank,
          order: i + (++orderShift),
          e: selfEdge.e,
          label: selfEdge.label
        }, "_se");
      });
      delete node.selfEdges;
    });
  });
}

function positionSelfEdges(g) {
  g.nodes().forEach(v => {
    var node = g.node(v);
    if (node.dummy === "selfedge") {
      var selfNode = g.node(node.e.v);
      var x = selfNode.x + selfNode.width / 2;
      var y = selfNode.y;
      var dx = node.x - x;
      var dy = selfNode.height / 2;
      g.setEdge(node.e, node.label);
      g.removeNode(v);
      node.label.points = [
        { x: x + 2 * dx / 3, y: y - dy },
        { x: x + 5 * dx / 6, y: y - dy },
        { x: x +     dx    , y: y },
        { x: x + 5 * dx / 6, y: y + dy },
        { x: x + 2 * dx / 3, y: y + dy }
      ];
      node.label.x = node.x;
      node.label.y = node.y;
    }
  });
}

function selectNumberAttrs(obj, attrs) {
  return util.mapValues(util.pick(obj, attrs), Number);
}

function canonicalize(attrs) {
  var newAttrs = {};
  if (attrs) {
    Object.entries(attrs).forEach(([k, v]) => {
      if (typeof k === "string") {
        k = k.toLowerCase();
      }

      newAttrs[k] = v;
    });
  }
  return newAttrs;
}
