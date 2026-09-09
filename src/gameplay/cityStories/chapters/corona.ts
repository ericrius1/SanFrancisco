import type { StoryChapter } from '../types';

export default {
  id: 'corona',
  revision: 1,
  residents: [
    {
      id: 'ben-okafor',
      speaker: { id: 'ben-okafor', name: 'Ben Okafor', title: 'Bookkeeper, novice cook' },
      activity: 'stretch',
      seed: 'Ruth’s son, a bookkeeper learning to cook for friends without measuring himself against his father.',
      greeting: `I'm catching my breath. Corona Heights is quite committed to being a height. Ben. I do this walk because my work involves sitting, and my hobbies have been suspiciously supportive of that arrangement.`,
      returnGreeting: `Hello again. I've made peace with the climb for now. You're welcome to pause here with me. We can call it appreciating the view, which is both true and flattering.`,
      everyday: {
        question: "What's for dinner?",
        text: `Chickpeas, if all goes well. Chickpeas with a different texture if it doesn't. I'm a bookkeeper, so I followed the recipe's quantities beautifully. The instruction "cook until ready" feels like a lapse in professional standards.`,
      },
      reflection: {
        question: "Why start cooking?",
        text: `After Dad died, I remembered him as a man who could do everything. I felt hopeless bringing nothing to Tomas's dinners. Mum reminded me he made one beet salad and routinely burned toast. So I'm learning chickpeas. My own one thing, with room for a second later.`,
      },
      connection: {
        residentId: 'celia-torres',
        name: 'Celia Torres',
        place: 'the northeastern bayfront',
        thread: 'sunday-table',
        question: "Who tries your recipes?",
        unheard: `Celia Torres walks on the northeastern bayfront after her electrical shifts. She's another regular at Tomas's irregular table. Ask her about arriving with an empty dish. That story took some pressure off my chickpeas.`,
        heard: `You've heard Celia's empty-dish story. I keep thinking about her showing up anyway. I still want to cook something good for everybody. It's easier to learn when a disappointing saucepan won't cost you your place at dinner.`,
      },
      farewell: `I'll head down in a bit. There are chickpeas depending on my eventual return, though thankfully not on my speed. Good talking with you up here. Enjoy the view.`,
    },
    {
      id: 'bea-santos',
      speaker: { id: 'bea-santos', name: 'Bea Santos', title: 'Building cleaner' },
      activity: 'read',
      seed: 'A building cleaner drawing the lived city, including her unremarkable apartment and favorite laundromat.',
      greeting: `I'm trying to find my own roof from Corona Heights. You'd think living under a thing would help you identify its top. Apparently I should have been paying attention from a different angle.`,
      returnGreeting: `Hi again. I've stopped hunting for the roof for a minute. It's good to look up from a page now and then. The actual city has better ventilation than my drawing.`,
      everyday: {
        question: "What goes in your sketchbook?",
        text: `Buildings, usually after I've finished cleaning somebody else's. I draw with a group on my days off. Arthur helps me with lettering. My first attempt at "laundromat" ran out of wall, so the place became a laundro.`,
      },
      reflection: {
        question: "Why draw your own roof?",
        text: `I drew all the famous buildings first. Then I noticed my own block was blank. So I added our apartment, the laundromat, the shop that lets me leave a spare key. The page got crowded. I like seeing how much of my life fits in that supposedly empty bit.`,
      },
      connection: {
        residentId: 'estelle-price',
        name: 'Estelle Price',
        place: 'Lands End',
        thread: 'roaming-sketchbook',
        question: "Who else draws buildings?",
        unheard: `Estelle Price used to photograph properties. Now she draws with us and walks at Lands End. Ask what she used to keep outside the frame. I recognized a lot of my favorite subjects on her list.`,
        heard: `Estelle told you about finally drawing the wet dog. I used to clear cleaning supplies out of photographs for people like her. These days she asks where I'd leave the bucket in a picture. Usually where I'm going to need it.`,
      },
      farewell: `I'm going to give that roof another look. Enjoy the rest of the hill. If you spot someone squinting fiercely at a very ordinary building, it may be another resident.`,
    },
  ],
} satisfies StoryChapter;
