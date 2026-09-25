// "Nothing was saved yet" (K2.5): prose that reads as done with no receipt
// behind it is contradicted on screen. These pin what counts as a claim,
// in English and Spanish, and what does not.
import { describe, expect, it } from "vitest";
import { needsNothingSavedNotice, receiptStatus, soundsDone } from "./askReceiptGuard";

describe("receipt words", () => {
  it("come from the receipt's status, never from prose", () => {
    expect(receiptStatus({ status: "done" })).toBe("saved_in_forge");
    expect(receiptStatus({ status: "running" })).toBe("saved_in_forge");
    expect(receiptStatus({ status: "needs_choice" })).toBe("needs_choice");
    expect(receiptStatus({ status: "stale" })).toBe("nothing_changed");
    expect(receiptStatus({ status: "cancelled" })).toBe("nothing_changed");
  });
});

describe("prose that claims a change", () => {
  const claims = [
    "I've saved unit 4 with those details.",
    "Done — I started your timer on unit 4.",
    "Unit 4 has been created on Black Desert.",
    "Your timer is now running on unit 7.",
    "All set! The log is filed.",
    "I logged that for you. Anything else?",
    "The job was created and supervisors were notified.",
    "Saved successfully.",
    "Listo, guardé la unidad 4.",
    "Ya creé la obra Black Desert.",
    "Tu temporizador quedó iniciado en la unidad 4.",
    "La unidad ha sido registrada.",
    "Todo listo, el registro está guardado.",
  ];
  for (const text of claims) it(`claims: "${text}"`, () => expect(soundsDone(text)).toBe(true));

  const honest = [
    "Which unit are you on?",
    "Once you tap Start now, the timer is started from that moment.",
    "I can save unit 4 once you tell me its type. What type is it?",
    "Nothing was saved yet — tap Use the plans or Use what I said on the card.",
    "The card asks you to choose; nothing has changed yet.",
    "I haven't saved anything. Do you want me to create the job?",
    "Would you like me to start your timer?",
    "Tap Start break below when you go.",
    "¿Qué tipo de unidad es?",
    "Cuando toques Empezar ahora, el temporizador inicia.",
    "No se guardó nada todavía. Elige una opción en la tarjeta.",
    "Puedo crear la obra si me dices la ubicación.",
    "Voy a guardar la unidad cuando confirmes el tipo.",
    "Flashing goes on before the frame is set; the sill pan is set first.",
    // Future tense in a contraction is still the future (live finding, 2026-09-24).
    "You'll need to log that withdrawal there so the Smith job's supply use is recorded.",
    "I'll note it on unit 4 once you say how many.",
    "It’ll be saved when you tap Save.",
  ];
  for (const text of honest) it(`does not claim: "${text}"`, () => expect(soundsDone(text)).toBe(false));

  it("judges sentence by sentence: a question after a claim does not excuse the claim", () => {
    expect(soundsDone("I've saved unit 4. What is the next unit?")).toBe(true);
  });
});

describe("the notice", () => {
  it("appears under a claim with no receipt, card or applied draft — a checklist alone is not proof", () => {
    expect(needsNothingSavedNotice({ text: "I've saved unit 4." })).toBe(true);
    expect(needsNothingSavedNotice({ text: "I've saved unit 4.", receipts: [] })).toBe(true);
  });
  it("stays away when a receipt, a report card or an applied draft backs the words", () => {
    expect(needsNothingSavedNotice({ text: "Unit 4 has been saved.", receipts: [{ status: "done" }] })).toBe(false);
    expect(needsNothingSavedNotice({ text: "Unit 4 has been saved.", receipts: [{ status: "needs_choice" }] })).toBe(false);
    expect(needsNothingSavedNotice({ text: "Your hours are ready.", artifacts: [{ kind: "time_report" }] })).toBe(false);
    expect(needsNothingSavedNotice({ text: "I recorded that in your daily log draft.", draftApplied: true })).toBe(false);
  });
  it("stays away from honest prose", () => {
    expect(needsNothingSavedNotice({ text: "Which unit are you on?" })).toBe(false);
  });
});
