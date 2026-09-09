import type { StoryChapter } from '../types';

export default {
  id: 'golden-gate',
  revision: 1,
  residents: [
    {
      id: 'theo-bennett',
      speaker: { id: 'theo-bennett', name: 'Theo Bennett', title: 'Tax preparer, bass player' },
      activity: 'stretch',
      seed: 'Gus’s son, a tax preparer learning to enjoy playing alongside his beginner-drummer father.',
      greeting: `I'm stretching my back before walking farther along the pedestrian approach. Tax preparation makes a person comma-shaped. The Golden Gate Bridge is an excellent excuse to stand up straight and look away from decimals.`,
      returnGreeting: `Hello again. I've put the calculations on hold. They were going in circles anyway. Nice to see someone I recognize out here without immediately wondering whether I owe them a document.`,
      everyday: {
        question: "How do you switch off?",
        text: `Bass guitar. Our band rehearses in a sewing workroom, so occasionally a measuring tape gets mistaken for a cable. My dad's learning drums. Between us, the rhythm section brings punctuality and an alarming quantity of snacks.`,
      },
      reflection: {
        question: "What's playing with your dad like?",
        text: `Dad taught me to drive. I thought teaching him drums would square things somehow, though I'm no drummer. I kept arriving with advice. One visit I left the bass in its case and just listened to him practice. We had a much better afternoon. He already has a teacher.`,
      },
      connection: {
        residentId: 'nell-foster',
        name: 'Nell Foster',
        place: 'Lands End',
        thread: 'workroom-band',
        question: "Who writes your music?",
        unheard: `Nell Foster writes songs for us. Hardware clerk, usually working on lyrics during her walks at Lands End. Ask her about the raincoat song. I get to play a very dignified bass line under an incident involving soup.`,
        heard: `You've heard about Walter's cuff and the soup. Nell tried a more elegant lyric once. We all missed the original, especially Walter. I like being in a band where the love song is recognizable to the person it's about.`,
      },
      farewell: `Time for a bit more walking. Thanks for helping me spend a few minutes without calculating anything. I'll try not to ruin it by estimating how many steps remain.`,
    },
    {
      id: 'lena-ortiz',
      speaker: { id: 'lena-ortiz', name: 'Lena Ortiz', title: 'Bus dispatcher' },
      activity: 'read',
      seed: 'A bus dispatcher drawing passing visitors without asking them to hold still.',
      greeting: `You're fine where you are. I'm sketching people as they pass the Golden Gate Bridge pedestrian approach, but I don't expect anyone to pose. You came for the bridge, presumably, rather than unpaid modeling.`,
      returnGreeting: `Hello again. I remember you, though that doesn't mean I've secretly drawn a portrait. My pages are mostly sleeves and the beginnings of hats. Happy to take a break and talk.`,
      everyday: {
        question: "Why sketch here?",
        text: `At work I dispatch buses and keep track of where everybody ought to be. Out here I let people wander through the page. Also, the jackets are terrific. People pack for four seasons and sometimes wear them all at once.`,
      },
      reflection: {
        question: "Why leave the coats unfinished?",
        text: `I used to get annoyed when someone walked off before I finished drawing them. Then I heard myself: stranger demands stranger stand still for hobby. Now I keep the half-drawn coats. They were going somewhere. I like leaving that visible instead of inventing the rest.`,
      },
      connection: {
        residentId: 'arthur-ng',
        name: 'Arthur Ng',
        place: 'the northeastern bayfront',
        thread: 'roaming-sketchbook',
        question: "Do you draw with friends?",
        unheard: `Arthur Ng from our sketch group draws along the northeastern bayfront. He used to paint signs. His lettering is still wonderful, but he uses a much fatter marker these days. Ask about the name at the bottom of his pages.`,
        heard: `Arthur told you why he's signing the new drawings. I enjoy finding that broad, wobbly name at the bottom. All those years making other people's names visible. It's good having his on the page we pass around.`,
      },
      farewell: `Off you go; I won't object on artistic grounds. I'll see what the next set of jackets brings. Thanks for stopping of your own accord for a little while.`,
    },
  ],
} satisfies StoryChapter;
