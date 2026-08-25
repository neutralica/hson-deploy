import assert from "node:assert/strict";

type SuiteResult = Readonly<{
  id: string;
  executionShape: string;
  cases: readonly Readonly<{ id: string }>[];
}>;

function unique(ids: readonly string[], label: string): void {
  assert.equal(new Set(ids).size, ids.length, `TEST_SELECTION_DUPLICATE_${label}`);
}

/** Project the identities that actually reached a terminal result. Case-shaped
 * suites contribute case IDs; aggregate suites contribute their suite ID. */
export function executed_selection_ids(suiteRuns: readonly SuiteResult[]): readonly string[] {
  return Object.freeze(suiteRuns.flatMap((suite) => {
    if (suite.executionShape === "cases" || suite.executionShape === "browser-journeys") {
      return suite.cases.map((item) => item.id);
    }
    if (suite.executionShape === "opaque-aggregate" || suite.executionShape === "certification-aggregate") {
      return [suite.id];
    }
    throw new Error(`TEST_SELECTION_UNKNOWN_EXECUTION_SHAPE:${suite.id}:${suite.executionShape}`);
  }));
}

/** Count equality is deliberately insufficient: both sides must be unique and
 * the executed terminal identities must equal the selected identities exactly. */
export function assert_exact_selected_results(
  selectedIds: readonly string[],
  suiteRuns: readonly SuiteResult[],
  label: string,
): readonly string[] {
  const executedIds = executed_selection_ids(suiteRuns);
  unique(selectedIds, `${label}_SELECTED`);
  unique(executedIds, `${label}_EXECUTED`);
  assert.deepEqual([...executedIds].sort(), [...selectedIds].sort(), `TEST_SELECTION_RESULT_SET_MISMATCH:${label}`);
  return executedIds;
}
