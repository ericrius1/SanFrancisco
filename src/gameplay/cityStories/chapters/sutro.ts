import type { StoryChapter } from '../types';

export default {
  id: 'sutro',
  revision: 1,
  residents: [
    {
      id: 'walter-foster',
      speaker: { id: 'walter-foster', name: 'Walter Foster', title: 'Retired piano tuner' },
      activity: 'watch',
      seed: 'A retired piano tuner, happily married late in life and protective of ordinary independence.',
      greeting: `Walter. I come to Sutro Baths to look at the water, then spend half the time examining concrete. Occupational curiosity, I suppose. Forty years checking what holds a piano together does something to a man.`,
      returnGreeting: `Hello again. I've no particular destination beyond this bit of looking. You're welcome to keep me company. I won't ask you to identify a note or guess how old a piano is.`,
      everyday: {
        question: "Miss tuning pianos?",
        text: `Some of them. One upright used to contain a different sandwich every visit. The child responsible grew up to be an accountant. I still play keys for Ada's band. Farah's workroom has fewer sandwiches inside the instruments, so far.`,
      },
      reflection: {
        question: "How's life with Nell?",
        text: `We married at sixty-eight. I thought good husbands shared every interest, so I endured her weather broadcast and she endured my sports. We were miserable before breakfast. Now we have two little radios in separate rooms. Then we meet for toast, with actual things to tell each other.`,
      },
      connection: {
        residentId: 'mika-chen',
        name: 'Mika Chen',
        place: 'the Golden Gate Park skate plaza',
        thread: 'workroom-band',
        question: "Who's new in the band?",
        unheard: `Mika Chen, our clarinet player, spends time at the Golden Gate Park skate plaza. They work at a grocery and skate between shifts. Ask about the single note Ada had them hold. I heard it from the keyboard.`,
        heard: `You know what that held note meant to Mika. From where I sat, it was simply a lovely sound taking its time. You can't always tell how much effort somebody has put into staying with one small thing.`,
      },
      farewell: `I'll stay a little longer. Nell and I don't account for every minute of each other's walks. Saves a tremendous amount of paperwork. Good to have had your company.`,
    },
    {
      id: 'finn-price',
      speaker: { id: 'finn-price', name: 'Finn Price', title: 'Geology student' },
      activity: 'read',
      seed: 'A community college geology student discovering an adult friendship with his grandmother through drawing.',
      greeting: `I'm drawing the rocks, badly, and labeling them, cautiously. Sutro Baths is a good place to remember those are separate skills. You can look. Just don't submit this to my instructor.`,
      returnGreeting: `Hey, welcome back. I can stop squinting for a minute. My drawing's still here, and the rocks have shown very little interest in escaping while we talk, which is considerate.`,
      everyday: {
        question: "Fieldwork for class?",
        text: `Mostly for me. Community college during the week; sometimes I join Gran's sketch group. They bring better snacks than my classmates. I've learned to carry a pencil sharpener, because eight adults can collectively remember cheese and forget equipment.`,
      },
      reflection: {
        question: "Like drawing with your gran?",
        text: `Gran asked which way the rock layers ran in her drawing. I started doing my little-kid voice: "I think maybe..." Then I actually explained. She crossed out her lines and kept mine. It's the first time I remember teaching her something without everybody making a fuss about me growing up.`,
      },
      connection: {
        residentId: 'sol-rivera',
        name: 'Sol Rivera',
        place: 'Ocean Beach',
        thread: 'roaming-sketchbook',
        question: "Who brings the snacks?",
        unheard: `We take turns, though Sol Rivera usually brings the good crackers. They're a dog walker who sketches at Ocean Beach. Someone offered to sell their drawings once. You should hear Sol's answer; it improved our group's snack breaks considerably.`,
        heard: `Sol told you why they keep drawing off the clock. After that, our group stopped asking what a sketch could become. Sometimes it's just what Sol made while eating crackers. I like having one place where nobody needs to be building a portfolio.`,
      },
      farewell: `See you around. I'll finish these labels before I forget what I meant. A rock called "probably this one" is fine in a sketchbook, less useful on an exam.`,
    },
  ],
} satisfies StoryChapter;
