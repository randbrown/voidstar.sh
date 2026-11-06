// /voidstar-press-kit.zip — every press photo, logo, and art file from
// press.files, plus a README with bios, billing, credits, and contact. Built
// at `astro build` time from the same list /press renders, so the zip can't
// drift from the page.
import type { APIRoute } from 'astro';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { press } from '../data/press';
import { zipStore } from '../lib/qualia/zip.js';

function readme(): string {
  const { photos } = press.files;
  return [
    `${press.name} — press kit`,
    `also billed as: ${press.altBilling}`,
    '',
    press.oneLiner,
    '',
    'SHORT BIO',
    press.bios.short,
    '',
    'MEDIUM BIO',
    press.bios.medium,
    '',
    'LONG BIO',
    press.bios.long.join('\n\n'),
    '',
    'BILLING',
    ...press.billing.map(({ name, use }) => `- ${name}: ${use}`),
    'Always lowercase "voidstar", including in "Randy Brown\'s voidstar".',
    '',
    'PHOTO CREDITS',
    ...photos.map(({ file, credit }) => `- photos/${file}: ${credit || 'uncredited'}`),
    '',
    'Logos are white-on-transparent; use them on dark backgrounds.',
    '',
    'CONTACT',
    ...(press.contact.email ? [`- ${press.contact.email}`] : []),
    `- ${press.contact.instagram}`,
    '- https://voidstar.sh/press',
    '',
  ].join('\n');
}

export const GET: APIRoute = async () => {
  const { photos, logos, art } = press.files;
  const groups = [['photos', photos], ['logos', logos], ['art', art]] as const;
  const entries: { name: string; data: string | Uint8Array }[] = [{ name: 'README.txt', data: readme() }];
  for (const [dir, list] of groups) {
    for (const { path: p, file } of list) {
      // Repo-relative paths; `astro build` runs from the repo root.
      entries.push({ name: `${dir}/${file}`, data: await readFile(path.resolve(p)) });
    }
  }
  return new Response(zipStore(entries), {
    headers: { 'Content-Type': 'application/zip' },
  });
};
