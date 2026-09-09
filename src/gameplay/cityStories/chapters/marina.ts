import type { StoryChapter } from '../types';

export default {
  id: 'marina',
  revision: 1,
  residents: [
    {
      id: 'gus-bennett',
      speaker: { id: 'gus-bennett', name: 'Gus Bennett', title: 'Retired bus driver' },
      activity: 'stretch',
      seed: 'A retired bus driver and beginner drummer practicing restraint with cheerful difficulty.',
      greeting: `Just loosening up my wrists. Drums, nothing competitive. Though if Marina Green introduces a league for men who drop drumsticks into their own cuffs, I'd like to be considered for captain.`,
      returnGreeting: `Hello again. You've caught me between sets of pretending this stretch is doing anything. Plenty of air to share out here. I haven't managed to use it all up yet.`,
      everyday: {
        question: "Why take up drums?",
        text: `Forty years driving a bus, listening to something rattle behind me. I thought, here's an instrument I'm already qualified for. Our band rehearses in Farah's workroom. She keeps the good scissors well away from my enthusiasm.`,
      },
      reflection: {
        question: "What's the hard part?",
        text: `The rests. Four bars where I don't hit anything, yet apparently I'm still playing. I used to fill them. Ada finally had me count on my fingers under the chair. Then Farah's trumpet came through, small and clear. Oh, I thought. That's what I was covering up.`,
      },
      connection: {
        residentId: 'theo-bennett',
        name: 'Theo Bennett',
        place: 'the Golden Gate Bridge pedestrian approach',
        thread: 'workroom-band',
        question: "Family in the band?",
        unheard: `My son Theo Bennett plays bass with us. He walks near the Golden Gate Bridge pedestrian approach when his figures need airing out. Does taxes for a living. He has an excellent story about learning not to supervise his father.`,
        heard: `Theo told you about putting his bass away and listening to me practice? I'd noticed. He used to come over with a whole lesson prepared. Now he asks what I'm working on. Much easier to admit I haven't cracked it.`,
      },
      farewell: `Take care. I'll be here counting silently, which several people have encouraged as a promising new direction for me. Don't let the innocent expression of that wind fool you.`,
    },
    {
      id: 'patti-dunn',
      speaker: { id: 'patti-dunn', name: 'Patti Dunn', title: 'Former salon owner' },
      activity: 'read',
      seed: 'A former hairdresser enjoying being an unaccomplished member of a wandering drawing group.',
      greeting: `Don't worry, I'm drawing the grass. People get nervous around sketchbooks. Marina Green holds still reasonably well, and it hasn't yet asked me to make its chin a little more decisive.`,
      returnGreeting: `Well, hello again. Same sketchbook, fresh page. You're welcome to linger. I'm taking a break from green, which turns out to be several different colors conspiring under one name.`,
      everyday: {
        question: "What do you like drawing?",
        text: `Dogs from behind. You get the ears, you get the attitude, and nobody asks about the eyes. I ran a salon for years; I can read an entire social situation from the back of a head.`,
      },
      reflection: {
        question: "Always been an artist?",
        text: `Not at all. At the salon I was always the person who knew what to do. I joined our roaming sketch group and drew a face with three eyebrows. Nobody needed me to rescue it. We laughed, I turned the page, and I came back the next week.`,
      },
      connection: {
        residentId: 'omar-haddad',
        name: 'Omar Haddad',
        place: 'the Wave Organ',
        thread: 'roaming-sketchbook',
        question: "Who draws with you?",
        unheard: `Omar Haddad, a pastry cook, takes his sketchbook out to the Wave Organ. He's in our roaming group. He draws what he hears sometimes. I initially thought one page was shelving. He was wonderfully polite about that.`,
        heard: `You've heard about Omar's squares for the low notes. That was my imaginary shelving. Now when we compare pages, I ask which part he liked making. Gives us much more to talk about than whether I guessed correctly.`,
      },
      farewell: `Lovely seeing you. I'll tackle another dog, on paper. In person I ask permission first; thirty years of washing strangers' hair taught me something about personal boundaries.`,
    },
  ],
} satisfies StoryChapter;
