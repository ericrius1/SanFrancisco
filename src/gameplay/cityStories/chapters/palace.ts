import type { StoryChapter } from '../types';

export default {
  id: 'palace',
  revision: 1,
  residents: [
    {
      id: 'farah-aziz',
      speaker: { id: 'farah-aziz', name: 'Farah Aziz', title: 'Seamstress, amateur trumpeter' },
      activity: 'watch',
      seed: 'A confident seamstress and tentative trumpet player whose workroom hosts the neighborhood band.',
      greeting: `I'm looking at the way those columns meet the sky. Occupational habit. At the Palace of Fine Arts, even the hems are enormous. Please don't ask how much I'd charge for alterations.`,
      returnGreeting: `Hello again. I'm still giving the architecture a free fitting. No pins required. If you'd like to stand and look a while, I promise to leave your sleeve length out of it.`,
      everyday: {
        question: "Busy at the workroom?",
        text: `Wedding season seems to have become an all-year subscription. Then our band rehearses after closing. I put a sheet over the gowns. No bride has ordered a dress with a light dusting of Gus's drumstick varnish.`,
      },
      reflection: {
        question: "How's the trumpet?",
        text: `At work I know exactly where to put my hands. With the trumpet, I'm a beginner who goes red before making a sound. I nearly gave up my little solo. Gus learned to leave a space for it. Now I try, even when the first note comes out furry.`,
      },
      connection: {
        residentId: 'gus-bennett',
        name: 'Gus Bennett',
        place: 'Marina Green',
        thread: 'workroom-band',
        question: "Who's Gus?",
        unheard: `Gus Bennett, our drummer, stretches out at Marina Green. He used to drive buses. He brings the same concern for everyone's safe arrival to a very short waltz. Ask him about his four bars of silence.`,
        heard: `So you know about Gus counting on his fingers. From my chair I can see his knuckles moving. It makes the entrance less frightening, having somebody quietly doing arithmetic so there's room for my small noise.`,
      },
      farewell: `Enjoy the Palace. I'm going to look a little longer before returning to things that need shortening. It's pleasant being near something whose measurements are somebody else's problem.`,
    },
    {
      id: 'agnes-wu',
      speaker: { id: 'agnes-wu', name: 'Agnes Wu', title: 'Retired mechanical drafter' },
      activity: 'read',
      seed: 'A retired mechanical drafter practicing patient teaching at the community repair circle.',
      greeting: `I'm sketching a hinge, if you're curious. Yes, at the Palace of Fine Arts. Everyone gets the columns; somebody ought to give the small working parts a little attention too.`,
      returnGreeting: `Good to see you again. I've closed the notebook for now. My hand requested a recess, and after years of drawing straight lines for me, it's entitled to a hearing.`,
      everyday: {
        question: "Why hinges?",
        text: `A good hinge is a satisfying arrangement. A bad hinge announces itself every time you want a biscuit. I keep diagrams for our repair circle. My grandson says my notebook is all doors to very boring treasure.`,
      },
      reflection: {
        question: "Do you enjoy teaching?",
        text: `I used to take the tool away and finish the job. Quick, accurate, dreadful teaching. Now at the repair circle I put my hands under my thighs when somebody struggles. It's undignified. It works. They leave knowing how to do something, rather than knowing how fast I can.`,
      },
      connection: {
        residentId: 'kenji-sato',
        name: 'Kenji Sato',
        place: 'outside the Japanese Tea Garden',
        thread: 'repair-circle',
        question: "Who comes to the circle?",
        unheard: `Kenji Sato, a nurse who makes pottery, likes a breather outside the Japanese Tea Garden. He comes to our repair circle with excellent questions. His favorite mug would give a manufacturing inspector a difficult morning.`,
        heard: `You've heard about the thumb hollow in Kenji's mug. On a drawing I might have corrected that contour. He showed me how he holds it, and my proposed correction disappeared. Useful to meet the hand before improving the handle.`,
      },
      farewell: `I'll return to my hinge. Thank you for the company. If a door squeaks on your travels, you needn't feel responsible for it. I'm practicing that myself.`,
    },
  ],
} satisfies StoryChapter;
