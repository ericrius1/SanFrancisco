import type { StoryChapter } from '../types';

export default {
  id: 'lands-end',
  revision: 1,
  residents: [
    {
      id: 'nell-foster',
      speaker: { id: 'nell-foster', name: 'Nell Foster', title: 'Hardware clerk, songwriter' },
      activity: 'read',
      seed: 'A hardware clerk writing cheerfully specific songs for the workroom band.',
      greeting: `If you hear me repeating "waterproof," I'm working on a song. Lands End gives you material. Unfortunately, most of it rhymes with roof, and I've already written more about roofing than the public needs.`,
      returnGreeting: `You again. Don't worry, there's no compulsory performance. I've put the notebook away for a bit. Some lyrics improve after you stop staring at them; these are being given every opportunity.`,
      everyday: {
        question: "What kind of songs?",
        text: `Short ones for our band. I work in a hardware shop, so the vocabulary is sturdy. My masterpiece involves a man who buys the wrong washer three times. Audiences in plumbing understand the stakes immediately.`,
      },
      reflection: {
        question: "Ever write something personal?",
        text: `I wrote a love song about Walter's terrible raincoat. He wore it on our first date. One cuff filled with water and emptied into his soup. I tried replacing that with something grander, but he said, "Keep the soup." That's the song the band plays.`,
      },
      connection: {
        residentId: 'walter-foster',
        name: 'Walter Foster',
        place: 'Sutro Baths',
        thread: 'workroom-band',
        question: "Where's Walter?",
        unheard: `My husband Walter Foster likes walking by Sutro Baths. Retired piano tuner, plays keys with us when there are keys available. We married later in life. Ask him about our two breakfast radios; it's his favorite domestic arrangement.`,
        heard: `So Walter explained the two radios. He gets his sports, I get my weather, and neither of us has to become the person the other imagined. We meet over toast. He's very particular about leaving me the end piece.`,
      },
      farewell: `Watch your footing out there. I'm going back to my rhyme problem. If nothing fits, I can always change the coat. Walter himself is harder to revise.`,
    },
    {
      id: 'estelle-price',
      speaker: { id: 'estelle-price', name: 'Estelle Price', title: 'Retired property photographer' },
      activity: 'watch',
      seed: 'A retired property photographer drawing things that would once have spoiled her professional pictures.',
      greeting: `I've spent ten minutes trying to draw that untidy bit of path. Lands End is full of subjects that refuse to look move-in ready. After years of property photography, I find that refreshing.`,
      returnGreeting: `Ah, hello again. I'm resting my eyes. There is no slideshow waiting, I promise. We can simply look around without my explaining what an interesting composition everything might become.`,
      everyday: {
        question: "Still taking photographs?",
        text: `Family ones. Professionally I made small rooms look hopeful. Now I draw with a group that wanders around town. Nobody's trying to sell the result, though Patti says my trees could pass for very affordable coat racks.`,
      },
      reflection: {
        question: "What changed after retirement?",
        text: `I used to wait for the wet dog to leave the picture. Now I draw the wet dog. Mud on the path, a bent fence, somebody's ungainly shopping bag. I'm surprised how much of the world I learned to leave out because it might put a buyer off.`,
      },
      connection: {
        residentId: 'finn-price',
        name: 'Finn Price',
        place: 'Sutro Baths',
        thread: 'roaming-sketchbook',
        question: "Any family in the group?",
        unheard: `My grandson Finn Price joins us between college classes. He's often sketching rocks at Sutro Baths. He studies geology and is wonderfully patient with my invented rock names. Ask about the drawing he corrected for me.`,
        heard: `Finn told you I kept his correction. Of course I did. He showed me where the layers actually ran. I get to know somebody new inside the grandson I've known for years. He's allowed to know things I don't.`,
      },
      farewell: `Enjoy the path. I think I'll give that bent fence another try. It's been standing there without my approval for quite some time and seems to be managing.`,
    },
  ],
} satisfies StoryChapter;
