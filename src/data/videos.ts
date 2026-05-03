// Source list of videos. Titles are fetched from YouTube's oEmbed API at
// build time (see enrichWithOEmbed) so we don't have to maintain them by
// hand — each entry just needs the video ID. Fields can still be set
// manually to override the auto-fetched value.

export interface Video {
  id: string;            // YouTube video ID
  title?: string;        // Auto-filled from oEmbed if omitted
  description?: string;
  date?: string;         // ISO date — oEmbed doesn't expose this
  tags?: string[];
  featured?: boolean;
}

export const videos: Video[] = [
  { id: 'pT8RKd9t640', featured: true },
  { id: 'dJGqTtVfE1g' },
  { id: '0-Xok46-Ss8' },
  { id: 'BtlHRhC7rDc' },
  { id: 'ZAIScVFdpHc' },
  { id: 'kX_IneF63Rc' },
  { id: 'r_y16hcMZQo' },
  { id: 'oX5vTJv0SYw' },
];

// Fetch titles from YouTube's oEmbed endpoint at build time. Public,
// keyless, returns JSON like { title, author_name, thumbnail_url, ... }.
// Failures fall back to a generic placeholder so the page still renders
// when offline (e.g. running `astro build` without network).
export async function enrichWithOEmbed(list: Video[]): Promise<Video[]> {
  return Promise.all(list.map(async v => {
    if (v.title) return v;
    try {
      const url = `https://www.youtube.com/oembed?url=https%3A//www.youtube.com/watch%3Fv%3D${v.id}&format=json`;
      const r   = await fetch(url);
      if (!r.ok) return { ...v, title: 'voidstar — untitled' };
      const j   = await r.json() as { title?: string };
      return { ...v, title: j.title || 'voidstar — untitled' };
    } catch {
      return { ...v, title: 'voidstar — untitled' };
    }
  }));
}
