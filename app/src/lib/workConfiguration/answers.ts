import { cloneJson, typedFields, type TypedField } from "./model";

export type AnswerDraftValue = string | boolean | readonly string[] | null;
export type AnswerDraft = Readonly<Record<string, AnswerDraftValue>>;
export type AnswerValue = string | number | boolean | string[];
export type AnswerIssue = "required" | "invalid" | "too_long" | "out_of_range" | "unknown_field" | "invalid_schema";
export type AnswerValidation =
  | { ok: true; values: Record<string, AnswerValue> }
  | { ok: false; errors: Record<string, AnswerIssue> };

/** A wire-ready, fresh copy of answers for one immutable published field schema. */
export function validateActivityAnswers(schema: readonly TypedField[], draft: unknown): AnswerValidation {
  const errors: Record<string, AnswerIssue> = Object.create(null);
  let fields: TypedField[];
  let answers: Record<string, unknown>;
  try {
    fields = typedFields(cloneJson(schema));
    const copied = cloneJson(draft);
    if (copied === null || typeof copied !== "object" || Array.isArray(copied)) throw Error();
    answers = copied as Record<string, unknown>;
  } catch {
    errors._form = "invalid_schema";
    return { ok: false, errors };
  }

  const ids = new Set(fields.map((field) => field.id));
  for (const id of Object.keys(answers)) if (!ids.has(id)) errors[id] = "unknown_field";
  const values: Record<string, AnswerValue> = Object.create(null);
  for (const field of fields) {
    if (!Object.hasOwn(answers, field.id)) {
      if (field.required) errors[field.id] = "required";
      continue;
    }
    const raw = answers[field.id];
    if (raw === null || raw === "") {
      if (field.required) errors[field.id] = "required";
      else if (raw === "" && field.type === "boolean") errors[field.id] = "invalid";
      continue;
    }
    switch (field.type) {
      case "text": {
        if (typeof raw !== "string") { errors[field.id] = "invalid"; break; }
        if (raw.trim().length === 0) {
          if (field.required) errors[field.id] = "required";
          break;
        }
        if ([...raw].length > 500) { errors[field.id] = "too_long"; break; }
        values[field.id] = raw;
        break;
      }
      case "number": {
        if (typeof raw !== "string" || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) {
          errors[field.id] = "invalid"; break;
        }
        const number = Number(raw);
        if (!Number.isFinite(number) || (number === 0 && /[1-9]/.test(raw))) {
          errors[field.id] = "invalid"; break;
        }
        if (field.unit === "count" && (!Number.isSafeInteger(number) || number < 0)) {
          errors[field.id] = "out_of_range"; break;
        }
        if ((field.min !== undefined && number < field.min) || (field.max !== undefined && number > field.max)) {
          errors[field.id] = "out_of_range"; break;
        }
        values[field.id] = number;
        break;
      }
      case "boolean":
        if (typeof raw === "boolean") values[field.id] = raw;
        else errors[field.id] = "invalid";
        break;
      case "single_select":
        if (typeof raw !== "string" || !field.options?.some((option) => option.id === raw)) errors[field.id] = "invalid";
        else values[field.id] = raw;
        break;
      case "multi_select": {
        if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
          errors[field.id] = "invalid"; break;
        }
        if (raw.length === 0) {
          if (field.required) errors[field.id] = "required";
          break;
        }
        const known = new Set(field.options?.map((option) => option.id));
        if (raw.length > 50 || new Set(raw).size !== raw.length || raw.some((item) => !known.has(item))) {
          errors[field.id] = "invalid"; break;
        }
        values[field.id] = [...raw];
        break;
      }
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}
