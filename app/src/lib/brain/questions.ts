import type { BrainKind } from "./types";

/**
 * The 28 questions from docs/ask-infinity-token-free.md, exactly as the
 * investigation wrote them, with what a correct answer looks like.
 *
 * This is the scoreboard. The old code answered 6 of these; the investigation
 * predicted 17 for a plain keyword index over content the company already owns.
 * Add a question here when a real one comes out of the unanswered-question log —
 * do not soften an expectation to make the number look better.
 *
 * `correct` lists the entry ids that genuinely answer the question. `useful`
 * lists ids that are the right topic but don't answer it — the investigation's
 * "partial". `expectMiss` marks the questions nobody has written an answer to
 * yet: saying nothing is the right behaviour, and a confident answer is a bug.
 */
export interface BrainQuestion {
  n: number;
  question: string;
  /** What today's shipped code did — from the investigation's table. */
  before: "correct" | "app tour" | "nothing" | "wrong entry" | "partial";
  /** Entry ids that answer the question. Top result must be one of these. */
  correct?: string[];
  /** Right topic, wrong specificity. Counts toward "useful in three". */
  useful?: string[];
  /** Nothing in the brain answers this. The brain must stay quiet. */
  expectMiss?: true;
  /** Why, when the answer doesn't exist yet — read by the report, not the test. */
  gap?: string;
  /** Restrict the answer to a kind, where the kind is the point of the question. */
  kind?: BrainKind;
}

