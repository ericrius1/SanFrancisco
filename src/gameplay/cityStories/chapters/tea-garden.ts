import type { StoryChapter } from '../types';

export default {
  id: 'tea-garden',
  revision: 1,
  residents: [
    {
      id: 'ruth-okafor',
      speaker: { id: 'ruth-okafor', name: 'Ruth Okafor', title: 'Retired librarian' },
      activity: 'read',
      seed: 'A retired librarian enjoying a mystery outside the Japanese Tea Garden and defending a divisive salad.',
      greeting: `I'm staying outside the Japanese Tea Garden today. One chapter before I go anywhere, I told myself. Unfortunately, somebody's found a second body. This could take longer than I budgeted.`,
      returnGreeting: `There you are again. I've put a bookmark in, so you have my attention. Interrupting a fictional detective is perfectly acceptable; they always seem to need another three chapters regardless.`,
      everyday: {
        question: "A good mystery?",
        text: `The detective hasn't eaten for forty pages. I find that implausible. I was a librarian, so I can forgive many things in a novel, but a person making deductions on an empty stomach ought to get at least half of them wrong.`,
      },
      reflection: {
        question: "What would you feed him?",
        text: `My late husband Peter's beet salad. People assume I bring it to Sunday dinner to keep him with us. A little, yes. Mostly I love beets and too much vinegar. He left me many good things, including a recipe I don't need to turn into a ceremony.`,
      },
      connection: {
        residentId: 'ben-okafor',
        name: 'Ben Okafor',
        place: 'Corona Heights',
        thread: 'sunday-table',
        question: "Does your family cook?",
        unheard: `My son Ben Okafor takes his walks on Corona Heights. He's learning to cook something for Tomas's Sunday table. Ask him about the chickpeas. He has finally stopped treating a recipe as a character reference.`,
        heard: `Ben told you about the chickpeas and his father. Peter could make that one salad and very little else. Ben doesn't have to inherit a set of abilities we mostly invented afterward. I'm looking forward to whatever he learns to make.`,
      },
      farewell: `Enjoy your afternoon. I'll return to this hungry detective. If he accuses the cook, I may take it personally. I've already forgiven him a great deal of poor planning.`,
    },
    {
      id: 'kenji-sato',
      speaker: { id: 'kenji-sato', name: 'Kenji Sato', title: 'Nurse, weekend potter' },
      activity: 'stretch',
      seed: 'A nurse taking a quiet break outside the garden, pleased with a useful but lopsided handmade mug.',
      greeting: `I'm loosening my shoulders before heading home. Outside the Japanese Tea Garden is a good place to pause. I don't work here; the very unceremonious flask of coffee should probably have given me away.`,
      returnGreeting: `Hello again. Still enjoying a little time off my feet, figuratively speaking. I haven't perfected the actual sitting-down part. You're welcome to talk while I work out that advanced technique.`,
      everyday: {
        question: "Long nursing shift?",
        text: `Long enough that I tried my work badge on my own front door recently. I do pottery on weekends. Clay doesn't ask where the remote is, though it does collapse unexpectedly if you get overconfident.`,
      },
      reflection: {
        question: "Made anything you love?",
        text: `A lopsided mug. I dented the handle while it was soft and nearly scrapped it. My daughter tried it and said, "That's where your thumb goes." She's right. It fits my hand. I drink from it every morning, and I'm making more, slowly.`,
      },
      connection: {
        residentId: 'imani-cole',
        name: 'Imani Cole',
        place: 'the Golden Gate Park skate plaza',
        thread: 'repair-circle',
        question: "Other things you make?",
        unheard: `I help at a repair circle with Imani Cole. She skates at the Golden Gate Park skate plaza and knows a remarkable amount about bearings. Ask about her dad calling her fearless. She has a precise correction.`,
        heard: `You've heard Imani explain that she does get scared. I like how plainly she says it. At the repair table she's careful, checks things twice, asks questions. People sometimes praise confidence when they ought to notice preparation.`,
      },
      farewell: `Time to get these shoulders home. Thanks for the company. I hope there's something nice waiting in your day, even if it's only a cup that fits your hand.`,
    },
  ],
} satisfies StoryChapter;
