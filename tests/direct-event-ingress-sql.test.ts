import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { webhookDeliverySql } from "../scripts/direct-event-ingress.ts";

function openInbox(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../docs/direct-event-ingress.sql", import.meta.url), "utf8"));
  return database;
}

test("real SQLite schema deduplicates signed bodies and delivery identifiers", () => {
  const database = openInbox();
  try {
    const insert = database.prepare(webhookDeliverySql.reserve);
    assert.equal(insert.run("delivery-a", "digest-a", 101, "push", "owner/source", 1).changes, 1);
    assert.equal(insert.run("delivery-b", "digest-a", 101, "push", "owner/source", 2).changes, 0);
    assert.equal(insert.run("delivery-a", "digest-b", 101, "push", "owner/source", 3).changes, 0);
    const byId = database.prepare(webhookDeliverySql.findId).get("delivery-a");
    const byDigest = database.prepare(webhookDeliverySql.findDigest).get("digest-a");
    assert.equal(byId?.body_digest, "digest-a");
    assert.equal(byDigest?.delivery_id, "delivery-a");
    assert.equal(database.prepare(webhookDeliverySql.findId).get("delivery-b"), undefined);
    assert.equal(database.prepare(webhookDeliverySql.findDigest).get("digest-b"), undefined);
  } finally {
    database.close();
  }
});

test("real SQLite UPDATE RETURNING gives one atomic lease and prevents repeat dispatch", () => {
  const database = openInbox();
  try {
    const now = Date.now();
    database
      .prepare(webhookDeliverySql.reserve)
      .run("delivery-a", "digest-a", 101, "push", "owner/source", 1);
    const lease = database.prepare(webhookDeliverySql.claim);
    const first = lease.get(now + 60_000, "delivery-a", now);
    const second = lease.get(now + 60_000, "delivery-a", now);
    assert.equal(first?.delivery_id, "delivery-a");
    assert.equal(second, undefined);
    assert.equal(database.prepare(webhookDeliverySql.pending).all(now).length, 0);
    database.prepare(webhookDeliverySql.complete).run(now, "delivery-a");
    assert.equal(database.prepare(webhookDeliverySql.pending).all(now + 120_000).length, 0);
    assert.equal(lease.get(now + 180_000, "delivery-a", now + 120_000), undefined);
  } finally {
    database.close();
  }
});

test("real SQLite orders a bounded retry batch by availability before age", () => {
  const database = openInbox();
  try {
    const now = Date.now();
    const insert = database.prepare(webhookDeliverySql.reserve);
    const expire = database.prepare(
      "UPDATE webhook_deliveries SET lease_until_ms = ? WHERE delivery_id = ?"
    );
    for (let index = 0; index < 30; index += 1) {
      const id = `delivery-${index}`;
      insert.run(id, `digest-${index}`, 101, "push", "owner/source", index + 1);
      if (index < 25) expire.run(now - 1_000, id);
    }
    const pending = database.prepare(webhookDeliverySql.pending).all(now);
    assert.equal(pending.length, 25);
    assert.deepEqual(
      pending.slice(0, 5).map((row) => row.delivery_id),
      ["delivery-25", "delivery-26", "delivery-27", "delivery-28", "delivery-29"]
    );
    assert.equal(
      pending.some((row) => row.delivery_id === "delivery-20"),
      false
    );
  } finally {
    database.close();
  }
});
