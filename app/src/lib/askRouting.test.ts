import { describe, expect, it } from "vitest";
import { describesUnit, isFieldAsk, isOperationalAsk } from "./askRouting";

describe("routing field work to Forge AI", () => {
  it("sends the first typed message of each core field action to the live tools", () => {
    for (const q of [
      "Clock into unit 4", "Who is working on unit 4?", "Build unit 4 for Aaron and Tyson", "I finished unit 4",
      "Empieza la unidad 4", "Terminé la unidad 4", "¿Quién está en la unidad 4?",
      "Empieza unidad 4 de aluminio en QA Example Deck", "Start unit 4", "stop my timer", "Claim unit four and start me",
      "what units are on this job?", "Start a new project", "I'm on idle time loading the truck", "Comienza la unidad 7",
      "Construye la unidad 5", "Crea una obra nueva", "detén mi temporizador", "join unit 3 as a helper",
      // The Build a unit card's own words, typed (live finding, 2026-09-24).
      "Set up unit 2 on Smi", "Set up the unit I'm working on", "Configurar la unidad 4",
      // Past work on a unit is the Record crew work card's job (same finding:
      // the eval's crew-record cases could never reach the tool by typing).
      "Ben and Ana installed unit 4 yesterday", "Frank worked on unit 7 on Monday", "Ana y Ben instalaron la unidad 4 ayer", "Trabajaron en la unidad 4",
    ]) expect(isFieldAsk(q), q).toBe(true);
  });
  it("keeps install tips and 'my next unit' on the free local answers", () => {
    for (const q of ["My next unit", "What is flashing?", "Do I caulk the bottom?", "Single hung tips", "Which side does the drain face?", "Tips for a 72×48 slider?"])
      expect(isOperationalAsk(q), q).toBe(false);
  });
  it("a follow-up inside a field setup stays with the field tools", () => {
    expect(isOperationalAsk("aluminum, second floor, six by eight", true)).toBe(true);
  });
  it("a lesson write-up goes to the field tools in English and Spanish", () => {
    for (const q of ["Lesson learned on unit 16: the sill pan leaked", "What happened on the Smith job today", "La lección aprendida fue revisar la esquina"]) expect(isFieldAsk(q)).toBe(true);
    expect(isFieldAsk("What is flashing?")).toBe(false);
  });
});

// PR #641's router finding: a first message that only describes a unit has no
// action verb, so only the Build a unit card, a voice memo or an open
// conversation reached the field tools. Now a named unit plus a type or size
// word routes as the card does; anything that reads as a question, a report,
// schedule talk or a problem stays out — a miss costs one card tap.
describe("a typed description of a unit routes like the Build a unit card", () => {
  it("English: a named unit with a type word or a size", () => {
    for (const q of [
      "Unit 4 on Smith is a bifold door, aluminum, second floor", "Unit 9 is a fixed picture window, vinyl", "unit 4 bifold 8 by six",
      "Unit W-12 is a 36 by 48 fixed window", "Unit 7 sliding door, 2 panels", "Unit 12A is an OXXO slider", "Unit 3 double hung, wood frame",
      "unit 5 is 8' by 6'", "Unit 6 casement, second floor", "Unit 4 has two door panels and one frame", "Unit #7 is a french door on the Smith job",
      "Unit 2 is 72x48, aluminum", "It's unit 4, a slider, 3 metres wide", "Unit 11 is 2 m by 1.8 m", "Unit 4 window, aluminum, 2nd floor",
    ]) {
      expect(describesUnit(q), q).toBe(true);
      expect(isOperationalAsk(q), q).toBe(true);
    }
  });
  it("Spanish: the same, in the words the crew uses", () => {
    for (const q of [
      "La unidad 4 en Smith es una puerta plegable de aluminio, segundo piso", "Unidad 7 es una ventana fija de vinilo", "La unidad 3 mide dos metros por uno ochenta",
      "unidad 9 puerta corrediza, tres paneles", "La unidad doce es abatible, de madera", "Unidad 5 es fija", "unidad 8 tiene tres hojas",
    ]) {
      expect(describesUnit(q), q).toBe(true);
      expect(isOperationalAsk(q), q).toBe(true);
    }
  });
  it("mixed: a unit named in one language and described in the other", () => {
    for (const q of ["Unit cuatro es un bifold, two panels, aluminio, on the second floor", "Unidad 4 is a slider, vinyl", "unit 7 puerta francesa, aluminio"]) {
      expect(describesUnit(q), q).toBe(true);
      expect(isOperationalAsk(q), q).toBe(true);
    }
  });
  it("questions about a unit are not a setup, with or without the question mark", () => {
    for (const q of [
      "what's the size of unit 4?", "What's the size of unit 4", "How do I flash a bifold door on unit 4?", "¿Cómo instalo la puerta de la unidad 4?",
      "Cómo instalo la puerta de la unidad 4", "Is unit 4 a slider?", "Is unit 4 a slider", "Es una puerta plegable la unidad 4",
      "Tips for a 72×48 slider?", "Single hung tips", "What is flashing?", "Which side does the drain face?",
    ]) {
      expect(describesUnit(q), q).toBe(false);
      expect(isOperationalAsk(q), q).toBe(false);
    }
  });
  it("hours, reports and schedule talk about a unit go to the office tools, not a setup", () => {
    for (const q of ["Put unit 4's sliding door on next week's schedule", "Hours report for the unit 4 window install", "Assign the unit 4 door to Ben", "Horas de la unidad 4, puerta corrediza"]) {
      expect(describesUnit(q), q).toBe(false);
      expect(isFieldAsk(q), q).toBe(false);
      expect(isOperationalAsk(q), q).toBe(true);
    }
  });
  it("a problem with a unit, a bare unit, a status or a repair stays with the local answers", () => {
    for (const q of [
      "the door on unit 4 is leaking", "Unit 4 window glass cracked on delivery", "La ventana de la unidad 4 está rota",
      "Unit 4", "unit 4 aluminum", "Unit 4 in the garage", "Unit 4 by 5pm", "Unit 4 is done", "unit 4 looks good", "la unidad 4 está lista",
      "I fixed unit 4", "fixed unit 4 this morning", "Fijo que la unidad 4 está lista", "How do I install unit 4", "I'm installing unit 4", "My next unit",
      "I took three boxes of 2 inch screws from the shop for Smith", "going to lunch", "voy a comer", "clock me out", "Sign my toolbox talk for me",
    ]) {
      expect(describesUnit(q), q).toBe(false);
      expect(isFieldAsk(q), q).toBe(false);
    }
  });
});
