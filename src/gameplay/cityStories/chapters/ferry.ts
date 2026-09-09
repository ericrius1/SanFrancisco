import type { StoryChapter } from '../types';

export default {
  id: 'ferry',
  revision: 1,
  residents: [
    {
      id: 'ines-navarro',
      speaker: { id: 'ines-navarro', name: 'Ines Navarro', title: 'Retired baker' },
      activity: 'watch',
      seed: 'A retired baker on the Embarcadero, learning to arrive at the Sunday table empty-handed.',
      greeting: `That bag smells like bread, yes. Retirement hasn't cured me of buying too much. I come down to the Embarcadero to watch people hurry toward boats. Very restful, somebody else's hurry.`,
      returnGreeting: `Hello again. I've moved the bread out of the wind, which makes me its chauffeur, apparently. There's room to stand here if you'd like another minute by the water.`,
      everyday: {
        question: "Still baking?",
        text: `Small batches. My oven at home has opinions the bakery oven never dared express. Left side burns, right side sulks. I turn the tray halfway through and call it a relationship. The neighbors accept the evidence.`,
      },
      reflection: {
        question: "How is retirement?",
        text: `I thought leaving the bakery meant people would stop needing me. So I brought three loaves to every dinner at my son Tomas's. Finally he said, "Mama, you have a chair even without bread." I'm practicing. Last time I brought just butter. He counted that as progress.`,
      },
      connection: {
        residentId: 'tomas-navarro',
        name: 'Tomas Navarro',
        place: 'Mission Dolores',
        thread: 'sunday-table',
        question: "Tomas hosts dinner?",
        unheard: `My son Tomas Navarro takes his walks near Mission Dolores. He's a night nurse and the keeper of our very irregular Sunday table. Ask him about the extra chair. He has strong feelings about attendance sheets.`,
        heard: `So you've heard how Tomas stopped counting who came. When he first hosted, he ironed napkins. Now sometimes we use paper towels. I enjoy the food more these days. He actually sits down with us.`,
      },
      farewell: `Enjoy your walk. If you buy bread, squeeze it very gently. Somebody got up at an unreasonable hour to put those little air pockets in there.`,
    },
    {
      id: 'jo-park',
      speaker: { id: 'jo-park', name: 'Jo Park', title: 'Bicycle courier' },
      activity: 'stretch',
      seed: 'A bicycle courier with a repeatedly repaired bag and a practical affection for the repair circle.',
      greeting: `I'm off the clock. That's why I'm standing still without looking furious about it. The Embarcadero is good for stretching calves and watching other people discover that their jackets aren't windproof.`,
      returnGreeting: `Hey, you again. Still taking my break. I could leave, but then I'd have to stop calling this a break and start calling it a very slow journey. Want to chat?`,
      everyday: {
        question: "What's in the bag?",
        text: `Right now? A sandwich, two spare tubes, and a banana undergoing a career change. Usually documents. People imagine mysterious packages, but it's mostly signatures that apparently can't cross town without a person attached to them.`,
      },
      reflection: {
        question: "That bag has history?",
        text: `Mom patched it with yellow thread because that was what she had. I used to turn that side inward. Now I take it to our repair circle and match her enormous stitches. She's delighted. Calls it her collaboration with the transportation industry. I like carrying something she handled.`,
      },
      connection: {
        residentId: 'eddie-salazar',
        name: 'Eddie Salazar',
        place: 'the Financial District',
        thread: 'repair-circle',
        question: "Who else repairs things?",
        unheard: `Eddie Salazar, a building porter in the Financial District, comes to our monthly repair circle. He usually takes his break outside there. He's been nursing a little radio along. For once, the repair ticket has his own name on it.`,
        heard: `You heard about Eddie's radio, then. At the circle he used to fix everybody else's stuff first. Now there's a little square of table he keeps for himself. I park my bag somewhere else. That space is spoken for.`,
      },
      farewell: `I'm going to investigate whether that banana is still lunch. Have a good one, and give turning bicycles a little room. Some of us are transporting soup.`,
    },
  ],
} satisfies StoryChapter;
