import assert from "node:assert/strict";
import test from "node:test";
import { derive_selections } from "../capture-deployment-tests.mjs";
import { assert_exact_selected_results } from "./selection-accounting.mjs";

function discovery(certificationIds: readonly string[]) {
  const suites = [
    { id: "semantic/suite", executionShape: "cases", requirements: [], sourceRef: null },
    { id: "browser/suite", executionShape: "browser-journeys", requirements: [], sourceRef: null },
    ...certificationIds.map((id) => ({ id, executionShape: "certification-aggregate", requirements: [], sourceRef: `node-command:${id}` })),
    { id: "cert/dynamic", executionShape: "certification-aggregate", requirements: ["dynamic-generated"], sourceRef: "node-command:dynamic" },
  ];
  return {
    catalog: {
      suites,
      tests: [
        { id: "semantic/suite::case", suiteId: "semantic/suite" },
        { id: "browser/suite::journey", suiteId: "browser/suite" },
      ],
    },
  } as any;
}

test("capture selections derive from discovery without fixed inventory totals", () => {
  const first = derive_selections(discovery(["cert/one"]));
  const grown = derive_selections(discovery(["cert/one", "cert/two"]));
  assert.deepEqual(first.find((entry) => entry.name === "certification")?.ids, ["cert/one"]);
  assert.deepEqual(grown.find((entry) => entry.name === "certification")?.ids, ["cert/one", "cert/two"]);
});

test("same-count wrong results fail exact selected-set reconciliation", () => {
  assert.throws(() => assert_exact_selected_results(
    ["cert/one", "cert/two"],
    [
      { id: "cert/one", executionShape: "certification-aggregate", cases: [] },
      { id: "cert/unexpected", executionShape: "certification-aggregate", cases: [] },
    ],
    "certification",
  ), /TEST_SELECTION_RESULT_SET_MISMATCH:certification/);
});
