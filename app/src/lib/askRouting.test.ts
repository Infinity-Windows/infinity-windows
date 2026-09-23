import { describe, expect, it } from "vitest";
import { isFieldAsk, isOperationalAsk } from "./askRouting";

describe("routing field work to Forge AI", () => {
  it("sends the first typed message of each core field action to the live tools", () => {
    for (const q of [
      "Clock into unit 4", "Who is working on unit 4?", "Build unit 4 for Aaron and Tyson", "I finished unit 4",
      "Empieza la unidad 4", "Terminé la unidad 4", "¿Quién está en la unidad 4?",
      "Empieza unidad 4 de aluminio en QA Example Deck", "Start unit 4", "stop my timer", "Claim unit four and start me",
      "what units are on this job?", "Start a new project", "I'm on idle time loading the truck", "Comienza la unidad 7",
      "Construye la unidad 5", "Crea una obra nueva", "detén mi temporizador", "join unit 3 as a helper",
    ]) expect(isFieldAsk(q), q).toBe(true);
  });
  it("keeps install tips and 'my next unit' on the free local answers", () => {
    for (const q of ["My next unit", "What is flashing?", "Do I caulk the bottom?", "Single hung tips", "Which side does the drain face?", "Tips for a 72×48 slider?"])
      expect(isOperationalAsk(q), q).toBe(false);
  });
  it("a follow-up inside a field setup stays with the field tools", () => {
    expect(isOperationalAsk("aluminum, second floor, six by eight", true)).toBe(true);
  });
});
