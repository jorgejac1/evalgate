import { test } from "node:test";
import assert from "node:assert/strict";
import { subtract } from "./subtract.js";

test("subtract", () => {
  assert.equal(subtract(5, 3), 2);
  assert.equal(subtract(0, 0), 0);
});
