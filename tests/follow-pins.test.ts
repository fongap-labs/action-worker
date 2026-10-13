import assert from "node:assert/strict";
import { test } from "node:test";
import {
  editPinFile,
  groupPinEdits,
  parseFollowManifest,
  pinFormat,
  sameValue,
} from "../scripts/follow-pins.ts";

const oldCommit = "0123456789abcdef0123456789abcdef01234567";
const newCommit = "fedcba9876543210fedcba9876543210fedcba98";

test("a JSON pin changes exactly the declared key and keeps every other byte", () => {
  const text = '{\n  "deps": {\n    "tool": "1.2.3",\n    "other": "keep"\n  }\n}\n';
  const result = editPinFile("requirements.json", text, [
    { key: "/deps/tool", kind: "version", to: "1.2.4" },
  ]);
  assert.equal(result, text.replace('"tool": "1.2.3"', '"tool": "1.2.4"'));
});

test("a TOML pin uses a dotted key and leaves a comment that holds the old value alone", () => {
  const text = [
    '# version = "1.2.3" (kept as a note)',
    "[dependency]",
    'version = "1.2.3"',
    'name = "tool"',
    "",
  ].join("\n");
  const result = editPinFile("pins.toml", text, [
    { key: "dependency.version", kind: "version", to: "1.2.4" },
  ]);
  assert.equal(result, text.replace('version = "1.2.3"\nname', 'version = "1.2.4"\nname'));
});

test("a commit value that appears twice changes only the occurrence of the declared key", () => {
  const text = `{"first":"${oldCommit}","second":"${oldCommit}"}`;
  const result = editPinFile("pins.json", text, [{ key: "/first", kind: "commit", to: newCommit }]);
  assert.equal(result, `{"first":"${newCommit}","second":"${oldCommit}"}`);
});

test("several pins in one file are applied together and each key is checked", () => {
  const text = `{"a":"${oldCommit}","b":"${oldCommit}","v":"1.2.3"}`;
  const result = editPinFile("pins.json", text, [
    { key: "/a", kind: "commit", to: newCommit },
    { key: "/v", kind: "version", to: "1.2.4" },
  ]);
  assert.equal(result, `{"a":"${newCommit}","b":"${oldCommit}","v":"1.2.4"}`);
});

test("a pin already at its value is left alone, even when the same value appears twice", () => {
  const text = `{"a":"${newCommit}","b":"${newCommit}"}`;
  assert.equal(
    editPinFile("pins.json", text, [{ key: "/a", kind: "commit", to: newCommit }]),
    text
  );
});

test("a value that is not a single quoted occurrence is refused, never rewritten", () => {
  // The value is spelled with an escape, so the file never contains the quoted text 1.2.3.
  const text = '{"v":"1\\u002e2.3"}';
  assert.throws(
    () => editPinFile("pins.json", text, [{ key: "/v", kind: "version", to: "1.2.4" }]),
    /No occurrence of the current value of \/v in pins\.json changes only that key/
  );
});

test("a key whose value is not of the declared kind is refused", () => {
  assert.throws(
    () =>
      editPinFile("pins.json", '{"v":"not-a-version"}', [
        { key: "/v", kind: "version", to: "1.2.4" },
      ]),
    /must hold a single version string/
  );
  assert.throws(
    () =>
      editPinFile("pins.json", '{"v":"1.2.3"}', [
        { key: "/missing", kind: "version", to: "1.2.4" },
      ]),
    /must hold a single version string/
  );
});

test("a replacement value of the wrong kind is refused", () => {
  assert.throws(
    () => editPinFile("pins.json", '{"v":"1.2.3"}', [{ key: "/v", kind: "version", to: "abc" }]),
    /New version value for \/v in pins\.json is invalid/
  );
});

test("a declared key listed twice is refused", () => {
  assert.throws(
    () =>
      editPinFile("pins.json", '{"v":"1.2.3"}', [
        { key: "/v", kind: "version", to: "1.2.4" },
        { key: "/v", kind: "version", to: "1.2.5" },
      ]),
    /declared twice/
  );
});

test("an invalid document is refused with the file name", () => {
  assert.throws(
    () => editPinFile("pins.json", "{not json", [{ key: "/v", kind: "version", to: "1.2.4" }]),
    /Follow pin file is not valid JSON: pins\.json/
  );
});

test("only .json and .toml pin files are accepted", () => {
  assert.equal(pinFormat("a/b.json"), "json");
  assert.equal(pinFormat("a/b.toml"), "toml");
  assert.throws(() => pinFormat("a/b.yaml"), /must be a \.json or \.toml file/);
});

test("pins are grouped by file with the value each one should hold", () => {
  const manifest = parseFollowManifest({
    upstream: { repository: "fongap-labs/example", release_key: "shared-lib" },
    pins: [
      { path: "a.json", key: "/x", value: "commit" },
      { path: "a.json", key: "/y", value: "version" },
      { path: "b.toml", key: "dep.version", value: "version" },
    ],
  });
  const groups = groupPinEdits(manifest.pins, (pin) =>
    pin.value === "commit" ? newCommit : "1.2.4"
  );
  assert.deepEqual([...groups.keys()], ["a.json", "b.toml"]);
  assert.deepEqual(groups.get("a.json"), [
    { key: "/x", kind: "commit", to: newCommit },
    { key: "/y", kind: "version", to: "1.2.4" },
  ]);
});

test("a follow manifest parses, and every malformed field is refused", () => {
  const valid = {
    upstream: { repository: "fongap-labs/example", release_key: "shared-lib" },
    pins: [{ path: "requirements.toml", key: "dep.version", value: "version" }],
  };
  assert.deepEqual(parseFollowManifest(valid).pins, valid.pins);
  assert.equal(parseFollowManifest({ ...valid, lockfile: "uv" }).lockfile, "uv");

  const invalid: unknown[] = [
    { ...valid, extra: true },
    { ...valid, lockfile: "npm" },
    { ...valid, pins: [] },
    { ...valid, upstream: { repository: "not a repo", release_key: "shared-lib" } },
    { ...valid, upstream: { repository: "fongap-labs/example", release_key: "Shared_Lib" } },
    { ...valid, pins: [{ path: "../x.toml", key: "a", value: "version" }] },
    { ...valid, pins: [{ path: "x.yaml", key: "a", value: "version" }] },
    { ...valid, pins: [{ path: "x.toml", key: "a", value: "branch" }] },
    { ...valid, pins: [valid.pins[0], valid.pins[0]] },
    {
      ...valid,
      pins: Array.from({ length: 33 }, (_, index) => ({
        path: "x.toml",
        key: `k${index}`,
        value: "version",
      })),
    },
  ];
  for (const value of invalid) {
    assert.throws(() => parseFollowManifest(value), Error, JSON.stringify(value).slice(0, 120));
  }
});

test("sameValue treats dates by time and nested structures by content", () => {
  assert.equal(sameValue(new Date(0), new Date(0)), true);
  assert.equal(sameValue(new Date(0), new Date(1)), false);
  assert.equal(sameValue({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] }), true);
  assert.equal(sameValue({ a: 1 }, { a: 1, b: undefined }), false);
});
