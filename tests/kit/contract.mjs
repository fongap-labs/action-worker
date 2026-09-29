import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { targetPath } from "./target.mjs";

/** @param {string[]} segments */
export function readTargetText(...segments) {
  return readFileSync(targetPath(...segments), "utf8");
}

/** @param {string[]} segments */
export function readTargetJson(...segments) {
  return JSON.parse(readTargetText(...segments));
}

/**
 * @param {string} content
 * @param {string[]} values
 */
export function requireText(content, values) {
  for (const value of values) {
    assert.ok(content.includes(value), `missing contract text: ${value}`);
  }
}
