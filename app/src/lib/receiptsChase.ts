// Wave Z, Z5: "you bought something on the card and we have no receipt for it".
//
// The push copy stays English by design (the same rule every other push in this
// app follows) — a notification is not a screen, and there is one string.

import { sendPush } from "./permissions/pushServer";
import { formatCents } from "./aiSpend";

export interface ChaseableCharge {
  id: string;
  amountCents: number;
  postedOn: string | null;
  vendorGuess: string | null;
  description: string | null;
}

/**
 * Ask one person for the receipt behind one charge. Fire-and-forget, like every
 * other push: a notification is a nicety, and its failure must never look like
 * the charge itself failed.
 *
 * The deep link opens the receipt camera, so answering is one tap from the
 * notification rather than a hunt through the menu.
 */
export async function askForReceipt(
  profileId: string,
  charge: ChaseableCharge,
): Promise<boolean> {
  const what = charge.vendorGuess ?? charge.description ?? "a purchase";
  const when = charge.postedOn ? ` on ${charge.postedOn}` : "";
  return sendPush({
    profileIds: [profileId],
    title: "We need that receipt",
    body: `${formatCents(charge.amountCents)} at ${what}${when} went on the company card. Snap the receipt when you get a second.`,
    // One per charge: asking twice about the same charge should replace the
    // first notification, not stack a second one on the person's phone.
    tag: `receipt-chase-${charge.id}`,
    url: "/photos?kind=receipt&capture=1",
  });
}
