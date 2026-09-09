import type { StoryChapter } from '../types';

export default {
  id: 'bayfront',
  revision: 1,
  residents: [
    {
      id: 'celia-torres',
      speaker: { id: 'celia-torres', name: 'Celia Torres', title: 'Electrician' },
      activity: 'watch',
      seed: 'An electrician with irregular shifts, learning that the Sunday table welcomes an empty-handed guest.',
      greeting: `Celia. I'm taking the long way home along the northeastern bayfront. After a shift looking inside walls, I like a view with a little depth to it. And considerably fewer wires.`,
      returnGreeting: `Hey again. I'm still enjoying the open air. No rush on my end for a minute. It's pleasant recognizing somebody out here without having to remember which toolbox they borrowed.`,
      everyday: {
        question: "What kind of electrical work?",
        text: `Commercial maintenance, awkward hours. I label everything. My freezer has a container marked "soup, probably lentil, confirmed edible." Work habits follow you home. My friends at Sunday dinner say my leftovers come with better documentation than most buildings.`,
      },
      reflection: {
        question: "Do shifts make dinner difficult?",
        text: `Once I carried an empty serving dish all the way to Tomas's. I'd meant to buy something, ran late, forgot. I nearly turned around outside. Ines took the dish, filled it with potatoes, and handed it back. I was a guest before I remembered how to be one.`,
      },
      connection: {
        residentId: 'ines-navarro',
        name: 'Ines Navarro',
        place: 'the Embarcadero',
        thread: 'sunday-table',
        question: "Who is Ines?",
        unheard: `Ines Navarro, Tomas's mother, likes watching the ferries from the Embarcadero. Retired baker. She made it easy for me to come to dinner without bringing anything. Ask how she's finding that arrangement herself.`,
        heard: `You've heard Ines is practicing arriving without bread. She made that so easy for me, and it's hard for her. Next time I see her butter dish on the table, I'll understand the effort behind how little it holds.`,
      },
      farewell: `I'll keep walking a little. Thanks for the conversation. I hope whatever's waiting for you is clearly labeled, or at least more exciting than a container of probable lentils.`,
    },
    {
      id: 'arthur-ng',
      speaker: { id: 'arthur-ng', name: 'Arthur Ng', title: 'Retired sign painter' },
      activity: 'read',
      seed: 'A retired sign painter adapting his drawing tools and finally putting his own name on the page.',
      greeting: `I'm drawing along the northeastern bayfront. Thick marker, big notebook. It makes everything look like it might be advertising fish, which is a difficult habit to break after years of painting signs.`,
      returnGreeting: `Good to see you again. I've capped the marker; it can wait. Nothing here needs its opening hours painted on a window by five, so we have some breathing room.`,
      everyday: {
        question: "What signs did you paint?",
        text: `Shop windows, delivery vans, menus. You learn exactly how much space a word takes. "Fresh" fits almost anywhere. "Refrigeration" will ruin your afternoon if you've started too far to the right. Bea from our sketch group appreciates that problem now.`,
      },
      reflection: {
        question: "Why the thick marker?",
        text: `My hand shakes more now. A fine brush makes me argue with every line, so I use this broad marker. For years I painted other people's names and left mine off. These drawings get a large, wobbly "Arthur." I'm pleased to be responsible for them.`,
      },
      connection: {
        residentId: 'bea-santos',
        name: 'Bea Santos',
        place: 'Corona Heights',
        thread: 'roaming-sketchbook',
        question: "Who is Bea?",
        unheard: `Bea Santos draws with us. She works cleaning buildings and likes looking for her own roof from Corona Heights. Ask about the blank part of her city drawing. She found quite a lot to put there.`,
        heard: `You know how Bea filled in her own block. She asked me to help fit "laundromat" on its wall. We made the letters smaller and got the whole word in. She knows that place better than any of the towers.`,
      },
      farewell: `Take care. I'll put a few more lines down before heading home. If they're crooked, they're crooked. I've got plenty of ink left and nowhere that needs to approve them.`,
    },
  ],
} satisfies StoryChapter;
