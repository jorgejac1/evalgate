import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "./add.js";

test("add", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
  assert.equal(add(0, 0), 0);
});
