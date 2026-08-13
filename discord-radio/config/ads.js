// Commercials. The between-song parody ads are half of what makes a GTA-style
// station feel alive. These are original spoofs — swap in your own freely.
// Each ad is a short read (1–3 sentences) voiced in the ad break.

export const ADS = [
  "Tired of having feelings? Try NUMB, the energy drink that replaces them with a mild, pleasant buzzing sound. NUMB — because coping is a skill you clearly do not have.",

  "At Stashaway Self Storage, your belongings are safe. From you. Forever. We, uh, misplaced the master key. Stashaway — it was probably junk anyway.",

  "New from Fondle Cosmetics: a fragrance that smells exactly like a mid-size rental car. It's called Courtesy Vehicle. Turn heads — then apologize to them.",

  "Legal trouble? Counter-sue with Brisket and Brisket, the only law firm that is also a smokehouse. We settle out of court and over a full rack of ribs. Brisket and Brisket: justice is best served slow.",

  "Introducing the Vroomba electric scooter, with the turning radius of a cruise ship and the brakes of a polite suggestion. Vroomba — you will get there eventually, structurally speaking.",

  "Feeling watched? Good news: now you can watch back, with the new PryPhone Twelve, the phone that films you filming it. PryPhone — privacy is a lifestyle you simply cannot afford.",

  "Try the Notice Diet: eat whatever you want, then think about it, constantly, forever. Results not typical. Nothing about you is typical. The Notice Diet — from the people who made you like this.",

  "First Interchangeable Bank took your money and turned it into a slightly taller building. Ask us about our exciting new fee for asking about fees. First Interchangeable: your money, our vibes.",

  "PseudoCola Zero Zero: all of the cola, none of the cola. It is, essentially, just the can. PseudoCola — hydrate on the concept.",

  "Come on down to Deluxe Preowned Autos, where the cars are gently used and the salesman is loudly used. Financing available to absolutely no one. Deluxe Preowned — he's crying, but the deals are real.",

  "Is your home too quiet? Adopt a Screaming Gourd, the decorative squash that shrieks at random intervals. Comes with a gourd. Does not come with an off switch. Screaming Gourd — you asked for this.",

  "Upgrade to Meaningful Premium, the subscription that adds a subtle sense of purpose to your day for only nineteen ninety-nine a month. Cancel anytime and feel it drain away instantly. Meaningful — life, but sponsored.",
];

export function pickAd() {
  return ADS[Math.floor(Math.random() * ADS.length)];
}
