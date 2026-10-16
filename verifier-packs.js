// Vérifie les packs : le jeu doit tourner (start.bat). Écrit verification.txt.
// Usage :  node verifier-packs.js            (tous les packs)   ou   node verifier-packs.js rap-fr
const fs = require('fs');
(async () => {
  const pack = process.argv[2] ? '?pack=' + encodeURIComponent(process.argv[2]) : '';
  const out = fs.createWriteStream('verification.txt');
  let r;
  try { r = await fetch('http://localhost:' + (process.env.PORT || 3000) + '/api/verify' + pack); }
  catch (_) { console.log('Le jeu ne tourne pas : lance d\'abord start.bat, puis relance ce script.'); return; }
  const dec = new TextDecoder();
  for await (const chunk of r.body) { const t = dec.decode(chunk, { stream: true }); process.stdout.write(t); out.write(t); }
  out.end();
})();
