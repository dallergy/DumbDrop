/**
 * Inline SVG glyphs for file types. Kept as strings so table rows stay light.
 */

const SVG = (paths) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICONS = {
  folder: SVG(
    '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'
  ),
  file: SVG(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>'
  ),
  image: SVG(
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>'
  ),
  video: SVG('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3Z"/>'),
  audio: SVG(
    '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'
  ),
  archive: SVG(
    '<path d="M10 12h4"/><path d="M10 6h4"/><path d="M6 2h12v20H6Z"/><path d="M12 2v20"/>'
  ),
  code: SVG('<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>'),
  text: SVG(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/>'
  ),
};

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.heic']);
const VIDEO = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const AUDIO = new Set(['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a']);
const ARCHIVE = new Set(['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar']);
const CODE = new Set([
  '.js',
  '.ts',
  '.json',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.css',
  '.html',
  '.sh',
]);
const TEXT = new Set(['.txt', '.md', '.pdf', '.csv', '.doc', '.docx', '.rtf']);

export function fileGlyph(item) {
  if (item.type === 'directory') return ICONS.folder;
  const ext = (item.extension || item.name.slice(item.name.lastIndexOf('.'))).toLowerCase();
  if (IMAGE.has(ext)) return ICONS.image;
  if (VIDEO.has(ext)) return ICONS.video;
  if (AUDIO.has(ext)) return ICONS.audio;
  if (ARCHIVE.has(ext)) return ICONS.archive;
  if (CODE.has(ext)) return ICONS.code;
  if (TEXT.has(ext)) return ICONS.text;
  return ICONS.file;
}

export { ICONS };
