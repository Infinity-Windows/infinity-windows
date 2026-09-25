// Whether a person hid Ask's action cards, remembered on this phone for them.
//
// The owner, 2026-09-24: "Every time I click the microphone, a lot of other
// options open up when I previously minimized them." Hiding the cards is a
// choice; only the person's own Actions tap undoes it. The key is per account,
// like the conversation id beside it (fieldAsk.ts), so another person signing
// in on the same phone gets their own cards. Only the explicit Hide / Actions
// taps are remembered — typing or a recording puts the cards away for the
// conversation on screen, not for every visit after it.
//
// Every read and write is wrapped: a private window, a locked-down browser or
// a full quota throws on plain localStorage access, and a phone that cannot
// remember simply shows the cards next time.

const key = (userId: string) => `forge.ai-field.cards-hidden.${userId}`;

export function readCardsHidden(userId: string): boolean {
  try {
    return localStorage.getItem(key(userId)) === "1";
  } catch {
    return false;
  }
}

export function rememberCardsHidden(userId: string, hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(key(userId), "1");
    else localStorage.removeItem(key(userId));
  } catch {
    /* the choice still holds for this conversation */
  }
}
