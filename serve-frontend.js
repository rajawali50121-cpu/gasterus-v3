import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const ROOT = path.join(__dirname, 'frontend');

const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  
  // Strip query string for Windows file path lookup
  const cleanUrl = req.url.split('?')[0];
  let urlPath = cleanUrl === '/' ? '/index.html' : cleanUrl;
  const filePath = path.join(ROOT, urlPath);
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<h1>404 Not Found</h1><p>File tidak ditemukan.</p>');
      return;
    }
    
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║     GASTERUS V3 - Frontend Server                        ║
║                                                           ║
║     📍 http://localhost:${PORT}                          ║
║                                                           ║
║     Halaman yang tersedia:                                ║
║     • /index.html         - Beranda                       ║
║     • /login.html         - Login ✅ (BARU)               ║
║     • /register.html      - Daftar                        ║
║     • /member.html        - Dashboard Member             ║
║     • /market-play.html   - Pasang Taruhan Togel         ║
║     • /css/...            - Stylesheets                  ║
║     • /js/...             - JavaScript                   ║
║                                                           ║
║     ⚠️  CATATAN PENTING:                                 ║
║     Backend belum berjalan. Fitur ini hanya preview:     ║
║     • Login/taroohan TIDAK akan berfungsi                ║
║     • Saldo tidak akan terupdate                          ║
║                                                           ║
║     Untuk fitur lengkap, jalankan backend:               ║
║     cd backend && npm run dev:backend                    ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});