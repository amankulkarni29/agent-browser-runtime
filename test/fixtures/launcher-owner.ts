import { launchBrowser } from '../../src/core/browser-launcher.js';

await launchBrowser({ launchMode: 'virtual-display' });
process.stdout.write('launcher-ready\n');
setInterval(() => undefined, 1_000);
