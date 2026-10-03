import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { clearPrivateValuesQueries } from "./privateQueries";

it("removes every private values projection without touching unrelated work data", () => {
  const client = new QueryClient();
  client.setQueryData(["valuesOwnerReport", "owner-a", 1], { people: [{ comment: "private" }] });
  client.setQueryData(["valuesMyTasks", "owner-a", 1], [{ subjectName: "private" }]);
  client.setQueryData(["valuesMySummary", "owner-a", 1], { mirror: {} });
  client.setQueryData(["workSchedule", "owner-a"], { jobs: ["keep"] });
  clearPrivateValuesQueries(client);
  expect(client.getQueryData(["valuesOwnerReport", "owner-a", 1])).toBeUndefined();
  expect(client.getQueryData(["valuesMyTasks", "owner-a", 1])).toBeUndefined();
  expect(client.getQueryData(["valuesMySummary", "owner-a", 1])).toBeUndefined();
  expect(client.getQueryData(["workSchedule", "owner-a"])).toEqual({ jobs: ["keep"] });
});
