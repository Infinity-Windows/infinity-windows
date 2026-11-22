import { useState } from "react";
import { matchOption, optionsWith } from "../../lib/install/unitVocabulary";

const ADD = "\u0000add";

/**
 * A select over a short list that can grow: the last choice swaps the select
 * for a text box, and what is typed there becomes the value. A value already
 * set that is not on the list is shown as one more option, never dropped.
 *
 * It renders one control at a time, so it sits inside a <label> like the
 * input it replaces.
 */
export function PickOrAdd({ value, options, onChange, empty = "Not set", addLabel = "Add another…", disabled }: {
  value: string | null | undefined; options: readonly string[]; onChange: (value: string) => void;
  empty?: string; addLabel?: string; disabled?: boolean;
}) {
  const [typing, setTyping] = useState<string>();
  const all = optionsWith(options, value);
  if (typing !== undefined) {
    const done = (keep: boolean) => {
      if (keep && typing.trim()) onChange(matchOption(all, typing));
      setTyping(undefined);
    };
    return <input autoFocus value={typing} placeholder="Type it, then press Enter" disabled={disabled}
      onChange={event => setTyping(event.target.value)} onBlur={() => done(true)}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); done(true); }
        if (event.key === "Escape") { event.stopPropagation(); done(false); }
      }}/>;
  }
  return <select value={matchOption(all, value)} disabled={disabled}
    onChange={event => event.target.value === ADD ? setTyping("") : onChange(event.target.value)}>
    <option value="">{empty}</option>
    {all.map(option => <option key={option} value={option}>{option}</option>)}
    <option value={ADD}>{addLabel}</option>
  </select>;
}
