/*! Copyright 2025 Fonticons, Inc. - https://webawesome.com/license */
import {
  o,
  require_react
} from "./chunk.G5SSLR4K.js";
import {
  WaTooltip
} from "./chunk.DERG7TC5.js";
import {
  __toESM
} from "./chunk.6E4D3PD7.js";

// _bundle_/src/react/tooltip/index.ts
var React = __toESM(require_react(), 1);
var tagName = "wa-tooltip";
var reactWrapper = o({
  tagName,
  elementClass: WaTooltip,
  react: React,
  events: {
    onWaShow: "wa-show",
    onWaAfterShow: "wa-after-show",
    onWaHide: "wa-hide",
    onWaAfterHide: "wa-after-hide"
  },
  displayName: "WaTooltip"
});
var tooltip_default = reactWrapper;

export {
  tooltip_default
};
