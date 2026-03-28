import assert from "node:assert/strict";
import { average, sum } from "../src/index.js";

assert.equal(sum([1, 2, 3, 4]), 10);
assert.equal(average([2, 4, 6, 8]), 5);

console.log("sample_repo_small tests passed");
