export interface Video {
  id: string;       // YouTube video ID
  title: string;
  description: string;
  date: string;     // ISO date string
  tags: string[];
  featured?: boolean;
}

// Replace these IDs with your actual YouTube video IDs.
// The YouTube thumbnail API will auto-fetch the thumbnails.
export const videos: Video[] = [
  {
    id: 'dQw4w9WgXcQ',   // placeholder — replace with real ID
    title: 'Particle Storm — generative art live set',
    description: 'Real-time particle system reacting to a live audio mix. 10,000 particles driven by FFT amplitude and curl noise.',
    date: '2026-03-15',
    tags: ['particles', 'audio-reactive', 'live'],
    featured: true,
  },
  {
    id: 'ScMzIvxBSi4',   // placeholder
    title: 'Pose Field — body tracking visual',
    description: 'MediaPipe pose landmarks used as attractor points for a flowing particle field.',
    date: '2026-02-10',
    tags: ['pose-tracking', 'particles', 'canvas'],
  },
  {
    id: 'M7lc1UVf-VE',   // placeholder
    title: 'Void Drift — ambient music video',
    description: 'Original ambient track with procedurally generated visuals built in p5.js.',
    date: '2026-01-05',
    tags: ['music', 'generative', 'ambient'],
  },
  {
    id: 'aqz-KE-bpKQ',   // placeholder
    title: 'WebGL Fluid Simulation',
    description: 'Real-time fluid dynamics on the GPU — mouse interaction, dye injection, vorticity.',
    date: '2025-11-20',
    tags: ['webgl', 'simulation', 'fluid'],
  },
];
