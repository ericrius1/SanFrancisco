import type { StoryChapter } from '../types';

export default {
  id: 'ocean-beach',
  revision: 1,
  residents: [
    {
      id: 'june-park',
      speaker: { id: 'june-park', name: 'June Park', title: 'Bus operator' },
      activity: 'watch',
      seed: 'A bus operator, Jo’s sister and Tomas’s neighbor, relieved to be an imperfect dinner guest.',
      greeting: `Ocean Beach. No timetable, no request stops, nobody asking whether this water goes downtown. I'm a bus operator. I like people very much, especially after a few minutes of looking at something else.`,
      returnGreeting: `Hi again. I recognize you; you don't have to announce a destination. I'm still letting my shoulders come down. They tend to finish a shift several minutes after the rest of me.`,
      everyday: {
        question: "Good day on the bus?",
        text: `A little boy thanked the bus. Not me, the actual bus. Gave the doorway a small pat. I respected that. It had been working hard, and nobody had complimented its suspension all morning.`,
      },
      reflection: {
        question: "How do you unwind?",
        text: `My neighbor Tomas hosts dinners. Once I was too tired to cook and brought a supermarket pie, still in the plastic dome. I apologized. Ines asked for the corner with the most crust. A round pie. We spent ten minutes arguing geometry, and I stopped being embarrassed.`,
      },
      connection: {
        residentId: 'dev-mehta',
        name: 'Dev Mehta',
        place: 'the Financial District',
        thread: 'sunday-table',
        question: "Who shares the table?",
        unheard: `Dev Mehta takes his lunch breaks in the Financial District. New dad, works in payroll, comes to Tomas's when the baby permits. Ask about his late dinner. It's an excellent review of cold rice.`,
        heard: `Dev told you about the rice? I didn't know it landed quite that way. From my end, there was a tired man holding a sleeping baby and a chair in the wrong place. Sometimes you can solve the whole available problem with your foot.`,
      },
      farewell: `Take your time out here. I'm going to do the same. My sister Jo would call this an inefficient route home, then sit beside me for half an hour.`,
    },
    {
      id: 'sol-rivera',
      speaker: { id: 'sol-rivera', name: 'Sol Rivera', title: 'Dog walker' },
      activity: 'read',
      seed: 'A dog walker who wants drawing with friends to remain a pleasant, unprofitable hobby.',
      greeting: `No dogs with me today. A day off at Ocean Beach, and somehow I still count every leash that passes. I'm Sol. This sketchbook is the only thing I'm currently responsible for getting home.`,
      returnGreeting: `Hey, you made it back this way. I'm having a pencil break. That's mostly like a coffee break, except I already drank the coffee and now there's sand on the lid.`,
      everyday: {
        question: "Favorite part of dog walking?",
        text: `The greetings. Every dog thinks my arrival deserves a parade. The paperwork is less affectionate. I know five different Milos; my phone contacts include Milo Tall, Milo Tiny, and Milo Please Don't, which isn't his legal name.`,
      },
      reflection: {
        question: "Do you sell your drawings?",
        text: `Someone in our sketch group offered to help me sell prints. Kindly meant. But I already turned loving dogs into invoices and keys and cancellation policies. I want to draw a crooked dog, eat crackers, and go home without checking engagement. They understood. We opened another packet.`,
      },
      connection: {
        residentId: 'patti-dunn',
        name: 'Patti Dunn',
        place: 'Marina Green',
        thread: 'roaming-sketchbook',
        question: "How'd you find the group?",
        unheard: `Patti Dunn used to cut my hair. Now she sketches at Marina Green and invites people into our roaming drawing group. Ask her about the portrait with three eyebrows. That's the sort of qualification we accept.`,
        heard: `You know about Patti's three eyebrows, then. She used to remember every customer's preferred parting. Now she gets to forget where a face goes, with friends. I'm happy she has somewhere she doesn't have to make everybody look good.`,
      },
      farewell: `Enjoy the beach. I'm staying until this page is finished or the crackers run out. It's nice having two entirely reasonable stopping points and no client expecting a photograph.`,
    },
  ],
} satisfies StoryChapter;
