import type { StoryChapter } from '../types';

export default {
  id: 'skate-plaza',
  revision: 1,
  residents: [
    {
      id: 'mika-chen',
      speaker: { id: 'mika-chen', name: 'Mika Chen', title: 'Grocery clerk, clarinet learner' },
      activity: 'stretch',
      seed: 'A grocery clerk who enjoys skating and is learning clarinet with Ada’s workroom band.',
      greeting: `Taking a breather. The Golden Gate Park skate plaza has an excellent selection of things to try again. I'm Mika. If my knees creak, that's just the soundtrack, no need to applaud.`,
      returnGreeting: `Hey, familiar face. I'm between attempts, which is where I spend a healthy percentage of this hobby. Happy to talk for a bit. Gives my legs a plausible excuse.`,
      everyday: {
        question: "What else do you do?",
        text: `Grocery shifts, clarinet, laundry when the situation becomes diplomatic. I'm in Ada's band. I used to think reeds were expensive little bits of wood. Now I have opinions about expensive little bits of wood. It's a full education.`,
      },
      reflection: {
        question: "What keeps you playing?",
        text: `Ada had me hold one note instead of rushing the whole tune. I expected everyone to get bored. Walter stayed with me on the keyboard; Ada waited, then nodded. I work all day getting a line of people moving. It felt strange and good to be allowed that long.`,
      },
      connection: {
        residentId: 'ada-bell',
        name: 'Ada Bell',
        place: 'Coit Tower',
        thread: 'workroom-band',
        question: "Where can I meet Ada?",
        unheard: `Ada Bell likes the view up at Coit Tower. Retired music teacher, still conducts our band with one eyebrow if her hands are busy. Ask her about leading from a chair. She notices more than most people on their feet.`,
        heard: `You've heard Ada's side of that note. I hadn't thought about her needing the nod back, too. From my chair she was absolutely still the teacher. You can stop marching and keep everybody together.`,
      },
      farewell: `I'm going to try another run. Or watch someone else do one and claim I'm studying technique. Either way, thanks for hanging out while my legs reconsidered their position.`,
    },
    {
      id: 'imani-cole',
      speaker: { id: 'imani-cole', name: 'Imani Cole', title: 'Student, skateboard tinkerer' },
      activity: 'watch',
      seed: 'A student and careful skater teaching her appliance-repairing dad to let her finish.',
      greeting: `You can watch from here without being in anybody's line. I'm waiting for a turn, not claiming the entire skate plaza through intense staring. Apparently my face makes that distinction unclear.`,
      returnGreeting: `Oh, hey again. Still keeping an eye on the flow before I go. You don't have to remember anybody's tricks to hang out here. I barely remember which pocket has my tool.`,
      everyday: {
        question: "You repair boards?",
        text: `Mostly my own, and friends' wheels when they ask. Dad repairs appliances; we go to a monthly repair circle together. He labels every compartment in his toolbox. I label mine by remembering what made the stain.`,
      },
      reflection: {
        question: "Ever get nervous?",
        text: `Of course. Dad used to introduce me as fearless. I told him, "I'm scared pretty often. I check the board, watch the landing, decide." He's started saying careful instead. I like that better. If I'm not feeling a run, I can stop without disappointing the fearless girl.`,
      },
      connection: {
        residentId: 'vic-cole',
        name: 'Vic Cole',
        place: 'Mission Dolores',
        thread: 'repair-circle',
        question: "What's your dad like?",
        unheard: `Vic Cole. He walks near Mission Dolores between appliance calls. He's funny when he isn't explaining something I already know. Ask about our bearing lesson. He'll tell it fairly; that's one of the good things about him.`,
        heard: `Dad told you about sitting on his hands during the bearing lesson? I saw him doing it. Thought he was cold. He stayed all the way through, though, and asked a real question at the end. I'll happily teach him again.`,
      },
      farewell: `I'm going to keep watching for a gap. Enjoy the park. If you hear cheering, it might be for somebody finally getting up after a very ordinary, very annoying miss.`,
    },
  ],
} satisfies StoryChapter;