export const BRAIN_QUESTIONS: BrainQuestion[] = [
  {
    n: 1,
    question: "Which side does the drain side face?",
    before: "nothing",
    correct: ["tip:SH3252:0", "tip:DH3252:0", "tip:CAS3048:0", "tip:SL6048:2", "term:weep"],
  },
  {
    n: 2,
    question: "What order do I flash — sill, jambs or head?",
    before: "wrong entry",
    correct: ["term:flashtape", "step:win:9", "tip:SH3252:1", "tip:DH3252:1"],
  },
  {
    n: 3,
    question: "Do I caulk the bottom of the window?",
    before: "app tour",
    correct: ["tip:SH3252:2", "tip:DH3252:2", "tip:SH3252:4", "tip:CAS3048:2", "tip:SL6048:3"],
  },
  {
    n: 4,
    question: "Do I shim before I centre it, or after?",
    before: "partial",
    correct: ["tip:SH3252:3", "tip:DH3252:3", "step:win:7"],
  },
  {
    n: 5,
    question: "How deep does it set back on stucco?",
    before: "app tour",
    correct: ["watch:SH3252:1", "watch:DH3252:1", "watch:CAS3048:1", "watch:SL6048:2"],
  },
  {
    n: 6,
    question: "How far back on rock veneer?",
    before: "app tour",
    correct: ["watch:SH3252:1", "watch:DH3252:1", "watch:CAS3048:1", "watch:SL6048:2"],
  },
  {
    n: 7,
    question: "How heavy before I need a second man?",
    before: "app tour",
    correct: ["term:liftgear"],
    useful: ["tip:SL6048:0", "tip:SL7248:0", "watch:BAY7248:1", "tip:BAY7248:0"],
  },
  {
    n: 8,
    question: "The opening is out of level — what now?",
    before: "correct",
    correct: ["watch:SH3252:0", "term:level", "step:win:7", "step:main:2"],
  },
  {
    n: 9,
    question: "How much swing clearance does a hopper need?",
    before: "app tour",
    correct: ["tip:HOP3024:0"],
  },
  {
    n: 10,
    question: "How do I brace a bay while I set it?",
    before: "app tour",
    correct: ["tip:BAY7248:0", "tip:BAY7248:1", "watch:BAY7248:0"],
  },
  {
    n: 11,
    question: "Can I caulk over the weep holes?",
    before: "correct",
    correct: ["term:weep", "watch:DH3252:0", "tip:SH3252:4", "watch:HOP3024:2"],
  },
  {
    n: 12,
    question: "How many shims per side on an aluminium jamb?",
    before: "correct",
    correct: ["term:jamb", "step:win:7", "term:shim"],
  },
  {
    n: 13,
    question: "How tight do I run pressure plate screws?",
    before: "correct",
    correct: ["term:pressureplate"],
  },
  {
    n: 14,
    question: "Backer rod, or just caulk?",
    before: "correct",
    correct: ["term:backerrod", "step:main:11"],
  },
  {
    n: 15,
    question: "The slider drags — what did we do wrong?",
    before: "app tour",
    correct: ["watch:SL6048:0", "watch:SL7248:1", "tip:SL6048:1", "term:racking"],
  },
  {
    n: 16,
    question: "Rollers before or after I square the frame?",
    before: "wrong entry",
    correct: ["term:roller", "step:main:12"],
  },
  {
    n: 17,
    question: "What screws go in a commercial door's top hinge?",
    before: "app tour",
    correct: ["term:hinge"],
  },
  {
    n: 18,
    question: "Is this glass supposed to be tempered here?",
    before: "nothing",
    correct: ["term:tempered", "term:safetyglazing"],
  },
  {
    n: 19,
    question: "Tips for a 72×48 slider?",
    before: "app tour",
    correct: ["type:SL7248"],
    useful: ["tip:SL7248:0", "tip:SL7248:1", "tip:SL7248:2", "tip:SL7248:3", "tip:SL7248:4"],
  },
  {
    // A button shipped on the Ask screen. It returned nothing at all before.
    n: 20,
    question: "Single hung tips",
    before: "nothing",
    correct: ["type:SH3252"],
    useful: ["tip:SH3252:0", "tip:SH3252:1", "tip:SH3252:2", "tip:SH3252:3", "tip:SH3252:4"],
  },
  {
    // The other button. It fell through to the app tour before.
    n: 21,
    question: "What is flashing?",
    before: "app tour",
    correct: ["term:flashtape", "term:paperflash", "step:main:4", "step:win:9"],
  },
  {
    n: 22,
    question: "How long should a casement take me?",
    before: "app tour",
    expectMiss: true,
    gap: "No install has ever been logged, so no type has a typical time.",
    useful: ["type:CAS3048", "type:CAS3050"],
  },
  {
    n: 23,
    question: "What's the difficulty on a bay?",
    before: "app tour",
    correct: ["type:BAY7248"],
  },
  {
    n: 24,
    question: "Can I re-use the old sill pan?",
    before: "wrong entry",
    expectMiss: true,
    gap: "Nobody has written the company line on re-using a pan.",
    useful: ["term:sillpan", "term:enddam"],
  },
  {
    n: 25,
    question: "What did Ammon say about this job last week?",
    before: "app tour",
    expectMiss: true,
    gap: "Live job data, not craft knowledge — the one question here that wants a model.",
  },
  {
    n: 26,
    question: "It's raining and the opening is open — what now?",
    before: "app tour",
    expectMiss: true,
    gap: "Rain contingency is unwritten. A foreman can add it in an hour.",
  },
  {
    n: 27,
    question: "What torque on anchors into concrete?",
    before: "app tour",
    expectMiss: true,
    gap: "Anchor torque is unwritten; the anchor schedule covers spacing, not torque.",
    useful: ["term:anchorschedule", "term:embed", "term:perimeterfasten"],
  },
  {
    n: 28,
    question: "Reveal is tight one side — which corner is off?",
    before: "correct",
    correct: ["term:reveal", "term:square", "term:racking"],
  },
];

/** 6 of 28 — the score the shipped code got, from the investigation's table. */
export const SCORE_BEFORE = BRAIN_QUESTIONS.filter((q) => q.before === "correct").length;

/** 17 of 28 — what the investigation predicted a plain keyword index would get. */
export const PREDICTED_SCORE = 17;

/** 21 of 28 — predicted useful somewhere in the three results shown. */
export const PREDICTED_USEFUL = 21;
