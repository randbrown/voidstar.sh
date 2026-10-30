// Press kit (EPK) content for /press. Everything a promoter, venue, or writer
// might lift lives here so the page stays a pure layout — edit copy, links,
// and the rider in this file, not in src/pages/press.astro.
//
// Bios are written pronoun-free on purpose so they can be pasted anywhere
// as-is; keep new copy that way unless you want to pick one.
//
// Optional fields render only when set: an empty `email`, `shows`, or `quotes`
// simply hides its block instead of shipping a placeholder.
//
// Press photos live in src/assets/press/ and are listed in press.astro (they're
// imported assets); captions and credits sit next to the imports there.

export const press = {
  name: 'voidstar',
  // The personal-name billing, for listings where Randy's name carries the draw.
  altBilling: "Randy Brown's voidstar",
  artist: 'Randy Brown',
  tagline: 'ambient steel guitar from the event horizon',

  oneLiner:
    'Ambient, improvised pedal steel run through live code, with audio-reactive visuals built for the room.',

  bios: {
    short:
      "voidstar is Knoxville pedal-steel player and software engineer Randy Brown: ambient, improvised music where the steel guitar runs through live code, and the visuals are played as an instrument too.",

    medium:
      "voidstar is the ambient / live-code project of Knoxville musician and software engineer Randy Brown. A set starts with pedal steel — long swells, bends, and drones — routed through a live-coded system: Strudel patterns, loops grabbed on the fly, and a neural amp model, all running in a browser. The visuals are played too. qualia, the open-source instrument Brown built for these sets, turns the sound, the performer's body, and the room into light, and the audience can join in from their phones by scanning a QR code. The music moves from stillness to eruption and back.",

    long: [
      "voidstar is the ambient / live-code project of Knoxville, Tennessee musician and software engineer Randy Brown. The name is a C programmer's joke — void*, a pointer to untyped memory: potential without form. That's where every set starts.",
      "At the center is the pedal steel: long swells, slow bends, and drones that sit somewhere between country-church sustain and deep-space ambient. The steel runs through a live-coded system — Strudel patterns, a multi-track looper that grabs phrases on the fly, a neural amp model, and vocal processing — so the arrangement is written, rewritten, and erased in real time.",
      "The visuals aren't a backdrop. qualia, the browser-based instrument Brown built for these sets, reads the audio, tracks the performer's movement, and renders it all as light — black holes, stained-glass fields, phosphor code. Audience members can scan a QR code and fold their own movement into the picture. The performer stays in control; the room gets a vote.",
      "voidstar grew out of Knoxville's experimental and improvised-music scene, and sometimes plays as a father/son duo with Cade Brown. Off the voidstar stage, Brown plays pedal steel in nightjar, is in the metal band Dysmorphic Demiurge, and releases solo music as randbrown. Everything voidstar uses on stage is open source and opens in a browser tab at voidstar.sh.",
    ],
  },

  facts: [
    { k: 'project',   v: 'voidstar' },
    { k: 'billed as', v: "voidstar · Randy Brown's voidstar" },
    { k: 'artist',    v: 'Randy Brown' },
    { k: 'from',      v: 'Knoxville, Tennessee' },
    { k: 'sound',     v: 'ambient · live code · pedal steel · improvised' },
    { k: 'on stage',  v: 'pedal steel, live-coded laptop rig, projected audio-reactive visuals' },
    { k: 'formats',   v: 'solo · father/son duo with Cade Brown' },
    { k: 'visuals',   v: 'self-contained — brings a projector if needed; just add a screen' },
  ],

  // How to print the name. Lowercase "voidstar" everywhere, including in the
  // possessive form.
  billing: [
    {
      name: 'voidstar',
      use: 'The default. Experimental, electronic, and ambient bills; anywhere the project is the draw.',
    },
    {
      name: "Randy Brown's voidstar",
      use: 'When the personal name carries weight — listings for audiences who know Randy from bands and steel work, local press, posters.',
    },
    {
      name: 'Randy Brown (pedal steel)',
      use: 'Band, session, and sit-in credits outside voidstar.',
    },
  ],

  links: [
    { label: 'YouTube',    handle: '@voidstar0_0',  href: 'https://youtube.com/@voidstar0_0',  desc: 'live sets & art videos' },
    { label: 'Instagram',  handle: '@voidstar0',    href: 'https://instagram.com/voidstar0',   desc: 'clips & behind the scenes' },
    { label: 'Spotify',    handle: 'randbrown',     href: 'https://open.spotify.com/artist/3EmqGxyni2sorqbKgw2fTm', desc: "Randy Brown's catalog" },
    { label: 'SoundCloud', handle: 'randbrown',     href: 'https://soundcloud.com/randbrown',  desc: 'demos & solo tracks' },
    { label: 'GitHub',     handle: '@randbrown',    href: 'https://github.com/randbrown',      desc: 'the instrument, open source' },
    { label: 'Website',    handle: 'randbrown.com', href: 'https://randbrown.com/press/',      desc: "Randy Brown's press kit" },
  ],

  // What a set is, in three beats.
  show: [
    {
      mark: '∿',
      title: 'pedal steel',
      body: 'Swells, bends, and drones — the human, bending counterpoint to the code. Played live, looped live, never on a backing track.',
    },
    {
      mark: '{}',
      title: 'live code',
      body: 'Strudel patterns written and rewritten during the set; the code is projected, so the audience can watch the music get typed.',
    },
    {
      mark: '◈',
      title: 'qualia visuals',
      body: 'Audio-reactive, pose-tracked visuals from a browser instrument. Optional: the crowd joins from their phones via QR code.',
    },
  ],

  // Typical needs; confirm per show.
  rider: {
    brings: [
      'pedal steel guitar',
      'laptop running the full rig (Strudel, looper, amp modeling, visuals)',
      'audio interface + MIDI controller',
      'cables to a stereo line-level output',
      'a projector, if the venue doesn\'t have one',
    ],
    needs: [
      '2 inputs on the house mix — stereo L/R, line level (XLR or ¼″), or 2 DIs',
      '1 grounded power drop at the performance position',
      'a screen to project on (or the house projector + screen, with an HDMI input) — the visuals are half the show',
      'about 20 min to set up + a short line check',
    ],
  },

  // Fill these as they come in; empty arrays hide their sections.
  shows: [] as { date: string; venue: string; city?: string; note?: string }[],
  quotes: [] as { text: string; source: string; href?: string }[],

  contact: {
    email: 'booking@voidstar.sh', // forwards via email routing; empty falls back to Instagram DM
    instagram: 'https://instagram.com/voidstar0',
    site: 'https://randbrown.com/press/',
  },
};
