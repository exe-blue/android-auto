/*! Copyright 2025 Fonticons, Inc. - https://webawesome.com/license */

// _bundle_/src/internal/parse.ts
function parseSpaceDelimitedTokens(input) {
  return input.split(" ").map((token) => token.trim()).filter((token) => token !== "");
}

export {
  parseSpaceDelimitedTokens
};
