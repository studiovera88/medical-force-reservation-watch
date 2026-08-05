import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSignatures,
  detectAvailability,
  stripLegend,
} from "../src/check-reservation.mjs";

const emptyTable = `
2026/08/12
11:00
12:00
13:00
08/12
（水）
×
×
×
08/13
（木）
×
×
-
◎
予約できます
×
予約できません
-
受付期間外です
`;

test("ignores the availability legend", () => {
  const detection = detectAvailability(emptyTable);

  assert.equal(detection.available, false);
  assert.equal(detection.reason, "no-available-slot");
});

test("detects an available slot inside the schedule table", () => {
  const detection = detectAvailability(`
2026/08/12
11:00
12:00
13:00
08/12
（水）
×
◎
×
◎
予約できます
×
予約できません
`);

  assert.equal(detection.available, true);
  assert.equal(detection.reason, "available-slot");
  assert.deepEqual(detection.slots, [
    {
      date: "08/12",
      day: "（水）",
      time: "12:00",
      symbol: "◎",
    },
  ]);
});

test("detects compact inline rows", () => {
  const detection = detectAvailability(`
11:00
12:00
13:00
08/12（水） × ◎ ×
◎ 予約できます
`);

  assert.equal(detection.available, true);
  assert.deepEqual(detection.slots, [
    {
      date: "08/12",
      day: "（水）",
      time: "12:00",
      symbol: "◎",
    },
  ]);
});

test("keeps only lines before the legend", () => {
  const lines = stripLegend(["08/12", "×", "◎", "予約できます", "×", "予約できません"]);

  assert.deepEqual(lines, ["08/12", "×"]);
});

test("builds stable signatures for parsed slots", () => {
  const detection = detectAvailability(`
11:00
12:00
08/12
（水）
◎
×
◎ 予約できます
`);

  assert.deepEqual(buildSignatures(detection), ["08/12|（水）|11:00|◎"]);
});
