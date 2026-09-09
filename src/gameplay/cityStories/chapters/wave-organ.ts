import type { StoryChapter } from '../types';

export default {
  id: 'wave-organ',
  revision: 1,
  residents: [
    {
      id: 'nico-bell',
      speaker: { id: 'nico-bell', name: 'Nico Bell', title: 'Sound recordist' },
      activity: 'watch',
      seed: 'A sound recordist collecting domestic and waterfront sounds for his aunt Ada’s amateur band.',
      greeting: `You can talk. I'm not recording at the moment. People see headphones at the Wave Organ and start apologizing for having shoes. Footsteps are allowed. Mine make that rubber-duck noise when they're wet.`,
      returnGreeting: `Hey again. Headphones are off; you've got my attention. I'm just spending a little time out here, listening without saving anything. It's nice to see a familiar face. No need to whisper.`,
      everyday: {
        question: "What do you record?",
        text: `Water, mostly, today. For paid work, people saying sentences about software with great conviction. I'm making a little sound piece for my aunt's band between jobs. Waves don't ask to sound more approachable on the third take.`,
      },
      reflection: {
        question: "A favorite recording?",
        text: `Aunt Ada's kettle switching off, then her laugh in the next room. I was testing a microphone. I kept trying to clean the click out before realizing that's the sound of being at her place: tea nearly ready, somebody already amused. It stays in the piece.`,
      },
      connection: {
        residentId: 'farah-aziz',
        name: 'Farah Aziz',
        place: 'the Palace of Fine Arts',
        thread: 'workroom-band',
        question: "Who will play it?",
        unheard: `Farah Aziz plays trumpet in Ada's band and lends us her sewing workroom. She takes walks at the Palace of Fine Arts. She's learning a solo; she'll give you a much more interesting account than the sheet music does.`,
        heard: `You've heard Farah's side of that solo. When she calls the first note furry, I know exactly what she means. On a recording you hear the breath before it too. I'd ask her before keeping either. It's her entrance.`,
      },
      farewell: `Thanks for stopping. I'll put these back on and see what the water's doing. You don't have to tiptoe away; an ordinary departure is a perfectly respectable sound.`,
    },
    {
      id: 'omar-haddad',
      speaker: { id: 'omar-haddad', name: 'Omar Haddad', title: 'Pastry cook' },
      activity: 'read',
      seed: 'A pastry cook using an amateur sketchbook to make marks that need no customer’s approval.',
      greeting: `No, this isn't a pastry order. Just my sketchbook. I come to the Wave Organ after an early shift. It's a relief to be near something bubbling that I don't have to take off the heat.`,
      returnGreeting: `Hello again. I've turned to a clean page, but there's no hurry to fill it. Nice to see a familiar face out here. I can give my pencil a rest.`,
      everyday: {
        question: "Early start?",
        text: `Very. By the time most people decide whether they deserve a croissant, I've had a lengthy disagreement with two hundred of them. I like the work. I also like this part, when nothing here needs glazing.`,
      },
      reflection: {
        question: "What are those shapes?",
        text: `Squares for the low sounds, little slashes for the splashes. No system anybody else has to learn. Patti in our drawing group thought I'd drawn shelves. We had a laugh. At work a shape has to come out right; here I can enjoy making one nobody recognizes.`,
      },
      connection: {
        residentId: 'lena-ortiz',
        name: 'Lena Ortiz',
        place: 'the Golden Gate Bridge pedestrian approach',
        thread: 'roaming-sketchbook',
        question: "Who else sketches?",
        unheard: `Lena Ortiz from our drawing group sketches near the Golden Gate Bridge pedestrian approach. She's a bus dispatcher, so people actually standing still are a novelty. Her pages have a lot of unfinished coats. Ask her why she keeps those.`,
        heard: `Lena told you about letting people walk out of the drawing. I like those unfinished coats. At the bakery I finish every edge. Looking at her pages, I can still imagine somebody getting to wherever they were going.`,
      },
      farewell: `Have a good walk. I'll make a few more unidentifiable marks before going home. If they turn into shelves again, perhaps Patti will at least like the new arrangement.`,
    },
  ],
} satisfies StoryChapter;
