import type { StoryChapter } from '../types';

export default {
  id: 'downtown',
  revision: 1,
  residents: [
    {
      id: 'dev-mehta',
      speaker: { id: 'dev-mehta', name: 'Dev Mehta', title: 'Payroll clerk, new dad' },
      activity: 'chat',
      seed: 'A new father on his lunch break, exact about payroll and wonderfully inexact about sleep.',
      greeting: `If I look like I'm checking the markets, I'm actually looking at a photo of my baby wearing one sock. Financial District camouflage. The serious face means I'm wondering where the other sock went.`,
      returnGreeting: `Hey, familiar face. Give me a second to put the phone away. Nothing urgent; I've just become the kind of man who needs twelve pictures of the same yawn.`,
      everyday: {
        question: "How's the workday?",
        text: `Payroll. I catch small mistakes before they become somebody's terrible Friday. Then I go home and fasten a diaper backward. Different departments. My wife says the baby should submit a correction form, but his handwriting is atrocious.`,
      },
      reflection: {
        question: "Getting any time out?",
        text: `We reached Tomas's Sunday dinner two hours late with the baby finally asleep. I stood in the doorway apologizing. June handed me a bowl of cold rice and moved a chair with her foot. Nobody woke him to admire him. I nearly cried into the rice. Ate it first, though.`,
      },
      connection: {
        residentId: 'lila-mehta',
        name: 'Lila Mehta',
        place: 'Salesforce',
        thread: 'sunday-table',
        question: "Family nearby?",
        unheard: `My sister Lila Mehta works in facilities around Salesforce. You'll find her taking a breather there. I got her coming to Tomas's dinners. She can arrange a room for forty people; sitting down as a guest takes more effort.`,
        heard: `So Lila told you about dinner without the job introductions. She was the funnier sibling long before she had a badge and a calendar. It's nice hearing that particular laugh across the table again. It carries through a crying baby.`,
      },
      farewell: `Back to the numbers for me. Enjoy having both hands free, if you do. I'd forgotten you could eat a sandwich without negotiating with another person's entire body.`,
    },
    {
      id: 'eddie-salazar',
      speaker: { id: 'eddie-salazar', name: 'Eddie Salazar', title: 'Building porter' },
      activity: 'watch',
      seed: 'A dependable porter reserving a little of his repair skill for his own pleasure.',
      greeting: `I'm on break, so unless that skyline needs a lightbulb changed, we're fine. Eddie. I work in one of these buildings. Outside, they all look expensive. Inside, there's always a bucket somewhere.`,
      returnGreeting: `Oh, hello again. Still enjoying the part of the building with no ceiling. You can stand here with me; the pigeon hasn't paid rent on this patch of sidewalk either.`,
      everyday: {
        question: "Busy building?",
        text: `Someone put a plant under a hand dryer because it needed warmth. Someone else reported the plant for obstructing equipment. I moved it to a window. That's two tickets closed and one very surprised fern.`,
      },
      reflection: {
        question: "What do you fix for yourself?",
        text: `An old radio. Nothing special, just mine. At our repair circle I kept setting it aside to help other people. Now I give it the first half hour. I want music while I make breakfast. That's a good enough reason to have my own screwdriver for thirty minutes.`,
      },
      connection: {
        residentId: 'rosa-salazar',
        name: 'Rosa Salazar',
        place: 'Coit Tower',
        thread: 'repair-circle',
        question: "Who taught you?",
        unheard: `My aunt Rosa Salazar does upholstery. She likes checking her fabric colors in the light by Coit Tower. She's in our repair circle too. Ask about her orange chair if you'd like to see a woman defend a purchase.`,
        heard: `Ah, you heard Rosa's declaration about the chair. I was the nephew asking whether it would sell. Occupational hazard: I see a finished thing and look for its owner. That one's owner is extremely happy, coffee stains included.`,
      },
      farewell: `Good talking. I'm going to finish this break before anyone makes eye contact with a request. Hope the next door you try opens without any special instructions.`,
    },
  ],
} satisfies StoryChapter;
