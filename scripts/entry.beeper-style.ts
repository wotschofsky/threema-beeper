import {readFile, writeFile} from 'node:fs/promises';
const [iconId, output] = process.argv.slice(2);
if (!iconId || !/^[A-Za-z0-9_-]+$/.test(iconId) || !output)
    throw Error('Usage: node scripts/entry.beeper-style.ts <icon-media-id> <new-css-output>');
const image = (await readFile(new URL('../assets/threema-icon.png', import.meta.url))).toString(
    'base64',
);
const css = `/* Threema bridge: local Beeper Desktop appearance. */
.sidebar-button .participant-img.brand-combined-icon[src*="${iconId}"] {
  border-radius: 28% !important;
  clip-path: none !important;
}
[data-platform="sh-threema"] .brand-combined-icon {
  background: #000 url("data:image/png;base64,${image}") center / cover no-repeat !important;
  border-radius: 28% !important;
  overflow: hidden;
}
[data-platform="sh-threema"] .brand-combined-icon > * { visibility: hidden !important; }
`;
await writeFile(output, css, {flag: 'wx', mode: 0o600});
console.log('Local Beeper CSS generated. Append to custom.css and use Reload custom CSS.');
