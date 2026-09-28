import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { targetPath } from "./target.mjs";

export function readTargetText(...segments) {
  return readFileSync(targetPath(...segments), "utf8");
}

export function readTargetJson(...segments) {
  return JSON.parse(readTargetText(...segments));
}

export function requireText(content, values) {
  for (const value of values) {
    assert.ok(content.includes(value), `missing contract text: ${value}`);
  }
}
